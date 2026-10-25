"""Windows: pynput para mouse e teclado, Win32 para janelas, UI Automation para clicar pelo nome,
mss para a tela, pycaw para o volume. O processo fica "DPI aware": tudo em pixels físicos por dentro e
convertido para pontos lógicos (como as janelas do app) na saída."""

import ctypes
import difflib
import os
import subprocess
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from .common import MAX_TEXTO, PynputInput, cancel, capture_mss

try:  # coordenadas reais em telas com escala (125%, 150%…)
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:  # noqa: BLE001
    pass

import win32api  # noqa: E402
import win32con  # noqa: E402
import win32gui  # noqa: E402
import win32process  # noqa: E402

__all__ = [
    "MAX_TEXTO", "activate", "brightness", "browser", "browser_url", "button", "cancel", "capture", "click", "click_named",
    "clipboard_text", "front_app", "front_is_jarvis", "front_window_title", "keys_into", "lock_screen", "look_at",
    "main_bounds", "media", "move", "open_app", "open_link", "open_path", "pedir_permissao", "permitido", "position", "press",
    "replace_selection", "scroll", "selected_text", "set_clipboard", "snapshot", "type_into", "type_text", "volume",
    "win_aim", "win_grab", "win_move", "win_release", "win_run", "win_scale", "win_throw", "apps_abertos", "janela_app",
]

_in = PynputInput()


def _escala() -> float:
    try:
        return ctypes.windll.user32.GetDpiForSystem() / 96
    except Exception:  # noqa: BLE001
        return 1.0


ESC = _escala()


def permitido() -> bool:
    return True  # o Windows não pede permissão para automação


def pedir_permissao() -> bool:
    return True


# ---------- mouse e teclado (em pontos lógicos) ----------


def position() -> tuple[float, float]:
    x, y = _in.position()
    return x / ESC, y / ESC


def move(x: float, y: float) -> None:
    _in.move(x * ESC, y * ESC)


def button(down: bool, x: float | None = None, y: float | None = None, direito: bool = False) -> None:
    _in.button(down, None if x is None else x * ESC, None if y is None else y * ESC, direito)


def click(x: float | None = None, y: float | None = None, duplo: bool = False, direito: bool = False) -> dict[str, Any]:
    return _in.click(None if x is None else x * ESC, None if y is None else y * ESC, duplo, direito)


def scroll(dy: int, dx: int = 0) -> None:
    _in.scroll(dy, dx)


def type_text(texto: str) -> dict[str, Any]:
    return _in.type_text(texto)


def press(combo: str, confirmado: bool = False) -> dict[str, Any]:
    return _in.press(combo, confirmado)


def main_bounds() -> tuple[float, float, float, float]:
    w = win32api.GetSystemMetrics(win32con.SM_CXSCREEN)
    h = win32api.GetSystemMetrics(win32con.SM_CYSCREEN)
    return 0.0, 0.0, w / ESC, h / ESC


# ---------- apps ----------


def _proc_name(hwnd: int) -> str:
    try:
        import psutil

        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        return Path(psutil.Process(pid).name()).stem
    except Exception:  # noqa: BLE001
        return ""


def front_app() -> str:
    return _proc_name(win32gui.GetForegroundWindow())


def front_window_title() -> str:
    return win32gui.GetWindowText(win32gui.GetForegroundWindow())


def front_is_jarvis() -> bool:
    t = front_window_title().lower()
    return "j.a.r.v.i.s" in t or t.startswith("jarvis")


def _start_menu() -> dict[str, Path]:
    found: dict[str, Path] = {}
    for base in (Path(os.getenv("PROGRAMDATA", "C:/ProgramData")), Path(os.getenv("APPDATA", ""))):
        pasta = base / "Microsoft" / "Windows" / "Start Menu" / "Programs"
        if pasta.exists():
            for lnk in pasta.rglob("*.lnk"):
                found.setdefault(lnk.stem.lower(), lnk)
    return found


