//! App Jarvis: sobe o núcleo (Python empacotado), abre o HUD e uma camada transparente por monitor,
//! e cuida do ícone na barra de menus/bandeja, do atalho ⌥/Alt+Espaço e de abrir com o computador.
//!
//! As janelas carregam as páginas do núcleo (http://127.0.0.1:8765). O núcleo é filho deste processo,
//! então no Mac as permissões (microfone, câmera, Acessibilidade, tela) ficam com o "Jarvis".

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const PORT: u16 = 8765;
static SAINDO: AtomicBool = AtomicBool::new(false);
/// HUD fora da tela: 1 = no canto (esfera pequena na camada), 2 = oculto (só o ícone na barra/bandeja)
static FORA: AtomicU8 = AtomicU8::new(2);

fn base() -> String {
    format!("http://127.0.0.1:{PORT}")
}

#[derive(Default)]
struct Core(Mutex<Option<Child>>);

#[derive(Clone, Copy, Deserialize, Debug)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// Áreas de cada camada que recebem o mouse (cartões, esfera do canto), em pontos globais.
#[derive(Default)]
struct Regioes(Mutex<HashMap<String, Vec<Rect>>>);

#[derive(Serialize, Clone)]
struct Bounds {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Serialize, Clone)]
struct HudEstado {
    modo: &'static str,
    focused: bool,
    bounds: Option<Bounds>,
}

// ---------- núcleo ----------

/// HTTP mínimo (sem dependências) para falar com o núcleo local.
fn http(metodo: &str, caminho: &str) -> Option<String> {
    http_t(metodo, caminho, 3)
}

fn http_t(metodo: &str, caminho: &str, segundos: u64) -> Option<String> {
    let mut s = TcpStream::connect(("127.0.0.1", PORT)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(segundos))).ok()?;
    let req = format!("{metodo} {caminho} HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\r\n");
    s.write_all(req.as_bytes()).ok()?;
    let mut out = String::new();
    s.read_to_string(&mut out).ok()?;
    if out.starts_with("HTTP/1.1 200") || out.starts_with("HTTP/1.0 200") {
        Some(out.split("\r\n\r\n").nth(1).unwrap_or("").to_string())
    } else {
        None
    }
}

fn core_exe(app: &AppHandle) -> Option<PathBuf> {
    let nome = if cfg!(windows) { "jarvis-core.exe" } else { "jarvis-core" };
    let dir = app.path().resource_dir().ok()?.join("core");
    let exe = dir.join(nome);
    exe.exists().then_some(exe)
}

fn start_core(app: &AppHandle) {
    // em desenvolvimento, o núcleo pode já estar rodando (uv run python -m jarvis.app)
    if http("GET", "/health").is_some() {
        return;
    }
    let Some(exe) = core_exe(app) else {
        eprintln!("núcleo não encontrado no pacote");
        return;
    };
    let home = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&home);
    // acrescenta (não apaga): se o núcleo cair e voltar, o motivo continua no registro
    let caminho_log = home.join("nucleo.log");
    if std::fs::metadata(&caminho_log).map(|m| m.len() > 5_000_000).unwrap_or(false) {
        let _ = std::fs::rename(&caminho_log, home.join("nucleo.anterior.log"));
    }
    let log = std::fs::OpenOptions::new().create(true).append(true).open(&caminho_log).ok();
    let mut cmd = Command::new(&exe);
    cmd.env("JARVIS_HOME", &home).env("JARVIS_PORT", PORT.to_string()).stdin(Stdio::null());
    if let Some(f) = log {
        if let Ok(f2) = f.try_clone() {
            cmd.stdout(f).stderr(f2);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // sem janela de console
    }
    match cmd.spawn() {
        Ok(child) => *app.state::<Core>().0.lock().unwrap() = Some(child),
        Err(e) => eprintln!("não consegui abrir o núcleo: {e}"),
    }
}

/// Se o núcleo cair (ou reiniciar para aplicar permissões), sobe de novo.
fn watch_core(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(2));
        if SAINDO.load(Ordering::SeqCst) {
            return;
        }
        let morto = {
            let st = app.state::<Core>();
            let mut g = st.0.lock().unwrap();
            match g.as_mut() {
                Some(c) => matches!(c.try_wait(), Ok(Some(_))),
                None => false,
            }
        };
        if morto && http("GET", "/health").is_none() {
            start_core(&app);
        }
    });
}

