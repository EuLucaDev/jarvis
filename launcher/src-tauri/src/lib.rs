//! Jarvis Launcher: entra com a conta do site, instala o Jarvis e aplica as atualizações baixando só o que mudou.
//!
//! - Conta: e-mail e senha viram um acesso só deste computador (guardado na pasta do launcher, legível só pelo
//!   usuário). O mesmo acesso vai para o Jarvis (nuvem-launcher.json), que já nasce ligado à nuvem da conta.
//! - Instalar/atualizar: baixa o manifesto da versão (cada arquivo com o sha256), monta a versão nova numa pasta
//!   ao lado (arquivos iguais aos atuais são ligados, não baixados; os outros vêm da loja e são conferidos pelo
//!   hash), fecha o Jarvis, troca as pastas de uma vez e abre de novo. Se algo falhar, o Jarvis atual fica intacto.
//! - Onde fica o Jarvis: /Applications/Jarvis.app (Mac), %LOCALAPPDATA%\Jarvis (Windows), ~/.local/share/jarvis-app
//!   (Linux, com atalho no menu).
//! - O próprio launcher se atualiza do mesmo jeito (produto "launcher").

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const SITE: &str = "https://jarvis.agcunae.com";

/// Endereço do site (trocável só para testes, com JARVIS_LAUNCHER_SITE).
fn site() -> String {
    std::env::var("JARVIS_LAUNCHER_SITE").unwrap_or_else(|_| SITE.to_string())
}
const VERSAO: &str = env!("CARGO_PKG_VERSION");
static OCUPADO: AtomicBool = AtomicBool::new(false);

fn sistema() -> &'static str {
    if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

// ---------------------------------------------------------------- pastas

fn pasta_launcher(app: &AppHandle) -> PathBuf {
    let d = std::env::var_os("JARVIS_LAUNCHER_DADOS")
        .map(PathBuf::from)
        .unwrap_or_else(|| app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let _ = fs::create_dir_all(&d);
    d
}

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// Pasta de dados do Jarvis (a mesma que ele usa: app_data_dir do identificador com.lpc.jarvis).
fn pasta_dados_jarvis() -> PathBuf {
    if cfg!(target_os = "macos") {
        home().join("Library/Application Support/com.lpc.jarvis")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home().join("AppData/Roaming")).join("com.lpc.jarvis")
    } else {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".local/share")).join("com.lpc.jarvis")
    }
}

/// Onde o Jarvis fica instalado (JARVIS_LAUNCHER_ALVO troca, só para testes).
fn alvo_jarvis() -> PathBuf {
    if let Some(a) = std::env::var_os("JARVIS_LAUNCHER_ALVO") {
        return PathBuf::from(a);
    }
    if cfg!(target_os = "macos") {
        let apps = PathBuf::from("/Applications");
        // sem permissão de escrita em /Applications (usuário sem administrador): ~/Applications
        if fs::metadata(&apps).map(|m| !m.permissions().readonly()).unwrap_or(false) && pode_escrever(&apps) {
            apps.join("Jarvis.app")
        } else {
            home().join("Applications/Jarvis.app")
        }
    } else if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home().join("AppData/Local")).join("Jarvis")
    } else {
        home().join(".local/share/jarvis-app")
    }
}

fn pode_escrever(dir: &Path) -> bool {
    let teste = dir.join(format!(".jarvis-teste-{}", std::process::id()));
    let ok = fs::write(&teste, b"").is_ok();
    let _ = fs::remove_file(&teste);
    ok
}

/// Raiz do próprio launcher (para ele se atualizar): o .app no Mac, a pasta do .exe no Windows, o AppImage no Linux.
fn raiz_launcher() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    if cfg!(target_os = "macos") {
        exe.ancestors().find(|p| p.extension().map(|e| e == "app").unwrap_or(false)).map(Path::to_path_buf)
    } else if cfg!(windows) {
        exe.parent().map(Path::to_path_buf)
    } else {
        std::env::var_os("APPIMAGE").map(PathBuf::from)
    }
}

// ---------------------------------------------------------------- conta guardada

