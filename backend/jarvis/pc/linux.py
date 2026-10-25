"""Linux (sessão X11): pynput para mouse e teclado, wmctrl/xdotool para janelas, mss para a tela,
xclip para a área de transferência, pactl/playerctl/brightnessctl para o sistema.

No Wayland o sistema não deixa um app mover janelas dos outros nem ler a tela livremente: mouse, teclado
e janelas ficam limitados (o Jarvis avisa em vez de falhar calado)."""

import difflib
import os
import shutil
import subprocess
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from .common import MAX_TEXTO, PynputInput, cancel, capture_mss

__all__ = [
    "MAX_TEXTO", "activate", "brightness", "browser", "browser_url", "button", "cancel", "capture", "click", "click_named",
    "clipboard_text", "front_app", "front_is_jarvis", "front_window_title", "keys_into", "lock_screen", "look_at",
    "main_bounds", "media", "move", "open_app", "open_link", "open_path", "pedir_permissao", "permitido", "position", "press",
    "replace_selection", "scroll", "selected_text", "set_clipboard", "snapshot", "type_into", "type_text", "volume",
    "win_aim", "win_grab", "win_move", "win_release", "win_run", "win_scale", "win_throw", "apps_abertos", "janela_app",
]

WAYLAND = os.getenv("XDG_SESSION_TYPE", "").lower() == "wayland"
try:
    _in: PynputInput | None = PynputInput()
except Exception:  # noqa: BLE001 - sem servidor gráfico (ou Wayland sem XWayland)
    _in = None


def _run(cmd: list[str], timeout: int = 8, entrada: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, input=entrada)