fn wait_core(timeout: Duration) -> bool {
    let fim = Instant::now() + timeout;
    while Instant::now() < fim {
        if http("GET", "/health").is_some() {
            return true;
        }
        thread::sleep(Duration::from_millis(300));
    }
    false
}

fn configurado() -> bool {
    http("GET", "/api/setup").map(|b| b.contains("\"configurado\":true") || b.contains("\"configurado\": true")).unwrap_or(false)
}

// ---------- janelas ----------

fn url(caminho: &str) -> WebviewUrl {
    WebviewUrl::External(format!("{}{}", base(), caminho).parse().expect("url"))
}

fn ler_estado(app: &AppHandle) -> HudEstado {
    let Some(w) = app.get_webview_window("hud") else {
        return HudEstado { modo: "oculto", focused: false, bounds: None };
    };
    let visivel = w.is_visible().unwrap_or(false);
    let min = w.is_minimized().unwrap_or(false);
    let modo = if visivel && !min {
        "visivel"
    } else if min || FORA.load(Ordering::SeqCst) == 1 {
        "minimizado"
    } else {
        "oculto"
    };
    let esc = w.scale_factor().unwrap_or(1.0);
    let bounds = match (w.outer_position(), w.outer_size()) {
        (Ok(p), Ok(s)) => Some(Bounds { x: p.x as f64 / esc, y: p.y as f64 / esc, w: s.width as f64 / esc, h: s.height as f64 / esc }),
        _ => None,
    };
    HudEstado { modo, focused: w.is_focused().unwrap_or(false), bounds }
}

fn emit_estado(app: &AppHandle) {
    let _ = app.emit("hud-estado", ler_estado(app));
}

fn criar_hud(app: &AppHandle, visivel: bool) -> tauri::Result<WebviewWindow> {
    let w = WebviewWindowBuilder::new(app, "hud", url("/?app=1"))
        .title("J.A.R.V.I.S.")
        .disable_drag_drop_handler() // extratos arrastados para o HUD chegam na página
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .visible(visivel)
        .build()?;
    let h = app.clone();
    w.on_window_event(move |ev| match ev {
        // fechar vai para o canto (esfera pequena): a voz, o ouvido e as mãos seguem ligados
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            ir_para_canto(&h);
        }
        WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::Focused(_) => emit_estado(&h),
        _ => {}
    });
    Ok(w)
}

