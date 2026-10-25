"""Controle do computador à vista: mouse, teclado e navegador, como se o Luca estivesse mexendo.

Tudo acontece na tela (ele vê o Jarvis trabalhando) e passa pelo macOS, que exige a permissão de
Acessibilidade para o Python do serviço (Ajustes do Sistema → Privacidade e Segurança → Acessibilidade).

Limites: nada de comando de terminal. Atalhos perigosos (fechar app, apagar, forçar saída) pedem
confirmação, como as outras ações destrutivas do Jarvis.
"""

import logging
import subprocess
import threading
import time
from typing import Any

import Quartz
from ApplicationServices import AXIsProcessTrusted

log = logging.getLogger("jarvis.desktop")

MAX_TEXTO = 4000
# Esc (pelo cursor do Jarvis) ou "Jarvis, espera": a digitação em curso para no próximo pedaço
cancel = threading.Event()

# códigos de tecla do macOS (teclado ABNT/US: as letras saem pelo unicode, aqui só as especiais)
KEYS = {
    "enter": 36, "return": 36, "tab": 48, "espaco": 49, "space": 49, "delete": 51, "backspace": 51,
    "esc": 53, "escape": 53, "esquerda": 123, "left": 123, "direita": 124, "right": 124,
    "baixo": 125, "down": 125, "cima": 126, "up": 126, "home": 115, "end": 119,
    "pageup": 116, "pagedown": 121, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34, "j": 38, "k": 40, "l": 37,
    "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13,
    "x": 7, "y": 16, "z": 6, "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26,
    "8": 28, "9": 25, "-": 27, "=": 24, "[": 33, "]": 30, ";": 41, "'": 39, ",": 43, ".": 47, "/": 44,
}
MODS = {
    "cmd": Quartz.kCGEventFlagMaskCommand, "command": Quartz.kCGEventFlagMaskCommand,
    "shift": Quartz.kCGEventFlagMaskShift, "alt": Quartz.kCGEventFlagMaskAlternate,
    "option": Quartz.kCGEventFlagMaskAlternate, "ctrl": Quartz.kCGEventFlagMaskControl,
    "control": Quartz.kCGEventFlagMaskControl, "fn": Quartz.kCGEventFlagMaskSecondaryFn,
}
# fecham app, apagam ou travam: só com confirmação
PERIGOSOS = {"cmd+q", "cmd+delete", "cmd+backspace", "cmd+shift+delete", "cmd+option+esc", "cmd+alt+esc", "cmd+shift+q", "ctrl+cmd+q"}


def permitido() -> bool:
    return bool(AXIsProcessTrusted())


def pedir_permissao() -> bool:
    """Faz o macOS pôr o Python do serviço na lista de Acessibilidade e abre a tela para ligar."""
    from ApplicationServices import AXIsProcessTrustedWithOptions, kAXTrustedCheckOptionPrompt

    ok = bool(AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: True}))
    if not ok:
        subprocess.run(["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"], capture_output=True)
    return ok


def _sem_permissao() -> dict[str, Any]:
    return {
        "erro": "Sem permissão de Acessibilidade para controlar o Mac. Libere o Python do Jarvis em Ajustes do "
        "Sistema → Privacidade e Segurança → Acessibilidade e reinicie o serviço pelo painel."
    }


def _post(ev) -> None:
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)


def capture(x: float, y: float, w: float, h: float, max_w: int = 1280) -> bytes | None:
    """Foto de uma área da tela (JPEG) para a Gemini ver. Precisa da permissão de Gravação de Tela."""
    import tempfile

    if w < 8 or h < 8:
        return None
    with tempfile.TemporaryDirectory() as d:
        f = f"{d}/area.jpg"
        r = subprocess.run(["screencapture", "-x", "-t", "jpg", "-R", f"{int(x)},{int(y)},{int(w)},{int(h)}", f], capture_output=True, timeout=10)
        if r.returncode != 0:
            return None
        subprocess.run(["sips", "-Z", str(max_w), f], capture_output=True, timeout=10)
        try:
            with open(f, "rb") as fh:
                data = fh.read()
        except OSError:
            return None
    return data if len(data) > 2000 else None


def screen_bounds() -> tuple[float, float, float, float]:
    """União de todos os monitores, em pontos (x, y, largura, altura), origem no canto do principal."""
    err, ids, n = Quartz.CGGetActiveDisplayList(16, None, None)
    rects = [Quartz.CGDisplayBounds(i) for i in ids[:n]] or [Quartz.CGDisplayBounds(Quartz.CGMainDisplayID())]
    x0 = min(r.origin.x for r in rects)
    y0 = min(r.origin.y for r in rects)
    x1 = max(r.origin.x + r.size.width for r in rects)
    y1 = max(r.origin.y + r.size.height for r in rects)
    return x0, y0, x1 - x0, y1 - y0