def _tem(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def permitido() -> bool:
    return _in is not None and not WAYLAND


def pedir_permissao() -> bool:
    return permitido()


def _sem() -> dict[str, Any]:
    return {"erro": "Nesta sessão do Linux (Wayland) o sistema não permite controlar outras janelas. Entre numa sessão X11 para usar isso."}


# ---------- mouse e teclado ----------


def position() -> tuple[float, float]:
    return _in.position() if _in else (0.0, 0.0)


def move(x: float, y: float) -> None:
    if _in:
        _in.move(x, y)


def button(down: bool, x: float | None = None, y: float | None = None, direito: bool = False) -> None:
    if _in:
        _in.button(down, x, y, direito)


def click(x: float | None = None, y: float | None = None, duplo: bool = False, direito: bool = False) -> dict[str, Any]:
    return _in.click(x, y, duplo, direito) if _in else _sem()


def scroll(dy: int, dx: int = 0) -> None:
    if _in:
        _in.scroll(dy, dx)


def type_text(texto: str) -> dict[str, Any]:
    return _in.type_text(texto) if _in else _sem()


def press(combo: str, confirmado: bool = False) -> dict[str, Any]:
    return _in.press(combo, confirmado) if _in else _sem()


def main_bounds() -> tuple[float, float, float, float]:
    try:
        import mss

        with mss.mss() as s:
            m = s.monitors[1]
            return float(m["left"]), float(m["top"]), float(m["width"]), float(m["height"])
    except Exception:  # noqa: BLE001
        return 0.0, 0.0, 1920.0, 1080.0


# ---------- apps ----------


def front_window_title() -> str:
    if _tem("xdotool"):
        return _run(["xdotool", "getactivewindow", "getwindowname"]).stdout.strip()
    return ""


def front_app() -> str:
    if _tem("xdotool"):
        pid = _run(["xdotool", "getactivewindow", "getwindowpid"]).stdout.strip()
        if pid.isdigit():
            try:
                return Path(f"/proc/{pid}/comm").read_text().strip()
            except OSError:
                pass
    return ""


def front_is_jarvis() -> bool:
    t = front_window_title().lower()
    return "j.a.r.v.i.s" in t or t.startswith("jarvis")


def _desktop_files() -> dict[str, str]:
    found: dict[str, str] = {}
    for base in ("/usr/share/applications", str(Path.home() / ".local/share/applications"), "/var/lib/flatpak/exports/share/applications"):
        for f in Path(base).glob("*.desktop") if Path(base).exists() else []:
            nome = f.stem
            for line in f.read_text(errors="ignore").splitlines():
                if line.startswith("Name="):
                    nome = line[5:]
                    break
            found[nome.lower()] = f.stem
    return found


def open_app(nome: str) -> dict[str, Any]:
    apps = _desktop_files()
    key = nome.lower().strip()
    hit = apps.get(key) or next((v for k, v in apps.items() if key in k), None)
    if not hit:
        close = difflib.get_close_matches(key, list(apps), n=1, cutoff=0.6)
        hit = apps[close[0]] if close else None
    if hit and _tem("gtk-launch"):
        subprocess.Popen(["gtk-launch", hit], start_new_session=True)  # noqa: S603, S607
        return {"ok": True, "app": hit}
    if shutil.which(key):
        subprocess.Popen([key], start_new_session=True)  # noqa: S603
        return {"ok": True, "app": key}
    return {"erro": f"Não encontrei o app {nome}."}


def open_link(url: str) -> dict[str, Any]:
    if not url.startswith(("http://", "https://")):
        url = "https://" + url.lstrip("/")
    webbrowser.open(url)
    return {"ok": True, "url": url}


def open_path(p: str) -> None:
    subprocess.Popen(["xdg-open", p], start_new_session=True)  # noqa: S603, S607


def activate(app: str) -> dict[str, Any]:
    if _tem("wmctrl"):
        r = _run(["wmctrl", "-a", app])
        if r.returncode == 0:
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
        return press(atalhos[acao])
    return {"erro": f"Ação de navegador desconhecida: {acao}"}


def browser_url(app: str) -> str | None:
    return None


def capture(x: float, y: float, w: float, h: float, max_w: int = 1280) -> bytes | None:
    return None if WAYLAND else capture_mss(x, y, w, h)


# ---------- janelas com a mão (wmctrl) ----------

_fila = ThreadPoolExecutor(1, thread_name_prefix="janelas")
_grab: dict[str, Any] | None = None


async def win_run(fn, *args):
    import asyncio

    return await asyncio.get_running_loop().run_in_executor(_fila, fn, *args)


def _windows() -> list[tuple[str, str, tuple[int, int, int, int]]]:
    """(id, título, retângulo) de cima para baixo, pela ordem de empilhamento do xprop."""
    if not _tem("wmctrl") or WAYLAND:
        return []
    linhas = _run(["wmctrl", "-lG"]).stdout.splitlines()
    janelas = {}
    for ln in linhas:
        p = ln.split(None, 7)
        if len(p) >= 8 and p[1] != "-1":
            wid, x, y, w, h, titulo = p[0], int(p[2]), int(p[3]), int(p[4]), int(p[5]), p[7]
            if "j.a.r.v.i.s" not in titulo.lower() and w > 80 and h > 60:
                janelas[int(wid, 16)] = (wid, titulo, (x, y, w, h))
    ordem = _run(["xprop", "-root", "_NET_CLIENT_LIST_STACKING"]).stdout if _tem("xprop") else ""
    ids = [int(t.strip().rstrip(","), 16) for t in ordem.split("#")[-1].split(",") if t.strip().startswith("0x")]
    out = [janelas[i] for i in reversed(ids) if i in janelas]
    return out or list(janelas.values())


def _to_px(nx: float, ny: float) -> tuple[int, int]:
    x0, y0, w, h = main_bounds()
    return int(x0 + nx * w), int(y0 + ny * h)


def _view(rect, titulo: str = "") -> dict[str, Any]:
    x, y, w, h = rect
    return {"x": x, "y": y, "w": w, "h": h, "app": "", "titulo": titulo}


def _at(px: int, py: int):
    return next(((wid, t, r) for wid, t, r in _windows() if r[0] <= px <= r[0] + r[2] and r[1] <= py <= r[1] + r[3]), None)


def win_aim(nx: float, ny: float) -> dict[str, Any] | None:
    hit = _at(*_to_px(nx, ny))
    return _view(hit[2], hit[1]) if hit else None


def win_grab(nx: float, ny: float) -> dict[str, Any]:
    global _grab
    if not permitido() or not _tem("wmctrl"):
        return {"erro": "Para mexer em janelas no Linux, instale o wmctrl (sudo apt install wmctrl xdotool) numa sessão X11."}
    px, py = _to_px(nx, ny)
    hit = _at(px, py)
    if not hit:
        return {"erro": "Nenhuma janela embaixo da mão."}
    wid, titulo, rect = hit
    _run(["wmctrl", "-i", "-r", wid, "-b", "remove,maximized_vert,maximized_horz"])
    _run(["wmctrl", "-i", "-a", wid])
    _grab = {"id": wid, "orig": rect, "dedo": (px, py), "titulo": titulo}
    return {"ok": True, **_view(rect, titulo)}


def _place(x: float, y: float, w: float, h: float) -> None:
    _run(["wmctrl", "-i", "-r", _grab["id"], "-e", f"0,{int(x)},{int(y)},{int(w)},{int(h)}"])


def win_move(nx: float, ny: float) -> dict[str, Any] | None:
    if not _grab:
        return None
    px, py = _to_px(nx, ny)
    ox, oy, w, h = _grab["orig"]
    x, y = ox + px - _grab["dedo"][0], max(0, oy + py - _grab["dedo"][1])
    _place(x, y, w, h)
    return _view((x, y, w, h), _grab["titulo"])


def win_scale(f: float) -> dict[str, Any] | None:
    if not _grab:
        return None
    ox, oy, w, h = _grab["orig"]
    bx, by, bw, bh = main_bounds()
    nw, nh = min(bw, max(400, w * f)), min(bh, max(280, h * f))
    x = min(max(bx, ox + w / 2 - nw / 2), bx + bw - nw)
    y = min(max(by, oy + h / 2 - nh / 2), by + bh - nh)
    _place(x, y, nw, nh)
    return _view((x, y, nw, nh), _grab["titulo"])


def win_throw(direcao: str) -> dict[str, Any]:
    if not _grab:
        return {"erro": "Nenhuma janela segura."}
    try:
        import mss

        with mss.mss() as s:
            telas = sorted((m["left"], m["top"], m["width"], m["height"]) for m in s.monitors[1:])
    except Exception:  # noqa: BLE001
        return {"erro": "Não consegui ler os monitores."}
    x, y, w, h = _grab["orig"]
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
    return {"ok": True, **_view((nx, ny, nw, nh), _grab["titulo"])}


def win_release(cancelar: bool = False) -> dict[str, Any] | None:
    global _grab
    if not _grab:
        return None
    if cancelar:
        _place(*_grab["orig"])
    out = _view(_grab["orig"], _grab["titulo"])
    _grab = None
    return out


# ---------- contexto ----------


def clipboard_text() -> str:
    if _tem("xclip"):
        return _run(["xclip", "-selection", "clipboard", "-o"]).stdout
    return ""


def set_clipboard(texto: str) -> None:
    if _tem("xclip"):
        _run(["xclip", "-selection", "clipboard"], entrada=texto)


def selected_text(copiar: bool = True) -> str:
    if _tem("xclip"):
        return _run(["xclip", "-selection", "primary", "-o"]).stdout  # no X11 a seleção já fica disponível
    return ""


def replace_selection(texto: str) -> dict[str, Any]:
    if not _tem("xclip"):
        return {"erro": "Instale o xclip (sudo apt install xclip) para o Jarvis trocar o texto selecionado."}
    antes = clipboard_text()
    set_clipboard(texto[:MAX_TEXTO])
    press("ctrl+v")
    time.sleep(0.4)
    if antes:
        set_clipboard(antes)
    return {"ok": True}


def click_named(alvo: str) -> dict[str, Any]:
    return {"erro": "Clicar pelo nome ainda não está disponível no Linux. Peça para eu olhar a tela e use a mão ou o mouse."}


def look_at(regiao: str | None = None, alvo: str | None = None, label: str = "Estou vendo") -> dict[str, Any]:
    from .. import overlay

    bx, by, bw, bh = main_bounds()
    area = (bx, by, bw, bh)
    overlay.look(*area, label, "olhar")
    out: dict[str, Any] = {"app": front_app(), "janela": front_window_title(), "area": regiao or "tela"}
    img = capture(*area)
    if img:
        out["_imagem"] = img
        out["instrucao"] = "Você recebeu a imagem da tela. Diga que está vendo e o que percebe, curto."
    return out


def snapshot(pointed: dict[str, Any] | None = None, com_selecao: bool = True) -> dict[str, Any]:
    out: dict[str, Any] = {"app": front_app(), "janela": front_window_title()}
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
    if _tem("pactl"):
        _run(["pactl", "set-sink-volume", "@DEFAULT_SINK@", f"{nivel}%"])
        return {"ok": True, "volume": nivel}
    if _tem("amixer"):
        _run(["amixer", "set", "Master", f"{nivel}%"])
        return {"ok": True, "volume": nivel}
    return {"erro": "Sem pactl/amixer para mudar o volume."}


def media(acao: str) -> dict[str, Any]:
    cmd = {"tocar_pausar": "play-pause", "proxima": "next", "anterior": "previous"}.get(acao)
    if cmd and _tem("playerctl"):
        _run(["playerctl", cmd])
        return {"ok": True}
    return _in.media(acao) if _in else {"erro": "Sem playerctl."}


def brightness(nivel: int) -> dict[str, Any]:
    nivel = max(5, min(100, int(nivel)))
    if _tem("brightnessctl"):
        _run(["brightnessctl", "set", f"{nivel}%"])
        return {"ok": True, "brilho": nivel}
    return {"erro": "Instale o brightnessctl para mudar o brilho."}


def lock_screen() -> dict[str, Any]:
    for cmd in (["loginctl", "lock-session"], ["xdg-screensaver", "lock"]):
        if _tem(cmd[0]):
            _run(cmd)
            return {"ok": True}
    return {"erro": "Não achei como bloquear a tela neste Linux."}


# ---------- janelas de qualquer app por voz (wmctrl/xdotool) ----------


def _janelas_apps() -> list[tuple[str, str, str]]:
    """(id, app, título) de todas as janelas, pela classe (WM_CLASS) de cada uma."""
    if not _tem("wmctrl") or WAYLAND:
        return []
    out = []
    for ln in _run(["wmctrl", "-lx"]).stdout.splitlines():
        p = ln.split(None, 4)
        if len(p) >= 5 and p[1] != "-1" and "j.a.r.v.i.s" not in p[4].lower():
            classe = p[2].split(".")[-1] if "." in p[2] else p[2]
            out.append((p[0], classe, p[4]))
    return out


def apps_abertos() -> list[str]:
    return sorted({a for _, a, _ in _janelas_apps()})


def _telas() -> list[tuple[int, int, int, int]]:
    try:
        import mss

        with mss.mss() as s:
            return sorted((m["left"], m["top"], m["width"], m["height"]) for m in s.monitors[1:])
    except Exception:  # noqa: BLE001
        return []


def janela_app(pedido: str, acao: str, confirmado: bool = False) -> dict[str, Any]:
    """Minimizar, fechar, maximizar, metade da tela, outro monitor… numa janela do app pedido (ou do da frente)."""
    from .. import overlay
    from .common import ACOES_JANELA, escolher_app

    if acao not in ACOES_JANELA:
        return {"erro": f"Ação desconhecida: {acao}."}
    if WAYLAND or not _tem("wmctrl"):
        return {"erro": "Para mexer em janelas no Linux, use uma sessão X11 com wmctrl e xdotool (sudo apt install wmctrl xdotool)."}
    janelas = _janelas_apps()
    frente = ""
    if _tem("xdotool"):
        ativo = _run(["xdotool", "getactivewindow"]).stdout.strip()
        frente = next((a for w, a, _ in janelas if ativo and int(w, 16) == int(ativo)), "")
    nome = escolher_app(pedido, [a for _, a, _ in janelas], frente)
    alvo = [j for j in janelas if j[1] == nome] or ([j for j in janelas if pedido and pedido.lower() in j[2].lower()])
    if not alvo:
        return {"erro": f"Não achei '{pedido}' aberto.", "apps_abertos": ", ".join(apps_abertos()[:25])}
    nome = alvo[0][1]
    wid = alvo[0][0]
    if acao == "sair":
        if not confirmado:
            return {"precisa_confirmar": True, "instrucao": f"Pergunte se pode fechar o {nome} inteiro (algo não salvo pode pedir para salvar)."}
        for w, _, _ in alvo:
            _run(["wmctrl", "-i", "-c", w])
        return {"ok": True, "app": nome, "feito": "fechado"}
    geo = next((r for i, _, r in _windows() if i == wid), None)
    if geo:
        overlay.look(*geo, label=f"{ACOES_JANELA[acao]} · {nome}")
        time.sleep(0.45)
    if acao in ("minimizar", "esconder"):
        _run(["xdotool", "windowminimize", str(int(wid, 16))])
    elif acao in ("restaurar", "focar"):
        _run(["wmctrl", "-i", "-a", wid])
    elif acao == "maximizar":
        _run(["wmctrl", "-i", "-r", wid, "-b", "add,maximized_vert,maximized_horz"])
        _run(["wmctrl", "-i", "-a", wid])
    elif acao == "tela_cheia":
        _run(["wmctrl", "-i", "-r", wid, "-b", "toggle,fullscreen"])
    elif acao == "fechar":
        _run(["wmctrl", "-i", "-c", wid])
    elif acao in ("esquerda", "direita", "outro_monitor"):
        telas = _telas()
        if not telas or not geo:
            return {"erro": "Não consegui ler os monitores."}
        cx = geo[0] + geo[2] / 2
        i = next((k for k, t in enumerate(telas) if t[0] <= cx < t[0] + t[2]), 0)
        if acao == "outro_monitor":
            if len(telas) < 2:
                return {"erro": "Só há um monitor."}
            t = telas[(i + 1) % len(telas)]
            x, y, w, h = t[0] + 40, t[1] + 40, min(geo[2], t[2] - 80), min(geo[3], t[3] - 80)
        else:
            t = telas[i]
            x, y, w, h = (t[0] if acao == "esquerda" else t[0] + t[2] // 2), t[1], t[2] // 2, t[3]
        _run(["wmctrl", "-i", "-r", wid, "-b", "remove,maximized_vert,maximized_horz"])
        _run(["wmctrl", "-i", "-r", wid, "-e", f"0,{x},{y},{w},{h}"])
        _run(["wmctrl", "-i", "-a", wid])
    overlay.hide()
    return {"ok": True, "app": nome, "feito": ACOES_JANELA[acao].lower()}