/// Some com o HUD e deixa a esfera pequena no canto (a camada desenha). Sem minimizar de verdade:
/// no Mac o app não tem ícone no Dock, e a janela minimizada ficaria perdida.
fn ir_para_canto(app: &AppHandle) {
    FORA.store(1, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("hud") {
        let _ = w.hide();
    }
    emit_estado(app);
}

fn esconder_tudo(app: &AppHandle) {
    FORA.store(2, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("hud") {
        let _ = w.hide();
    }
    emit_estado(app);
}

fn mostrar_hud(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("hud") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    emit_estado(app);
}

fn alternar_hud(app: &AppHandle) {
    let e = ler_estado(app);
    if e.modo == "visivel" && e.focused {
        ir_para_canto(app);
    } else {
        mostrar_hud(app);
    }
}

/// Uma camada transparente por monitor: cartões, mãos e a esfera que voa. Deixa o clique passar.
fn criar_camadas(app: &AppHandle) {
    let monitores = app.available_monitors().unwrap_or_default();
    let principal = app.primary_monitor().ok().flatten();
    for (i, m) in monitores.iter().enumerate() {
        let esc = m.scale_factor();
        let (x, y) = (m.position().x as f64 / esc, m.position().y as f64 / esc);
        let (w, h) = (m.size().width as f64 / esc, m.size().height as f64 / esc);
        let main = principal.as_ref().map(|p| p.position() == m.position()).unwrap_or(i == 0);
        let label = format!("camada-{i}");
        if app.get_webview_window(&label).is_some() {
            continue;
        }
        let caminho = format!("/overlay?x={x}&y={y}&w={w}&h={h}&main={}", if main { 1 } else { 0 });
        let res = WebviewWindowBuilder::new(app, &label, url(&caminho))
            .title("J.A.R.V.I.S.")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .focusable(false)
            .visible_on_all_workspaces(true)
            .position(x, y)
            .inner_size(w, h)
            .build();
        if let Ok(win) = res {
            let _ = win.set_ignore_cursor_events(true);
        }
    }
}

/// O mouse só é capturado pela camada em cima dos cartões e da esfera; o resto vai para os apps.
fn vigiar_mouse(app: AppHandle) {
    thread::spawn(move || {
        let mut antes: HashMap<String, bool> = HashMap::new();
        loop {
            thread::sleep(Duration::from_millis(40));
            if SAINDO.load(Ordering::SeqCst) {
                return;
            }
            let Ok(cur) = app.cursor_position() else { continue };
            let regioes = app.state::<Regioes>().0.lock().unwrap().clone();
            for (label, rects) in regioes.iter() {
                let Some(w) = app.get_webview_window(label) else { continue };
                let esc = w.scale_factor().unwrap_or(1.0);
                let (cx, cy) = (cur.x / esc, cur.y / esc);
                let dentro = rects.iter().any(|r| cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
                if antes.get(label) != Some(&dentro) {
                    let _ = w.set_ignore_cursor_events(!dentro);
                    antes.insert(label.clone(), dentro);
                }
            }
        }
    });
}

fn abrir_painel(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("painel") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "painel", url("/admin")).title("Jarvis · Painel").inner_size(1360.0, 880.0).center().build();
}

/// Mapa da memória (estilo Obsidian) numa janela própria; com foco, destaca o tema pedido.
fn abrir_memoria(app: &AppHandle, foco: String) {
    let foco: String = foco.chars().filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-').collect();
    let caminho = format!("/memoria?foco={}", foco.replace(' ', "%20"));
    if let Some(w) = app.get_webview_window("memoria") {
        let _ = w.eval(&format!("window.jarvisFoco && window.jarvisFoco({foco:?})"));
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "memoria", url(&caminho))
        .title("Jarvis · Memória")
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .center()
        .build();
}

/// Financeiro (as telas da Carteira, servidas pelo núcleo em /financeiro/) numa janela própria, na página pedida.
fn abrir_financeiro(app: &AppHandle, pagina: String) {
    let pagina: String = pagina.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if let Some(w) = app.get_webview_window("financeiro") {
        if !pagina.is_empty() {
            let _ = w.eval(&format!("window.jarvisNavegar && window.jarvisNavegar({pagina:?})"));
        }
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let criada = WebviewWindowBuilder::new(app, "financeiro", url("/financeiro/"))
        .title("Jarvis · Financeiro")
        .inner_size(1380.0, 880.0)
        .min_inner_size(820.0, 560.0)
        .center()
        .disable_drag_drop_handler() // extratos arrastados chegam na página (HTML), não no app
        .build();
    if let (Ok(w), false) = (criada, pagina.is_empty() || pagina == "dashboard") {
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(2500)); // a página termina de carregar
            let _ = w.eval(&format!("window.jarvisNavegar && window.jarvisNavegar({pagina:?})"));
        });
    }
}

/// Pedidos do núcleo (chamado por "Jarvis", "vai para o canto", "mostre minha memória"). Espera no próprio
/// núcleo (até 20 s por vez), então vale mesmo com todas as janelas escondidas.
fn ouvir_nucleo(app: AppHandle) {
    thread::spawn(move || loop {
        if SAINDO.load(Ordering::SeqCst) {
            return;
        }
        let Some(corpo) = http_t("GET", "/api/app/comandos", 30) else {
            thread::sleep(Duration::from_secs(2));
            continue;
        };
        let Ok(lista) = serde_json::from_str::<Vec<serde_json::Value>>(&corpo) else { continue };
        for c in lista {
            let acao = c.get("acao").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let foco = c.get("foco").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let pagina = c.get("pagina").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let h = app.clone();
            let _ = app.run_on_main_thread(move || match acao.as_str() {
                "mostrar" => mostrar_hud(&h),
                "minimizar" => ir_para_canto(&h),
                "esconder" => esconder_tudo(&h),
                // pelo gesto o HUD nunca está em foco (o foco fica no app de baixo): vale só se está à vista
                "alternar" => {
                    if ler_estado(&h).modo == "visivel" {
                        ir_para_canto(&h)
                    } else {
                        mostrar_hud(&h)
                    }
                }
                "configuracao" => abrir_configuracao(&h),
                "memoria" => abrir_memoria(&h, foco),
                "financeiro" => abrir_financeiro(&h, pagina),
                _ => {}
            });
        }
    });
}

fn abrir_configuracao(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("setup") {
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "setup", url("/setup"))
        .title("Jarvis · Configuração")
        .inner_size(680.0, 760.0)
        .resizable(false)
        .center()
        .build();
}

// ---------- comandos chamados pelas páginas ----------

#[tauri::command]
fn hud_mostrar(app: AppHandle) {
    mostrar_hud(&app);
}