def main_bounds() -> tuple[float, float, float, float]:
    r = Quartz.CGDisplayBounds(Quartz.CGMainDisplayID())
    return r.origin.x, r.origin.y, r.size.width, r.size.height


def position() -> tuple[float, float]:
    p = Quartz.CGEventGetLocation(Quartz.CGEventCreate(None))
    return p.x, p.y


# ---------- mouse ----------

_down = False


def move(x: float, y: float) -> None:
    kind = Quartz.kCGEventLeftMouseDragged if _down else Quartz.kCGEventMouseMoved
    _post(Quartz.CGEventCreateMouseEvent(None, kind, (x, y), Quartz.kCGMouseButtonLeft))


def button(down: bool, x: float | None = None, y: float | None = None, direito: bool = False) -> None:
    global _down
    if x is None or y is None:
        x, y = position()
    if direito:
        kind = Quartz.kCGEventRightMouseDown if down else Quartz.kCGEventRightMouseUp
        btn = Quartz.kCGMouseButtonRight
    else:
        kind = Quartz.kCGEventLeftMouseDown if down else Quartz.kCGEventLeftMouseUp
        btn = Quartz.kCGMouseButtonLeft
        _down = down
    _post(Quartz.CGEventCreateMouseEvent(None, kind, (x, y), btn))


def click(x: float | None = None, y: float | None = None, duplo: bool = False, direito: bool = False) -> dict[str, Any]:
    if not permitido():
        return _sem_permissao()
    if x is not None and y is not None:
        move(x, y)
    for i in range(2 if duplo else 1):
        if duplo:
            # o macOS conta o clique duplo pelo campo de contagem do evento
            px, py = position()
            for down in (True, False):
                kind = Quartz.kCGEventLeftMouseDown if down else Quartz.kCGEventLeftMouseUp
                ev = Quartz.CGEventCreateMouseEvent(None, kind, (px, py), Quartz.kCGMouseButtonLeft)
                Quartz.CGEventSetIntegerValueField(ev, Quartz.kCGMouseEventClickState, i + 1)
                _post(ev)
        else:
            button(True, x, y, direito)
            time.sleep(0.03)
            button(False, x, y, direito)
    return {"ok": True}


def scroll(dy: int, dx: int = 0) -> None:
    _post(Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitPixel, 2, int(dy), int(dx)))


# ---------- teclado ----------


def type_text(texto: str) -> dict[str, Any]:
    """Digita como teclado (aparece letra a letra no app da frente). Acentos e emoji vão pelo unicode."""
    if not permitido():
        return _sem_permissao()
    texto = texto[:MAX_TEXTO]
    cancel.clear()
    feitos = 0
    for linha_i, linha in enumerate(texto.split("\n")):
        if linha_i:
            press("enter")
        for i in range(0, len(linha), 16):  # em pedaços: rápido, mas ainda dá para ver digitando
            if cancel.is_set():
                return {"parado": True, "caracteres": feitos, "instrucao": "Ele mandou parar. Pergunte se continua."}
            parte = linha[i : i + 16]
            feitos += len(parte)
            for down in (True, False):
                ev = Quartz.CGEventCreateKeyboardEvent(None, 0, down)
                Quartz.CGEventKeyboardSetUnicodeString(ev, len(parte.encode("utf-16-le")) // 2, parte)
                _post(ev)
            time.sleep(0.012)
    return {"ok": True, "caracteres": len(texto)}


def press(combo: str, confirmado: bool = False) -> dict[str, Any]:
    """Tecla ou atalho: 'enter', 'cmd+t', 'cmd+shift+n'."""
    if not permitido():
        return _sem_permissao()
    norm = "+".join(p.strip().lower() for p in combo.replace(" ", "").split("+") if p.strip())
    if norm in PERIGOSOS and not confirmado:
        return {"precisa_confirmar": True, "instrucao": f"O atalho {norm} pode fechar ou apagar algo. Pergunte antes e repita com confirmado=true."}
    partes = norm.split("+")
    flags = 0
    for p in partes[:-1]:
        if p not in MODS:
            return {"erro": f"Modificador desconhecido: {p}"}
        flags |= MODS[p]
    tecla = partes[-1]
    code = KEYS.get(tecla)
    if code is None:
        return {"erro": f"Tecla desconhecida: {tecla}"}
    for down in (True, False):
        ev = Quartz.CGEventCreateKeyboardEvent(None, code, down)
        Quartz.CGEventSetFlags(ev, flags)
        _post(ev)
    return {"ok": True, "atalho": norm}


# ---------- apps e navegador ----------


def _osa(script: str, timeout: int = 8) -> subprocess.CompletedProcess:
    return subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=timeout)