def open_app(nome: str) -> dict[str, Any]:
    atalhos = _start_menu()
    key = nome.lower().strip()
    hit = atalhos.get(key) or next((v for k, v in atalhos.items() if key in k), None)
    if not hit:
        close = difflib.get_close_matches(key, list(atalhos), n=1, cutoff=0.6)
        hit = atalhos[close[0]] if close else None
    if hit:
        os.startfile(str(hit))  # noqa: S606
        return {"ok": True, "app": hit.stem}
    try:
        subprocess.Popen(["cmd", "/c", "start", "", nome], shell=False)  # noqa: S603, S607 - nome vem da lista de apps
        return {"ok": True, "app": nome}
    except OSError:
        return {"erro": f"Não encontrei o app {nome}."}


def open_link(url: str) -> dict[str, Any]:
    if not url.startswith(("http://", "https://")):
        url = "https://" + url.lstrip("/")
    webbrowser.open(url)
    return {"ok": True, "url": url}


def open_path(p: str) -> None:
    os.startfile(p)  # noqa: S606


def _windows() -> list[tuple[int, str, str, tuple[int, int, int, int]]]:
    """Janelas visíveis de verdade, da frente para trás: (hwnd, app, título, retângulo físico)."""
    out: list[tuple[int, str, str, tuple[int, int, int, int]]] = []

    def cb(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd) or win32gui.IsIconic(hwnd):
            return True
        titulo = win32gui.GetWindowText(hwnd)
        if not titulo or win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE) & win32con.WS_EX_TOOLWINDOW:
            return True
        app = _proc_name(hwnd)
        if app.lower() in ("jarvis", "jarvis-core", "applicationframehost", "textinputhost", "shellexperiencehost"):
            return True
        l, t, r, b = win32gui.GetWindowRect(hwnd)
        if r - l > 80 and b - t > 60:
            out.append((hwnd, app, titulo, (l, t, r - l, b - t)))
        return True

    win32gui.EnumWindows(cb, None)
    return out


def activate(app: str) -> dict[str, Any]:
    key = app.lower()
    for hwnd, nome, titulo, _ in _windows():
        if key in nome.lower() or key in titulo.lower():
            try:
                win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                win32gui.SetForegroundWindow(hwnd)
            except Exception:  # noqa: BLE001 - o Windows às vezes nega o foco; o clique resolve
                pass
            time.sleep(0.4)
            return {"ok": True}
    r = open_app(app)
    time.sleep(1.2)
    return r


def type_into(texto: str, app: str | None = None, enter: bool = False) -> dict[str, Any]:
    if app:
        r = activate(app)
        if r.get("erro"):
            return r
    if front_is_jarvis():
        return {"erro": "A janela da frente é o próprio Jarvis. Diga em qual app escrever."}
    res = type_text(texto)
    if enter and res.get("ok"):
        press("enter")
    return {**res, "app": app or front_app()}


def keys_into(combo: str, app: str | None = None, confirmado: bool = False) -> dict[str, Any]:
    if app:
        r = activate(app)
        if r.get("erro"):
            return r
    if front_is_jarvis():
        return {"erro": "A janela da frente é o próprio Jarvis. Diga em qual app usar o atalho."}
    return {**press(combo, confirmado), "app": app or front_app()}


def browser(acao: str, valor: str = "") -> dict[str, Any]:
    from urllib.parse import quote_plus

    if acao in ("nova_aba", "abrir"):
        url = valor.strip()
        if url and "://" not in url and "." in url and " " not in url:
            url = "https://" + url
        elif url and "://" not in url:
            url = "https://www.google.com/search?q=" + quote_plus(url)
        webbrowser.open_new_tab(url or "about:blank")
        return {"ok": True, "url": url}
    if acao == "buscar":
        webbrowser.open_new_tab("https://www.google.com/search?q=" + quote_plus(valor))
        return {"ok": True}
    atalhos = {"fechar_aba": "ctrl+w", "voltar": "alt+left", "avancar": "alt+right", "recarregar": "f5", "proxima_aba": "ctrl+tab"}
    if acao in atalhos:
        if front_is_jarvis():
            return {"erro": "A janela da frente é o Jarvis. Abra o navegador primeiro."}
        return press(atalhos[acao])
    return {"erro": f"Ação de navegador desconhecida: {acao}"}


def browser_url(app: str) -> str | None:
    return None  # no Windows o endereço da aba não é exposto sem extensão


def capture(x: float, y: float, w: float, h: float, max_w: int = 1280) -> bytes | None:
    return capture_mss(x, y, w, h, ESC)