#[derive(Serialize, Deserialize, Clone, Default)]
struct Conta {
    token: String,
    perfil: String,
    nome: String,
    email: String,
    url: String,
    dispositivo: String,
}

fn arquivo_conta(app: &AppHandle) -> PathBuf {
    pasta_launcher(app).join("conta.json")
}

fn gravar_privado(p: &Path, dados: &[u8]) -> Result<(), String> {
    if let Some(d) = p.parent() {
        fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("tmp");
    fs::write(&tmp, dados).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, p).map_err(|e| e.to_string())
}

fn ler_conta(app: &AppHandle) -> Option<Conta> {
    ler_conta_em(&pasta_launcher(app))
}

fn ler_conta_em(pasta: &Path) -> Option<Conta> {
    serde_json::from_slice(&fs::read(pasta.join("conta.json")).ok()?).ok()
}

fn id_dispositivo(app: &AppHandle) -> String {
    let f = pasta_launcher(app).join("dispositivo");
    if let Ok(s) = fs::read_to_string(&f) {
        if !s.trim().is_empty() {
            return s.trim().to_string();
        }
    }
    let mut h = Sha256::new();
    h.update(format!("{:?}{}{:?}", std::time::SystemTime::now(), std::process::id(), home()).as_bytes());
    let id = format!("{}-{}", sistema(), &hex::encode(h.finalize())[..16]);
    let _ = fs::write(&f, &id);
    id
}

fn nome_computador() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| Command::new("hostname").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| sistema().to_string())
}

/// O Jarvis lê este arquivo ao abrir e já se liga à nuvem da conta (nuvem.py).
fn ligar_jarvis_na_nuvem(c: &Conta) {
    let dados = json!({"url": c.url, "token": c.token, "perfil": c.perfil, "nome": c.nome, "email": c.email});
    let _ = gravar_privado(&pasta_dados_jarvis().join("nuvem-launcher.json"), dados.to_string().as_bytes());
}

// ---------------------------------------------------------------- HTTP

fn cliente() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(900))
        .connect_timeout(Duration::from_secs(20))
        .user_agent(format!("JarvisLauncher/{VERSAO} ({})", sistema()))
        .build()
        .expect("cliente http")
}

fn erro_http(r: reqwest::blocking::Response) -> String {
    let status = r.status();
    let corpo: Value = r.json().unwrap_or(Value::Null);
    corpo.get("detail").and_then(Value::as_str).map(String::from).unwrap_or_else(|| format!("O servidor respondeu {status}."))
}

