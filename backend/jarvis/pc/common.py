"""Partes do controle do PC que são iguais no Windows e no Linux: teclado e mouse (pynput), captura de
tela (mss), nomes de atalhos e o "parar" da digitação. O Mac usa APIs próprias (Quartz) em mac_input.py."""

import io
import threading
import time
from typing import Any

MAX_TEXTO = 4000
cancel = threading.Event()  # Esc ou "Jarvis, espera": a digitação em curso para no próximo pedaço

# fecham app, apagam ou travam: só com confirmação
PERIGOSOS = {"cmd+q", "cmd+delete", "cmd+backspace", "cmd+shift+delete", "ctrl+alt+delete", "alt+f4", "ctrl+shift+esc",
             "ctrl+w+shift", "cmd+option+esc", "ctrl+cmd+q"}


def norm_combo(combo: str) -> str:
    return "+".join(p.strip().lower() for p in combo.replace(" ", "").split("+") if p.strip())


def jpeg(img_bgra: bytes, size: tuple[int, int], max_w: int = 1280) -> bytes | None:
    """BGRA (mss) → JPEG reduzido, para a Gemini ver."""
    try:
        from PIL import Image
    except ImportError:
        return None
    im = Image.frombytes("RGB", size, img_bgra, "raw", "BGRX")
    if im.width > max_w:
        im = im.resize((max_w, int(im.height * max_w / im.width)))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=80)
    return buf.getvalue()


def capture_mss(x: float, y: float, w: float, h: float, escala: float = 1.0) -> bytes | None:
    try:
        import mss
    except ImportError:
        return None
    if w < 8 or h < 8:
        return None
    with mss.mss() as sct:
        shot = sct.grab({"left": int(x * escala), "top": int(y * escala), "width": int(w * escala), "height": int(h * escala)})
        return jpeg(shot.bgra, shot.size)


class PynputInput:
    """Mouse e teclado por pynput (Windows e Linux/X11). "cmd" vira Ctrl fora do Mac."""

    def __init__(self) -> None:
        from pynput import keyboard, mouse

        self.k = keyboard
        self.kb = keyboard.Controller()
        self.ms = mouse.Controller()
        self.btn = mouse.Button

    def position(self) -> tuple[float, float]:
        x, y = self.ms.position
        return float(x), float(y)

    def move(self, x: float, y: float) -> None:
        self.ms.position = (int(x), int(y))

    def button(self, down: bool, x: float | None = None, y: float | None = None, direito: bool = False) -> None:
        if x is not None and y is not None:
            self.move(x, y)
        b = self.btn.right if direito else self.btn.left
        (self.ms.press if down else self.ms.release)(b)

    def click(self, x: float | None = None, y: float | None = None, duplo: bool = False, direito: bool = False) -> dict[str, Any]:
        if x is not None and y is not None:
            self.move(x, y)
        self.ms.click(self.btn.right if direito else self.btn.left, 2 if duplo else 1)
        return {"ok": True}

    def scroll(self, dy: int, dx: int = 0) -> None:
        self.ms.scroll(dx / 40, dy / 40)

    def type_text(self, texto: str) -> dict[str, Any]:
        texto = texto[:MAX_TEXTO]
        cancel.clear()
        feitos = 0
        for i in range(0, len(texto), 12):  # em pedaços: dá para ver digitando e dá para parar
            if cancel.is_set():
                return {"parado": True, "caracteres": feitos, "instrucao": "Ele mandou parar. Pergunte se continua."}
            parte = texto[i : i + 12]
            self.kb.type(parte)
            feitos += len(parte)
            time.sleep(0.01)
        return {"ok": True, "caracteres": len(texto)}

    def press(self, combo: str, confirmado: bool = False) -> dict[str, Any]:
        norm = norm_combo(combo)
        if norm in PERIGOSOS and not confirmado:
            return {"precisa_confirmar": True, "instrucao": f"O atalho {norm} pode fechar ou apagar algo. Pergunte antes e repita com confirmado=true."}
        K = self.k.Key
        nomes = {
            "cmd": K.ctrl, "command": K.ctrl, "ctrl": K.ctrl, "control": K.ctrl, "shift": K.shift, "alt": K.alt, "option": K.alt,
            "win": K.cmd, "super": K.cmd, "enter": K.enter, "return": K.enter, "tab": K.tab, "espaco": K.space, "space": K.space,
            "delete": K.delete, "backspace": K.backspace, "esc": K.esc, "escape": K.esc, "esquerda": K.left, "left": K.left,
            "direita": K.right, "right": K.right, "cima": K.up, "up": K.up, "baixo": K.down, "down": K.down, "home": K.home,
            "end": K.end, "pageup": K.page_up, "pagedown": K.page_down, **{f"f{i}": getattr(K, f"f{i}") for i in range(1, 13)},
        }
        teclas = [nomes.get(p, p) for p in norm.split("+")]
        for t in teclas:
            if isinstance(t, str) and len(t) != 1:
                return {"erro": f"Tecla desconhecida: {t}"}
        for t in teclas:
            self.kb.press(t)
        for t in reversed(teclas):
            self.kb.release(t)
        return {"ok": True, "atalho": norm}

    def media(self, acao: str) -> dict[str, Any]:
        K = self.k.Key
        tecla = {"tocar_pausar": K.media_play_pause, "proxima": K.media_next, "anterior": K.media_previous}.get(acao)
        if not tecla:
            return {"erro": f"Ação de mídia desconhecida: {acao}"}
        self.kb.press(tecla)
        self.kb.release(tecla)
        return {"ok": True}