# ---------- janelas com a mão ----------

_fila = ThreadPoolExecutor(1, thread_name_prefix="janelas")
_grab: dict[str, Any] | None = None


async def win_run(fn, *args):
    import asyncio

    return await asyncio.get_running_loop().run_in_executor(_fila, fn, *args)


def _to_phys(nx: float, ny: float) -> tuple[int, int]:
    x0, y0, w, h = main_bounds()
    return int((x0 + nx * w) * ESC), int((y0 + ny * h) * ESC)


def _view(rect, app: str = "", titulo: str = "") -> dict[str, Any]:
    x, y, w, h = rect
    return {"x": x / ESC, "y": y / ESC, "w": w / ESC, "h": h / ESC, "app": app, "titulo": titulo}


def _at(px: int, py: int):
    for hwnd, app, titulo, (x, y, w, h) in _windows():
        if x <= px <= x + w and y <= py <= y + h:
            return hwnd, app, titulo, (x, y, w, h)
    return None


def win_aim(nx: float, ny: float) -> dict[str, Any] | None:
    hit = _at(*_to_phys(nx, ny))
    return _view(hit[3], hit[1], hit[2]) if hit else None


def win_grab(nx: float, ny: float) -> dict[str, Any]:
    global _grab
    px, py = _to_phys(nx, ny)
    hit = _at(px, py)
    if not hit:
        return {"erro": "Nenhuma janela embaixo da mão."}
    hwnd, app, titulo, rect = hit
    if win32gui.GetWindowPlacement(hwnd)[1] == win32con.SW_SHOWMAXIMIZED:
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        rect = _windows_rect(hwnd)
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:  # noqa: BLE001
        pass
    _grab = {"hwnd": hwnd, "orig": rect, "dedo": (px, py), "app": app, "titulo": titulo}
    return {"ok": True, **_view(rect, app, titulo)}


def _windows_rect(hwnd) -> tuple[int, int, int, int]:
    l, t, r, b = win32gui.GetWindowRect(hwnd)
    return l, t, r - l, b - t


def _place(x: int, y: int, w: int, h: int) -> None:
    win32gui.SetWindowPos(_grab["hwnd"], 0, int(x), int(y), int(w), int(h), win32con.SWP_NOZORDER | win32con.SWP_NOACTIVATE)


def win_move(nx: float, ny: float) -> dict[str, Any] | None:
    if not _grab:
        return None
    px, py = _to_phys(nx, ny)
    ox, oy, w, h = _grab["orig"]
    x, y = ox + px - _grab["dedo"][0], max(0, oy + py - _grab["dedo"][1])
    _place(x, y, w, h)
    return _view((x, y, w, h), _grab["app"], _grab["titulo"])


def _monitors() -> list[tuple[int, int, int, int]]:
    out = []
    for m in win32api.EnumDisplayMonitors():
        l, t, r, b = win32api.GetMonitorInfo(m[0])["Work"]
        out.append((l, t, r - l, b - t))
    return sorted(out)


def win_scale(f: float) -> dict[str, Any] | None:
    if not _grab:
        return None
    ox, oy, w, h = _grab["orig"]
    cx, cy = ox + w / 2, oy + h / 2
    tela = next((m for m in _monitors() if m[0] <= cx < m[0] + m[2] and m[1] <= cy < m[1] + m[3]), _monitors()[0])
    nw, nh = min(tela[2], max(400, w * f)), min(tela[3], max(280, h * f))
    x = min(max(tela[0], cx - nw / 2), tela[0] + tela[2] - nw)
    y = min(max(tela[1], cy - nh / 2), tela[1] + tela[3] - nh)
    _place(x, y, nw, nh)
    return _view((x, y, nw, nh), _grab["app"], _grab["titulo"])