#[tauri::command]
fn hud_minimizar(app: AppHandle) {
    ir_para_canto(&app);
}

#[tauri::command]
fn hud_esconder(app: AppHandle) {
    esconder_tudo(&app);
}

#[tauri::command]
fn financeiro_abrir(app: AppHandle, pagina: Option<String>) {
    abrir_financeiro(&app, pagina.unwrap_or_default());
}

#[tauri::command]
fn memoria_abrir(app: AppHandle, foco: Option<String>) {
    abrir_memoria(&app, foco.unwrap_or_default());
}

#[tauri::command]
fn hud_estado(app: AppHandle) -> HudEstado {
    ler_estado(&app)
}

#[tauri::command]
fn painel_abrir(app: AppHandle) {
    abrir_painel(&app);
}

#[tauri::command]
fn configuracao_pronta(app: AppHandle) {
    if let Some(w) = app.get_webview_window("setup") {
        let _ = w.close();
    }
    if let Some(w) = app.get_webview_window("hud") {
        let _ = w.eval("location.reload()");
    }
    mostrar_hud(&app);
}

#[tauri::command]
fn regioes(window: tauri::Window, app: AppHandle, rects: Vec<Rect>) {
    app.state::<Regioes>().0.lock().unwrap().insert(window.label().to_string(), rects);
}

// ---------- bandeja / barra de menus ----------

fn montar_bandeja(app: &AppHandle) -> tauri::Result<()> {
    let mostrar = MenuItem::with_id(app, "mostrar", "Mostrar o Jarvis", true, Some("Alt+Space"))?;
    let canto = MenuItem::with_id(app, "canto", "Ficar no canto", true, None::<&str>)?;
    let memoria = MenuItem::with_id(app, "memoria", "Memória", true, None::<&str>)?;
    let financeiro = MenuItem::with_id(app, "financeiro", "Financeiro", true, None::<&str>)?;
    let painel = MenuItem::with_id(app, "painel", "Painel", true, None::<&str>)?;
    let inicio = CheckMenuItem::with_id(app, "inicio", "Abrir com o computador", true, inicio_ligado(app), None::<&str>)?;
    let config = MenuItem::with_id(app, "config", "Configuração inicial…", true, None::<&str>)?;
    let sair = MenuItem::with_id(app, "sair", "Sair do Jarvis", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&mostrar, &canto, &sep, &financeiro, &memoria, &painel, &config, &inicio, &sep2, &sair])?;
    TrayIconBuilder::with_id("jarvis")
        .icon(app.default_window_icon().cloned().expect("ícone"))
        .tooltip("Jarvis")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, ev| match ev.id().as_ref() {
            "mostrar" => mostrar_hud(app),
            "canto" => ir_para_canto(app),
            "memoria" => abrir_memoria(app, String::new()),
            "financeiro" => abrir_financeiro(app, String::new()),
            "inicio" => {
                let ligar = !inicio_ligado(app);
                definir_inicio(app, ligar);
                let _ = inicio.set_checked(ligar);
            }
            "painel" => abrir_painel(app),
            "config" => abrir_configuracao(app),
            "sair" => sair_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                alternar_hud(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn sair_app(app: &AppHandle) {
    SAINDO.store(true, Ordering::SeqCst);
    if let Some(mut c) = app.state::<Core>().0.lock().unwrap().take() {
        let _ = c.kill();
    }
    app.exit(0);
}

// ---------- início ----------

fn marca_sem_inicio(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(".sem-iniciar-com-o-computador"))
}

fn inicio_ligado(app: &AppHandle) -> bool {
    marca_sem_inicio(app).map(|m| !m.exists()).unwrap_or(true)
}

/// Liga ou desliga abrir com o computador. Ligado, o registro é refeito a cada abertura, apontando para onde o
/// app está agora (se ele for movido de pasta, o início automático continua achando).
fn definir_inicio(app: &AppHandle, ligar: bool) {
    let Some(m) = marca_sem_inicio(app) else { return };
    let _ = std::fs::create_dir_all(m.parent().unwrap());
    if ligar {
        let _ = std::fs::remove_file(&m);
        let _ = app.autolaunch().disable();
        let _ = app.autolaunch().enable();
    } else {
        let _ = std::fs::write(&m, "1");
        let _ = app.autolaunch().disable();
    }
}

/// Mac: aberto direto do zip (Downloads, Mesa), o sistema roda o app numa pasta temporária ("App
/// Translocation"): o início automático aponta para um lugar que some e as permissões não ficam. Então o
/// Jarvis se copia para Aplicativos, tira a marca de "baixado da internet" e reabre de lá.
#[cfg(target_os = "macos")]
fn ir_para_aplicativos() -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    let s = exe.to_string_lossy().to_string();
    if s.starts_with("/Applications/") || s.contains("/target/") {
        return false;
    }
    let Some(pos) = s.find(".app/") else { return false };
    let origem = &s[..pos + 4];
    let destino = "/Applications/Jarvis.app";
    let novo = "/Applications/.Jarvis-novo.app";
    let _ = std::fs::remove_dir_all(novo);
    let ok = Command::new("/usr/bin/ditto").args([origem, novo]).status().map(|st| st.success()).unwrap_or(false);
    if !ok {
        return false;
    }
    let _ = Command::new("/usr/bin/xattr").args(["-dr", "com.apple.quarantine", novo]).status();
    let _ = std::fs::remove_dir_all(destino);
    if std::fs::rename(novo, destino).is_err() {
        return false;
    }
    Command::new("/usr/bin/open").args(["-n", destino]).spawn().is_ok()
}