def activate(app: str) -> dict[str, Any]:
    """Traz o app para a frente (abre se estiver fechado) antes de digitar nele."""
    r = subprocess.run(["open", "-a", app], capture_output=True, text=True)
    if r.returncode != 0:
        return {"erro": f"Não encontrei o app {app}."}
    time.sleep(0.6)
    return {"ok": True}


def front_app() -> str:
    r = _osa('tell application "System Events" to get name of first application process whose frontmost is true')
    return r.stdout.strip()


def front_window_title() -> str:
    r = _osa(
        'tell application "System Events" to tell (first application process whose frontmost is true) '
        'to if (count of windows) > 0 then get name of front window'
    )
    return r.stdout.strip()


def _show_at_focus(label: str) -> None:
    """Leva o cursor do Jarvis até o campo onde ele vai escrever."""
    from . import overlay

    try:
        from . import context

        nome, pid = context.front()
        foco = context._get(context._app_el(pid, nome), "AXFocusedUIElement")
        fr = context._frame(foco) if foco is not None else None
        if fr:
            overlay.look(fr[0], fr[1], min(fr[2], 600), min(fr[3], 200), label)
            time.sleep(0.9)  # a esfera chega antes de começar a digitar
            return
    except Exception:  # noqa: BLE001 - cursor é enfeite; não pode travar a ação
        pass
    x, y = position()
    overlay.point(x + 30, y + 30, label)


def front_is_jarvis() -> bool:
    """A janela da frente é o próprio HUD/painel do Jarvis? Aí digitar cairia nele mesmo."""
    r = _osa(
        'tell application "System Events" to tell (first application process whose frontmost is true) '
        'to if (count of windows) > 0 then get name of front window'
    )
    titulo = r.stdout.strip().lower()
    return "j.a.r.v.i.s" in titulo or titulo.startswith("jarvis ·") or "localhost:8000" in titulo


def type_into(texto: str, app: str | None = None, enter: bool = False) -> dict[str, Any]:
    """Digita no app pedido (ou no da frente), à vista."""
    if not permitido():
        return _sem_permissao()
    if app:
        r = activate(app)
        if r.get("erro"):
            return r
    if front_is_jarvis():
        return {"erro": "A janela da frente é o próprio Jarvis. Diga em qual app escrever (ex.: Notas, Chrome, Mail)."}
    _show_at_focus("Escrevendo")
    res = type_text(texto)
    if enter and res.get("ok"):
        press("enter")
    return {**res, "app": app or front_app()}


def keys_into(combo: str, app: str | None = None, confirmado: bool = False) -> dict[str, Any]:
    if not permitido():
        return _sem_permissao()
    if app:
        r = activate(app)
        if r.get("erro"):
            return r
    if front_is_jarvis():
        return {"erro": "A janela da frente é o próprio Jarvis. Diga em qual app usar o atalho."}
    _show_at_focus(combo.replace("cmd", "⌘").replace("shift", "⇧").replace("+", " "))
    return {**press(combo, confirmado), "app": app or front_app()}


def browser(acao: str, valor: str = "") -> dict[str, Any]:
    """Navegador padrão do Luca (Chrome normal, não o perfil do HUD): nova aba, buscar, voltar…"""
    from urllib.parse import quote_plus

    if acao in ("nova_aba", "abrir"):
        url = valor.strip() or "about:blank"
        if url and "://" not in url and "." in url and " " not in url:
            url = "https://" + url
        elif url and "://" not in url and url != "about:blank":
            url = "https://www.google.com/search?q=" + quote_plus(url)
        # o open usa o navegador padrão; o HUD roda num perfil separado e não é afetado
        subprocess.run(["open", url], capture_output=True)
        return {"ok": True, "url": url}
    if acao == "buscar":
        subprocess.run(["open", "https://www.google.com/search?q=" + quote_plus(valor)], capture_output=True)
        return {"ok": True}
    atalhos = {"fechar_aba": "cmd+w", "voltar": "cmd+[", "avancar": "cmd+]", "recarregar": "cmd+r", "proxima_aba": "ctrl+tab"}
    if acao in atalhos:
        # atalhos vão para o navegador da frente; se a frente for o HUD, recusa (fecharia o próprio Jarvis)
        if front_is_jarvis():
            return {"erro": "A janela da frente é o Jarvis. Abra o navegador primeiro."}
        return press(atalhos[acao])
    return {"erro": f"Ação de navegador desconhecida: {acao}"}