def win_throw(direcao: str) -> dict[str, Any]:
    if not _grab:
        return {"erro": "Nenhuma janela segura."}
    x, y, w, h = _windows_rect(_grab["hwnd"])
    telas = _monitors()
    atual = next((i for i, m in enumerate(telas) if m[0] <= x + w / 2 < m[0] + m[2]), 0)
    alvo = atual - 1 if direcao == "esquerda" else atual + 1
    if not 0 <= alvo < len(telas):
        return {"erro": "Não há monitor desse lado."}
    a, b = telas[atual], telas[alvo]
    nw, nh = min(w, b[2]), min(h, b[3])
    nx = min(b[0] + (x - a[0]) / a[2] * b[2], b[0] + b[2] - nw)
    ny = min(max(b[1], b[1] + (y - a[1]) / a[3] * b[3]), b[1] + b[3] - nh)
    _place(nx, ny, nw, nh)
    _grab["orig"] = (nx, ny, nw, nh)
    return {"ok": True, **_view((nx, ny, nw, nh), _grab["app"], _grab["titulo"])}


def win_release(cancelar: bool = False) -> dict[str, Any] | None:
    global _grab
    if not _grab:
        return None
    if cancelar:
        _place(*_grab["orig"])
    out = _view(_windows_rect(_grab["hwnd"]), _grab["app"], _grab["titulo"])
    _grab = None
    return out


# ---------- contexto ----------


def clipboard_text() -> str:
    import win32clipboard

    try:
        win32clipboard.OpenClipboard()
        try:
            return str(win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT))
        finally:
            win32clipboard.CloseClipboard()
    except Exception:  # noqa: BLE001
        return ""


def set_clipboard(texto: str) -> None:
    import win32clipboard

    win32clipboard.OpenClipboard()
    try:
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardData(win32con.CF_UNICODETEXT, texto)
    finally:
        win32clipboard.CloseClipboard()


def selected_text(copiar: bool = True) -> str:
    if not copiar or front_is_jarvis():
        return ""
    antes = clipboard_text()
    set_clipboard("")
    press("ctrl+c")
    time.sleep(0.25)
    texto = clipboard_text()
    if antes:
        set_clipboard(antes)
    return texto


def replace_selection(texto: str) -> dict[str, Any]:
    if front_is_jarvis():
        return {"erro": "A janela da frente é o próprio Jarvis; volte para o app onde está o texto."}
    antes = clipboard_text()
    set_clipboard(texto[:MAX_TEXTO])
    press("ctrl+v")
    time.sleep(0.4)
    if antes:
        set_clipboard(antes)
    return {"ok": True, "app": front_app()}


def _front_rect_logical() -> tuple[float, float, float, float] | None:
    hwnd = win32gui.GetForegroundWindow()
    if not hwnd:
        return None
    x, y, w, h = _windows_rect(hwnd)
    return x / ESC, y / ESC, w / ESC, h / ESC


def _uia_elements(limite: int = 250) -> list[dict[str, Any]]:
    try:
        import uiautomation as auto
    except ImportError:
        return []
    raiz = auto.GetForegroundControl()
    out: list[dict[str, Any]] = []
    fim = time.time() + 2.5
    for ctrl, _ in auto.WalkControl(raiz, maxDepth=25):
        if time.time() > fim or len(out) >= limite:
            break
        nome = (ctrl.Name or "").strip()
        if not nome or ctrl.ControlTypeName not in ("ButtonControl", "HyperlinkControl", "MenuItemControl", "TabItemControl",
                                                     "CheckBoxControl", "EditControl", "ListItemControl", "TreeItemControl"):
            continue
        r = ctrl.BoundingRectangle
        if r.width() > 2 and r.height() > 2:
            out.append({"ctrl": ctrl, "papel": ctrl.ControlTypeName.replace("Control", "").lower(), "rotulo": nome[:120],
                        "frame": (r.left / ESC, r.top / ESC, r.width() / ESC, r.height() / ESC)})
    return out


def click_named(alvo: str) -> dict[str, Any]:
    from .. import overlay

    if front_is_jarvis():
        return {"erro": "A janela da frente é o próprio Jarvis; diga em qual app clicar."}
    lista = _uia_elements()
    a = alvo.lower().strip()
    e = next((x for x in lista if x["rotulo"].lower() == a), None) or next((x for x in lista if a in x["rotulo"].lower()), None)
    if not e:
        return {"erro": f"Não achei '{alvo}' na janela da frente.", "opcoes": [f"{x['papel']}: {x['rotulo']}" for x in lista[:40]]}
    x, y, w, h = e["frame"]
    overlay.look(x, y, w, h, f"Clicando em {e['rotulo'][:40]}")
    time.sleep(1.1)
    click(x + w / 2, y + h / 2)
    return {"ok": True, "clicou": e["rotulo"], "app": front_app()}