/// Aberto logo depois de entrar no computador (por qualquer item de login)? Então fica escondido.
fn login_recente() -> bool {
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("/bin/sh").args(["-c", "ps -o etimes= -p $(pgrep -x loginwindow | head -1)"]).output();
        if let Ok(o) = out {
            if let Ok(seg) = String::from_utf8_lossy(&o.stdout).trim().parse::<u64>() {
                return seg < 180;
            }
        }
    }
    false
}

pub fn run() {
    let escondido = std::env::args().any(|a| a == "--escondido") || login_recente();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // segunda abertura pelo login: ignora; aberta à mão: mostra o HUD
            if !args.iter().any(|a| a == "--escondido") && !login_recente() {
                mostrar_hud(app)
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--escondido"])))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _sc, ev| {
                    if ev.state() == ShortcutState::Pressed {
                        alternar_hud(app);
                    }
                })
                .build(),
        )
        .manage(Core::default())
        .manage(Regioes::default())
        .invoke_handler(tauri::generate_handler![
            hud_mostrar,
            hud_minimizar,
            hud_esconder,
            hud_estado,
            painel_abrir,
            configuracao_pronta,
            regioes,
            memoria_abrir,
            financeiro_abrir
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory); // só o ícone na barra de menus

            let h = app.handle().clone();
            #[cfg(target_os = "macos")]
            if ir_para_aplicativos() {
                std::process::exit(0);
            }
            // abre junto com o computador (escondido, só o ícone), a menos que tenham desligado no menu
            if inicio_ligado(&h) {
                definir_inicio(&h, true);
            }
            let _ = h.global_shortcut().register(Shortcut::new(Some(Modifiers::ALT), Code::Space));
            montar_bandeja(&h)?;

            // janelinha "Iniciando o Jarvis…" enquanto o núcleo sobe (na primeira vez o sistema inspeciona
            // o pacote e pode levar mais de um minuto); não aparece quando abre escondido no login
            if !escondido {
                let _ = WebviewWindowBuilder::new(&h, "inicio", WebviewUrl::App("index.html".into()))
                    .title("Jarvis")
                    .inner_size(420.0, 180.0)
                    .resizable(false)
                    .decorations(false)
                    .always_on_top(true)
                    .center()
                    .build();
            }
            start_core(&h);
            watch_core(h.clone());
            thread::spawn(move || {
                let ok = wait_core(Duration::from_secs(600));
                let h2 = h.clone();
                let _ = h.run_on_main_thread(move || {
                    if let Some(w) = h2.get_webview_window("inicio") {
                        let _ = w.close();
                    }
                    let pronto = ok && configurado();
                    let _ = criar_hud(&h2, pronto && !escondido);
                    criar_camadas(&h2);
                    if !pronto {
                        abrir_configuracao(&h2);
                    }
                    vigiar_mouse(h2.clone());
                    ouvir_nucleo(h2.clone());
                    emit_estado(&h2);
                });
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o Jarvis")
        .run(|app, ev| match ev {
            // fechar a última janela não encerra: só "Sair do Jarvis" (code definido)
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() && !SAINDO.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
            tauri::RunEvent::Exit => {
                if let Some(mut c) = app.state::<Core>().0.lock().unwrap().take() {
                    let _ = c.kill();
                }
            }
            _ => {}
        });
}
