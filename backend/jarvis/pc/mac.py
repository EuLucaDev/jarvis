"""Mac: Quartz para mouse e teclado, Acessibilidade para janelas e contexto, screencapture para a tela.

As permissões (Acessibilidade, Gravação de Tela, câmera, microfone) ficam com o app Jarvis, que abre este
processo de dentro do pacote assinado.
"""

import shutil
import subprocess
from difflib import get_close_matches
from pathlib import Path
from typing import Any

from .mac_context import browser_url, look_at, replace_selection, selected_text, snapshot
from .mac_context import click as click_named
from .mac_input import (
    MAX_TEXTO,
    activate,
    browser,
    button,
    cancel,
    capture,
    click,
    front_app,
    front_is_jarvis,
    front_window_title,
    keys_into,
    main_bounds,
    move,
    pedir_permissao,
    permitido,
    position,
    press,
    scroll,
    type_into,
    type_text,
)
from .mac_windows import aim as win_aim
from .mac_windows import apps_abertos, controlar as janela_app
from .mac_windows import grab as win_grab
from .mac_windows import move as win_move
from .mac_windows import release as win_release
from .mac_windows import run as win_run
from .mac_windows import scale as win_scale
from .mac_windows import throw as win_throw

__all__ = [
    "MAX_TEXTO", "activate", "brightness", "browser", "browser_url", "button", "cancel", "capture", "click", "click_named",
    "clipboard_text", "front_app", "front_is_jarvis", "front_window_title", "keys_into", "lock_screen", "look_at",
    "main_bounds", "media", "move", "open_app", "open_link", "open_path", "pedir_permissao", "permitido", "position", "press",
    "replace_selection", "scroll", "selected_text", "snapshot", "type_into", "type_text", "volume", "win_aim", "win_grab",
    "win_move", "win_release", "win_run", "win_scale", "win_throw", "apps_abertos", "janela_app",
]


def _run(cmd: list[str], timeout: int = 15) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _apps() -> dict[str, str]:
    found: dict[str, str] = {}
    for base in ("/Applications", "/System/Applications", "/System/Applications/Utilities", str(Path.home() / "Applications")):
        p = Path(base)
        if p.exists():
            for app in p.glob("*.app"):
                found[app.stem.lower()] = app.stem
    return found


def open_app(nome: str) -> dict[str, Any]:
    apps = _apps()
    key = nome.lower().strip()
    match = apps.get(key) or next((v for k, v in apps.items() if key in k), None)
    if not match:
        close = get_close_matches(key, list(apps), n=1, cutoff=0.6)
        match = apps[close[0]] if close else None
    if not match:
        return {"erro": f"Não encontrei o app {nome}."}
    r = _run(["open", "-a", match])
    return {"ok": True, "app": match} if r.returncode == 0 else {"erro": r.stderr.strip()[:200]}


def open_link(url: str) -> dict[str, Any]:
    if not url.startswith(("http://", "https://")):
        url = "https://" + url.lstrip("/")
    _run(["open", url])
    return {"ok": True, "url": url}


def open_path(p: str) -> None:
    _run(["open", p])


def media(acao: str) -> dict[str, Any]:
    cmd = {"tocar_pausar": "playpause", "proxima": "next track", "anterior": "previous track"}.get(acao)
    if not cmd:
        return {"erro": "Ação de mídia desconhecida."}
    for app in ("Spotify", "Music"):
        if _run(["osascript", "-e", f'application "{app}" is running']).stdout.strip() == "true":
            _run(["osascript", "-e", f'tell application "{app}" to {cmd}'])
            return {"ok": True, "app": app}
    return {"erro": "Nenhum player aberto (Spotify ou Música)."}


def volume(nivel: int) -> dict[str, Any]:
    nivel = max(0, min(100, int(nivel)))
    _run(["osascript", "-e", f"set volume output volume {nivel}"])
    return {"ok": True, "volume": nivel}


def brightness(nivel: int) -> dict[str, Any]:
    if not shutil.which("brightness"):
        return {"erro": "Para mudar o brilho no Mac, instale o utilitário: brew install brightness"}
    nivel = max(5, min(100, int(nivel)))
    r = _run(["brightness", f"{nivel / 100:.2f}"])
    return {"ok": r.returncode == 0, "brilho": nivel}


def lock_screen() -> dict[str, Any]:
    _run(["pmset", "displaysleepnow"])
    return {"ok": True}


def clipboard_text() -> str:
    import AppKit

    return str(AppKit.NSPasteboard.generalPasteboard().stringForType_(AppKit.NSPasteboardTypeString) or "")


def set_clipboard(texto: str) -> None:
    import AppKit

    pb = AppKit.NSPasteboard.generalPasteboard()
    pb.clearContents()
    pb.setString_forType_(texto, AppKit.NSPasteboardTypeString)


__all__.append("set_clipboard")