REGIOES = {
    "janela": (0, 0, 1, 1), "barra_lateral": (0, 0, 0.24, 1), "barra_lateral_direita": (0.76, 0, 0.24, 1),
    "topo": (0, 0, 1, 0.18), "rodape": (0, 0.82, 1, 0.18), "centro": (0.2, 0.2, 0.6, 0.6),
    "canto_superior_esquerdo": (0, 0, 0.4, 0.35), "canto_superior_direito": (0.6, 0, 0.4, 0.35),
    "canto_inferior_esquerdo": (0, 0.65, 0.4, 0.35), "canto_inferior_direito": (0.6, 0.65, 0.4, 0.35),
}


def look_at(regiao: str | None = None, alvo: str | None = None, label: str = "Estou vendo") -> dict[str, Any]:
    from .. import overlay

    if front_is_jarvis():
        return {"erro": "A janela da frente é o próprio Jarvis; peça para ele ir ao app primeiro."}
    area = None
    if alvo:
        e = next((x for x in _uia_elements() if alvo.lower() in x["rotulo"].lower()), None)
        area = e["frame"] if e else None
    if area is None and regiao == "mouse":
        mx, my = position()
        area = (mx - 160, my - 110, 320, 220)
    if area is None:
        win = _front_rect_logical()
        if not win:
            return {"erro": "Não achei a janela da frente."}
        fx, fy, fw, fh = REGIOES.get(regiao or "janela", REGIOES["janela"])
        area = (win[0] + win[2] * fx, win[1] + win[3] * fy, win[2] * fw, win[3] * fh)
    overlay.look(*area, label, "olhar")
    out: dict[str, Any] = {"app": front_app(), "janela": front_window_title(), "area": regiao or alvo or "janela"}
    img = capture(*area)
    if img:
        out["_imagem"] = img
        out["instrucao"] = "Você recebeu a imagem da área. Diga que está vendo ('Estou vendo, Senhor') e o que percebe, curto."
    return out


def snapshot(pointed: dict[str, Any] | None = None, com_selecao: bool = True) -> dict[str, Any]:
    from .. import overlay

    out: dict[str, Any] = {"app": front_app(), "janela": front_window_title()}
    if front_is_jarvis():
        out["observacao"] = "A janela da frente é o HUD do Jarvis; o app em que ele trabalhava ficou atrás."
    else:
        win = _front_rect_logical()
        if win:
            overlay.look(*win, "Olhando", "olhar")
        if com_selecao:
            sel = selected_text()
            if sel.strip():
                out["texto_selecionado"] = sel[:6000]
    if pointed:
        out["apontando_no_hud"] = pointed
    return out


# ---------- sistema ----------


def volume(nivel: int) -> dict[str, Any]:
    nivel = max(0, min(100, int(nivel)))
    try:
        from comtypes import CLSCTX_ALL
        from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume

        disp = AudioUtilities.GetSpeakers()
        iface = disp.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
        ctypes.cast(iface, ctypes.POINTER(IAudioEndpointVolume)).SetMasterVolumeLevelScalar(nivel / 100, None)
        return {"ok": True, "volume": nivel}
    except Exception as exc:  # noqa: BLE001
        return {"erro": f"Não consegui mudar o volume: {exc}"}


def media(acao: str) -> dict[str, Any]:
    return _in.media(acao)


def brightness(nivel: int) -> dict[str, Any]:
    try:
        import screen_brightness_control as sbc

        nivel = max(5, min(100, int(nivel)))
        sbc.set_brightness(nivel)
        return {"ok": True, "brilho": nivel}
    except Exception as exc:  # noqa: BLE001
        return {"erro": f"Este monitor não aceita mudar o brilho por software ({exc})."}


def lock_screen() -> dict[str, Any]:
    ctypes.windll.user32.LockWorkStation()
    return {"ok": True}


# ---------- janelas de qualquer app por voz ----------