fn get_json(c: &Conta, caminho: &str) -> Result<Value, String> {
    let r = cliente().get(format!("{}{caminho}", c.url)).bearer_auth(&c.token).send().map_err(|e| format!("Sem conexão com o Jarvis ({e})."))?;
    if !r.status().is_success() {
        return Err(erro_http(r));
    }
    r.json().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- comandos: conta

#[tauri::command]
fn estado_local(app: AppHandle) -> Value {
    let conta = ler_conta(&app);
    let instalado = ler_instalado(&pasta_launcher(&app), "jarvis");
    json!({
        "sistema": sistema(),
        "launcher": VERSAO,
        "logado": conta.is_some(),
        "conta": conta.map(|c| json!({"nome": c.nome, "email": c.email})),
        "jarvis": {
            "instalado": alvo_jarvis().exists(),
            "versao": instalado.as_ref().and_then(|m| m.get("versao").cloned()),
            "local": alvo_jarvis().to_string_lossy(),
        },
    })
}

#[tauri::command]
async fn entrar(app: AppHandle, email: String, senha: String) -> Result<Value, String> {
    let did = id_dispositivo(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let corpo = json!({"email": email.trim(), "senha": senha,
                           "dispositivo": {"id": did, "sistema": sistema(), "nome": nome_computador(), "launcher": VERSAO}});
        let r = cliente().post(format!("{}/api/launcher/entrar", site())).json(&corpo).send().map_err(|e| format!("Sem conexão com o Jarvis ({e})."))?;
        if !r.status().is_success() {
            return Err(erro_http(r));
        }
        let v: Value = r.json().map_err(|e| e.to_string())?;
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let c = Conta { token: s("token"), perfil: s("perfil"), nome: s("nome"), email: email.trim().to_lowercase(), url: s("url"), dispositivo: s("dispositivo") };
        gravar_privado(&arquivo_conta(&app), serde_json::to_vec(&c).unwrap().as_slice())?;
        ligar_jarvis_na_nuvem(&c);
        Ok(json!({"nome": c.nome}))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn sair(app: AppHandle) {
    let _ = fs::remove_file(arquivo_conta(&app));
}

#[tauri::command]
async fn estado_remoto(app: AppHandle) -> Result<Value, String> {
    let c = ler_conta(&app).ok_or("Entre com a sua conta.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let v = get_json(&c, &format!("/api/launcher/estado?sistema={}", sistema()));
        if let Err(e) = &v {
            if e.contains("pausada") || e.contains("401") {
                return v;
            }
        }
        let instalado = ler_instalado(&pasta_launcher(&app), "jarvis").and_then(|m| m.get("versao").and_then(Value::as_str).map(String::from));
        let _ = cliente()
            .post(format!("{}/api/launcher/ping", c.url))
            .bearer_auth(&c.token)
            .json(&json!({"jarvis": instalado, "launcher": VERSAO}))
            .send();
        ligar_jarvis_na_nuvem(&c);
        v
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn abrir_link(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("link inválido".into());
    }
    abrir(&url)
}

fn abrir(alvo: &str) -> Result<(), String> {
    let r = if cfg!(target_os = "macos") {
        Command::new("open").arg(alvo).spawn()
    } else if cfg!(windows) {
        Command::new("cmd").args(["/C", "start", "", alvo]).spawn()
    } else {
        Command::new("xdg-open").arg(alvo).spawn()
    };
    r.map(|_| ()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- instalar e atualizar

fn arquivo_instalado(base: &Path, produto: &str) -> PathBuf {
    base.join(format!("instalado-{produto}.json"))
}

fn ler_instalado(base: &Path, produto: &str) -> Option<Value> {
    serde_json::from_slice(&fs::read(arquivo_instalado(base, produto)).ok()?).ok()
}

fn sha256_arquivo(p: &Path) -> Option<String> {
    let mut f = fs::File::open(p).ok()?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Some(hex::encode(h.finalize()))
}

#[derive(Clone, Serialize)]
struct Progresso {
    fase: String,
    feito: u64,
    total: u64,
    texto: String,
}

/// Para onde vão os avisos de progresso: a janela, ou a saída (modo de teste sem janela).
#[derive(Clone)]
struct Base {
    pasta: PathBuf,
    app: Option<AppHandle>,
}

fn base(app: &AppHandle) -> Base {
    Base { pasta: pasta_launcher(app), app: Some(app.clone()) }
}

fn avisar(b: &Base, fase: &str, feito: u64, total: u64, texto: &str) {
    match &b.app {
        Some(app) => {
            let _ = app.emit("progresso", Progresso { fase: fase.into(), feito, total, texto: texto.into() });
        }
        None => println!("{fase} {feito}/{total} {texto}"),
    }
}

fn ligar_ou_copiar(de: &Path, para: &Path) -> std::io::Result<()> {
    if fs::hard_link(de, para).is_err() {
        fs::copy(de, para)?;
    }
    Ok(())
}

#[cfg(unix)]
fn marcar_exec(p: &Path, exec: bool) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(p, fs::Permissions::from_mode(if exec { 0o755 } else { 0o644 }));
}
#[cfg(not(unix))]
fn marcar_exec(_p: &Path, _exec: bool) {}

#[cfg(unix)]
fn criar_link(alvo: &str, p: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(alvo, p)
}
#[cfg(not(unix))]
fn criar_link(_alvo: &str, _p: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Monta a versão do manifesto numa pasta nova ao lado de `alvo`, reaproveitando os arquivos iguais da instalação
/// atual (e do cache), e baixando só o que falta. Devolve a pasta pronta.
fn montar(app: &Base, c: &Conta, manifesto: &Value, alvo: &Path, produto: &str) -> Result<PathBuf, String> {
    let itens = manifesto.get("arquivos").and_then(Value::as_array).ok_or("manifesto inválido")?;
    let pai = alvo.parent().ok_or("destino inválido")?;
    fs::create_dir_all(pai).map_err(|e| format!("Não consegui criar {}: {e}", pai.display()))?;
    let nome = alvo.file_name().unwrap().to_string_lossy().to_string();
    let novo = pai.join(format!(".{nome}-novo"));
    let _ = fs::remove_dir_all(&novo);
    let _ = fs::remove_file(&novo);
    let cache = app.pasta.join("cache");
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;

    // o que já existe na instalação atual: pelo registro da última instalação (rápido) ou conferindo o hash
    let antes: HashMap<String, String> = ler_instalado(&app.pasta, produto)
        .and_then(|m| m.get("arquivos").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|a| Some((a.get("caminho")?.as_str()?.to_string(), a.get("sha")?.as_str()?.to_string())))
        .collect();
    let arquivo_unico = itens.len() == 1 && alvo.extension().map(|e| e == "AppImage").unwrap_or(false);

    let mut baixar: Vec<(String, u64)> = vec![];
    let mut reaproveitar: Vec<(PathBuf, String)> = vec![];
    let total = itens.len() as u64;
    for (i, a) in itens.iter().enumerate() {
        if i % 200 == 0 {
            avisar(app, "conferindo", i as u64, total, "Conferindo o que já está instalado");
        }
        let Some(sha) = a.get("sha").and_then(Value::as_str) else { continue };
        let caminho = a["caminho"].as_str().unwrap_or("");
        let tamanho = a.get("tamanho").and_then(Value::as_u64).unwrap_or(0);
        let atual = if arquivo_unico { alvo.to_path_buf() } else { alvo.join(caminho) };
        let no_cache = cache.join(sha);
        if no_cache.exists() {
            continue;
        }
        let igual = atual.is_file()
            && fs::metadata(&atual).map(|m| m.len() == tamanho).unwrap_or(false)
            && (antes.get(caminho).map(|s| s == sha).unwrap_or(false) || sha256_arquivo(&atual).as_deref() == Some(sha));
        if igual {
            reaproveitar.push((atual, sha.to_string()));
        } else if !baixar.iter().any(|(s, _)| s == sha) {
            baixar.push((sha.to_string(), tamanho));
        }
    }

    // baixa o que falta (4 de cada vez), conferindo o hash de cada arquivo
    let bytes_total: u64 = baixar.iter().map(|(_, t)| *t).sum();
    let feito = Arc::new(Mutex::new(0u64));
    let fila = Arc::new(Mutex::new(baixar));
    let erro: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let mut threads = vec![];
    for _ in 0..4 {
        let (fila, feito, erro, cache, c, app) = (fila.clone(), feito.clone(), erro.clone(), cache.clone(), c.clone(), app.clone());
        threads.push(std::thread::spawn(move || {
            let cli = cliente();
            loop {
                let Some((sha, tamanho)) = fila.lock().unwrap().pop() else { break };
                if erro.lock().unwrap().is_some() {
                    break;
                }
                let mut ok = false;
                for _ in 0..4 {
                    let tmp = cache.join(format!("{sha}.parte"));
                    let r = cli.get(format!("{}/api/launcher/arquivo/{sha}", c.url)).bearer_auth(&c.token).send();
                    let Ok(mut r) = r else { std::thread::sleep(Duration::from_secs(3)); continue };
                    if !r.status().is_success() {
                        std::thread::sleep(Duration::from_secs(3));
                        continue;
                    }
                    let Ok(mut f) = fs::File::create(&tmp) else { break };
                    let mut h = Sha256::new();
                    let mut buf = vec![0u8; 1 << 16];
                    let mut falhou = false;
                    loop {
                        match r.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                h.update(&buf[..n]);
                                if f.write_all(&buf[..n]).is_err() {
                                    falhou = true;
                                    break;
                                }
                                let mut fd = feito.lock().unwrap();
                                *fd += n as u64;
                                if *fd % (4 << 20) < n as u64 {
                                    avisar(&app, "baixando", *fd, bytes_total, "Baixando o que mudou");
                                }
                            }
                            Err(_) => {
                                falhou = true;
                                break;
                            }
                        }
                    }
                    drop(f);
                    if !falhou && hex::encode(h.finalize()) == sha && fs::rename(&tmp, cache.join(&sha)).is_ok() {
                        ok = true;
                        break;
                    }
                    let _ = fs::remove_file(&tmp);
                    let mut fd = feito.lock().unwrap();
                    *fd = fd.saturating_sub(tamanho);
                }
                if !ok {
                    *erro.lock().unwrap() = Some("Não consegui baixar um dos arquivos. Confira a internet e tente de novo.".into());
                }
            }
        }));
    }
    for t in threads {
        let _ = t.join();
    }
    if let Some(e) = erro.lock().unwrap().take() {
        return Err(e);
    }

    // monta a pasta nova: arquivos (do cache ou da instalação atual), links e permissões
    avisar(app, "montando", 0, total, "Montando a versão nova");
    let reaproveitados: HashMap<String, PathBuf> = reaproveitar.into_iter().map(|(p, s)| (s, p)).collect();
    if arquivo_unico {
        let sha = itens[0]["sha"].as_str().unwrap_or("");
        let de = if cache.join(sha).exists() { cache.join(sha) } else { reaproveitados.get(sha).cloned().ok_or("arquivo sumiu")? };
        fs::copy(&de, &novo).map_err(|e| e.to_string())?;
        marcar_exec(&novo, true);
        return Ok(novo);
    }
    fs::create_dir_all(&novo).map_err(|e| format!("Não consegui escrever em {}: {e}", pai.display()))?;
    for (i, a) in itens.iter().enumerate() {
        let caminho = a["caminho"].as_str().unwrap_or("");
        if caminho.contains("..") {
            return Err("manifesto com caminho inválido".into());
        }
        let p = novo.join(caminho);
        if let Some(d) = p.parent() {
            fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        if let Some(link) = a.get("link").and_then(Value::as_str) {
            criar_link(link, &p).map_err(|e| e.to_string())?;
            continue;
        }
        let sha = a["sha"].as_str().unwrap_or("");
        let de = if cache.join(sha).exists() { cache.join(sha) } else { reaproveitados.get(sha).cloned().ok_or("arquivo sumiu")? };
        ligar_ou_copiar(&de, &p).map_err(|e| format!("{}: {e}", p.display()))?;
        marcar_exec(&p, a.get("exec").and_then(Value::as_bool).unwrap_or(false));
        if i % 300 == 0 {
            avisar(app, "montando", i as u64, total, "Montando a versão nova");
        }
    }
    Ok(novo)
}

/// Troca a instalação atual pela pasta nova de uma vez (rename); se falhar, volta como estava.
fn trocar(novo: &Path, alvo: &Path) -> Result<(), String> {
    let nome = alvo.file_name().unwrap().to_string_lossy().to_string();
    let velho = alvo.parent().unwrap().join(format!(".{nome}-antigo"));
    let _ = fs::remove_dir_all(&velho);
    let _ = fs::remove_file(&velho);
    let tinha = alvo.exists();
    if tinha {
        let mut ok = false;
        for _ in 0..10 {
            if fs::rename(alvo, &velho).is_ok() {
                ok = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(700)); // Windows: arquivos ainda se fechando
        }
        if !ok {
            return Err("O Jarvis ainda está aberto e não deixou trocar a versão. Feche o Jarvis e tente de novo.".into());
        }
    }
    if let Err(e) = fs::rename(novo, alvo) {
        if tinha {
            let _ = fs::rename(&velho, alvo);
        }
        return Err(format!("Não consegui trocar a versão: {e}"));
    }
    let _ = fs::remove_dir_all(&velho);
    let _ = fs::remove_file(&velho);
    Ok(())
}

fn fechar_jarvis() {
    if std::env::var_os("JARVIS_LAUNCHER_ALVO").is_some() {
        return; // teste: não fecha o Jarvis de verdade
    }
    if cfg!(target_os = "macos") {
        let _ = Command::new("osascript").args(["-e", "tell application \"Jarvis\" to quit"]).output();
        std::thread::sleep(Duration::from_secs(2));
        let _ = Command::new("pkill").args(["-x", "Jarvis"]).output();
        let _ = Command::new("pkill").args(["-x", "jarvis"]).output();
        let _ = Command::new("pkill").args(["-f", "jarvis-core"]).output();
    } else if cfg!(windows) {
        for exe in ["Jarvis.exe", "jarvis.exe", "jarvis-core.exe", "node.exe"] {
            if exe == "node.exe" {
                continue; // node do sistema da pessoa: não mexe
            }
            let _ = Command::new("taskkill").args(["/F", "/IM", exe]).output();
        }
    } else {
        let _ = Command::new("pkill").args(["-f", "jarvis-app/AppRun"]).output();
        let _ = Command::new("pkill").args(["-x", "jarvis"]).output();
        let _ = Command::new("pkill").args(["-f", "jarvis-core"]).output();
    }
    std::thread::sleep(Duration::from_secs(2));
}

fn abrir_instalado() -> Result<(), String> {
    let alvo = alvo_jarvis();
    if !alvo.exists() {
        return Err("O Jarvis ainda não está instalado.".into());
    }
    if cfg!(target_os = "macos") {
        Command::new("open").arg(&alvo).spawn().map(|_| ()).map_err(|e| e.to_string())
    } else if cfg!(windows) {
        let exe = fs::read_dir(&alvo)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .find(|p| {
                let n = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                n.ends_with(".exe") && !n.contains("uninstall") && !n.contains("desinstalar")
            })
            .ok_or("Não achei o executável do Jarvis.")?;
        Command::new(exe).spawn().map(|_| ()).map_err(|e| e.to_string())
    } else {
        Command::new(alvo.join("AppRun")).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Atalhos do sistema depois de instalar: menu Iniciar (Windows) e menu de aplicativos (Linux).
fn atalhos() {
    let alvo = alvo_jarvis();
    if cfg!(windows) {
        if let Some(exe) = fs::read_dir(&alvo).ok().and_then(|it| {
            it.filter_map(|e| e.ok().map(|e| e.path())).find(|p| {
                let n = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                n.ends_with(".exe") && !n.contains("uninstall")
            })
        }) {
            let menu = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default().join("Microsoft/Windows/Start Menu/Programs/Jarvis.lnk");
            let ps = format!(
                "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');$s.TargetPath='{}';$s.WorkingDirectory='{}';$s.Save()",
                menu.display(),
                exe.display(),
                alvo.display()
            );
            let _ = Command::new("powershell").args(["-NoProfile", "-Command", &ps]).output();
        }
    } else if cfg!(target_os = "linux") {
        let icone = ["jarvis.png", ".DirIcon"].iter().map(|n| alvo.join(n)).find(|p| p.exists());
        let desktop = format!(
            "[Desktop Entry]\nType=Application\nName=Jarvis\nComment=Assistente de voz\nExec={}\nIcon={}\nTerminal=false\nCategories=Utility;\n",
            alvo.join("AppRun").display(),
            icone.map(|p| p.display().to_string()).unwrap_or_default()
        );
        let f = home().join(".local/share/applications/jarvis.desktop");
        let _ = fs::create_dir_all(f.parent().unwrap());
        let _ = fs::write(f, desktop);
    }
}

/// Instala ou atualiza o Jarvis (a janela chama; o modo de teste também).
fn instalar_agora(app: &Base, c: &Conta) -> Result<Value, String> {
        avisar(app, "manifesto", 0, 1, "Buscando a versão mais nova");
        let m = get_json(&c, &format!("/api/launcher/manifesto/jarvis/{}", sistema()))?;
        let alvo = alvo_jarvis();
        let novo = montar(app, c, &m, &alvo, "jarvis")?;
        avisar(app, "trocando", 0, 1, "Fechando o Jarvis e trocando a versão");
        fechar_jarvis();
        trocar(&novo, &alvo)?;
        gravar_privado(&arquivo_instalado(&app.pasta, "jarvis"), m.to_string().as_bytes())?;
        if std::env::var_os("JARVIS_LAUNCHER_ALVO").is_none() {
            atalhos();
            ligar_jarvis_na_nuvem(c);
        }
        let _ = limpar_cache(app, &m);
        let _ = cliente()
            .post(format!("{}/api/launcher/ping", c.url))
            .bearer_auth(&c.token)
            .json(&json!({"jarvis": m.get("versao"), "launcher": VERSAO}))
            .send();
        avisar(app, "pronto", 1, 1, "Pronto");
        if std::env::var_os("JARVIS_LAUNCHER_ALVO").is_none() {
            let _ = abrir_instalado();
        }
        Ok(json!({"versao": m.get("versao")}))
}

#[tauri::command]
async fn instalar(app: AppHandle) -> Result<Value, String> {
    if OCUPADO.swap(true, Ordering::SeqCst) {
        return Err("Já estou instalando.".into());
    }
    let b = base(&app);
    let r = tauri::async_runtime::spawn_blocking(move || {
        let c = ler_conta_em(&b.pasta).ok_or("Entre com a sua conta.")?;
        instalar_agora(&b, &c)
    })
    .await
    .map_err(|e| e.to_string())?;
    OCUPADO.store(false, Ordering::SeqCst);
    r
}

/// Modo de teste sem janela: `jarvis-launcher --instalar-teste` (usa JARVIS_LAUNCHER_DADOS e JARVIS_LAUNCHER_ALVO).
pub fn instalar_sem_janela() -> i32 {
    let pasta = PathBuf::from(std::env::var_os("JARVIS_LAUNCHER_DADOS").expect("JARVIS_LAUNCHER_DADOS"));
    let b = Base { pasta: pasta.clone(), app: None };
    let Some(c) = ler_conta_em(&pasta) else {
        eprintln!("sem conta em {}", pasta.display());
        return 2;
    };
    match instalar_agora(&b, &c) {
        Ok(v) => {
            println!("instalado {v}");
            0
        }
        Err(e) => {
            eprintln!("erro: {e}");
            1
        }
    }
}

/// O cache guarda só o que a versão instalada usa (o resto já não serve).
fn limpar_cache(app: &Base, m: &Value) -> std::io::Result<()> {
    let usados: std::collections::HashSet<String> = m["arquivos"].as_array().into_iter().flatten().filter_map(|a| a.get("sha")?.as_str().map(String::from)).collect();
    for e in fs::read_dir(app.pasta.join("cache"))? {
        let p = e?.path();
        if !usados.contains(&p.file_name().unwrap_or_default().to_string_lossy().to_string()) {
            let _ = fs::remove_file(p);
        }
    }
    // a versão instalada já tem cópias (ou ligações) de tudo: o cache pode ir embora
    let _ = fs::remove_dir_all(app.pasta.join("cache"));
    Ok(())
}

#[tauri::command]
fn abrir_jarvis() -> Result<(), String> {
    abrir_instalado()
}

#[tauri::command]
async fn atualizar_launcher(app: AppHandle) -> Result<Value, String> {
    let raiz = raiz_launcher().ok_or("Este launcher não pode se atualizar sozinho; baixe o novo no site.")?;
    let app2 = app.clone();
    let raiz2 = raiz.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let raiz = raiz2;
        let c = ler_conta(&app2).ok_or("Entre com a sua conta.")?;
        let b = base(&app2);
        let m = get_json(&c, &format!("/api/launcher/manifesto/launcher/{}", sistema()))?;
        let novo = montar(&b, &c, &m, &raiz, "launcher")?;
        trocar(&novo, &raiz)?;
        gravar_privado(&arquivo_instalado(&b.pasta, "launcher"), m.to_string().as_bytes())?;
        Ok(json!({"versao": m.get("versao")}))
    })
    .await
    .map_err(|e| e.to_string())??;
    // abre a versão nova e fecha esta
    let _ = if cfg!(target_os = "macos") {
        Command::new("open").args(["-n"]).arg(&raiz).spawn()
    } else if cfg!(windows) {
        Command::new(std::env::current_exe().unwrap_or_default()).spawn()
    } else {
        Command::new(&raiz).spawn()
    };
    app.exit(0);
    Ok(json!({"ok": true}))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("principal") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![estado_local, entrar, sair, estado_remoto, instalar, abrir_jarvis, abrir_link, atualizar_launcher])
        .run(tauri::generate_context!())
        .expect("erro ao abrir o Jarvis Launcher");
}