def _todas_janelas() -> list[tuple[int, str, str]]:
    """Janelas de apps (inclusive minimizadas), da frente para trás: (hwnd, app, título)."""
    out: list[tuple[int, str, str]] = []

    def cb(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd) or not win32gui.GetWindowText(hwnd):
            return True
        if win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE) & win32con.WS_EX_TOOLWINDOW:
            return True
        app = _proc_name(hwnd)
        if app.lower() not in ("jarvis", "jarvis-core", "applicationframehost", "textinputhost", "shellexperiencehost", "searchhost"):
            out.append((hwnd, app, win32gui.GetWindowText(hwnd)))
        return True

    win32gui.EnumWindows(cb, None)
    return out


def apps_abertos() -> list[str]:
    return sorted({app for _, app, _ in _todas_janelas() if app})


def _frente(hwnd: int) -> None:
    try:
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        _in.press("alt")  # o Windows só deixa trocar o foco logo depois de uma tecla
        win32gui.SetForegroundWindow(hwnd)
    except Exception:  # noqa: BLE001
        pass


def janela_app(pedido: str, acao: str, confirmado: bool = False) -> dict[str, Any]:
    """Minimizar, fechar, maximizar, metade da tela, outro monitor… numa janela do app pedido (ou do da frente)."""
    from .. import overlay
    from .common import ACOES_JANELA, escolher_app

    if acao not in ACOES_JANELA:
        return {"erro": f"Ação desconhecida: {acao}."}
    janelas = _todas_janelas()
    frente = front_app() if not front_is_jarvis() else ""
    nome = escolher_app(pedido, [a for _, a, _ in janelas], frente)
    alvo = [j for j in janelas if j[1] == nome]
    if not nome or not alvo:
        # pelo título também ("a janela do relatório")
        alvo = [j for j in janelas if pedido.lower() in j[2].lower()] if pedido else []
        if not alvo:
            return {"erro": f"Não achei '{pedido}' aberto.", "apps_abertos": ", ".join(apps_abertos()[:25])}
        nome = alvo[0][1]
    hwnd = alvo[0][0]
    if acao == "sair":
        if not confirmado:
            return {"precisa_confirmar": True, "instrucao": f"Pergunte se pode fechar o {nome} inteiro (algo não salvo pode pedir para salvar)."}
        for h, _, _ in alvo:
            win32gui.PostMessage(h, win32con.WM_CLOSE, 0, 0)
        return {"ok": True, "app": nome, "feito": "fechado"}
    if not win32gui.IsIconic(hwnd):
        l, t, r, b = win32gui.GetWindowRect(hwnd)
        overlay.look(l / ESC, t / ESC, (r - l) / ESC, (b - t) / ESC, label=f"{ACOES_JANELA[acao]} · {nome}")
        time.sleep(0.45)
    if acao in ("minimizar", "esconder"):
        win32gui.ShowWindow(hwnd, win32con.SW_MINIMIZE)
    elif acao == "restaurar":
        for h, _, _ in alvo:
            if win32gui.IsIconic(h):
                win32gui.ShowWindow(h, win32con.SW_RESTORE)
        _frente(hwnd)
    elif acao == "focar":
        _frente(hwnd)
    elif acao == "maximizar":
        win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE)
        _frente(hwnd)
    elif acao == "fechar":
        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
    elif acao == "tela_cheia":
        _frente(hwnd)
        time.sleep(0.2)
        _in.press("f11")
    elif acao == "outro_monitor":
        if len(_monitors()) < 2:
            return {"erro": "Só há um monitor."}
        _frente(hwnd)
        time.sleep(0.2)
        _in.press("win+shift+right")
    elif acao in ("esquerda", "direita"):
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        l, t, r, b = win32gui.GetWindowRect(hwnd)
        cx, cy = (l + r) // 2, (t + b) // 2
        mx, my, mw, mh = next((m for m in _monitors() if m[0] <= cx < m[0] + m[2] and m[1] <= cy < m[1] + m[3]), _monitors()[0])
        x = mx if acao == "esquerda" else mx + mw // 2
        win32gui.SetWindowPos(hwnd, 0, x, my, mw // 2, mh, win32con.SWP_NOZORDER)
        _frente(hwnd)
    overlay.hide()
    return {"ok": True, "app": nome, "feito": ACOES_JANELA[acao].lower()}
