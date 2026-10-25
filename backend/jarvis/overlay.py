"""O que o Jarvis mostra na camada sobre a tela quando olha ou mexe em algo (a esfera voa até lá e
destaca a área), e o "parar" (Esc no app, botão Parar ou "Jarvis, espera")."""

import asyncio
import logging
import time

log = logging.getLogger("jarvis.overlay")

_loop: asyncio.AbstractEventLoop | None = None
ativo_em = 0.0  # última vez que o Jarvis mexeu no computador


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def _send(msg: dict) -> None:
    from .hub import hub

    if _loop:
        asyncio.run_coroutine_threadsafe(hub.broadcast(msg), _loop)


def look(x: float, y: float, w: float = 0, h: float = 0, label: str = "", modo: str = "agir") -> None:
    """A esfera vai até a área (pontos globais, topo à esquerda do monitor principal) e a destaca."""
    global ativo_em
    ativo_em = time.time()
    _send({"type": "olhar", "x": x, "y": y, "w": w, "h": h, "label": label, "modo": modo})


def at_front(rotulo: str = "") -> bool:
    """A esfera vai até a janela da frente (a faixa de cima, onde ficam título e abas). False se não achou."""
    from . import pc

    try:
        r = pc.front_rect()
    except Exception:  # noqa: BLE001
        r = None
    if not r:
        if rotulo:
            label(rotulo)
        return False
    x, y, w, h = r
    look(x, y, w, min(h, 160), label=rotulo)
    return True


def hide_later(segundos: float = 2.5) -> None:
    """Deixa a esfera um tempo no lugar (para dar para ver o que ele fez) e depois volta."""
    if _loop:
        _loop.call_soon_threadsafe(lambda: _loop.call_later(segundos, hide))


def point(x: float, y: float, label: str = "") -> None:
    look(x, y, 0, 0, label)


def label(text: str) -> None:
    global ativo_em
    ativo_em = time.time()
    _send({"type": "olhar.rotulo", "label": text})


def hide() -> None:
    _send({"type": "olhar.fim"})


def stop(origem: str = "voz") -> None:
    """Interrompe o que o Jarvis estiver fazendo no computador (digitação, plano em andamento)."""
    from . import pc
    from .live import voice

    pc.cancel.set()
    hide()
    log.info("ação no computador interrompida (%s)", origem)
    _send({"type": "parado", "origem": origem})
    if origem != "voz" and voice.session and _loop:
        aviso = "[Aviso do sistema, não é o usuário falando.] Ele mandou parar a tarefa no computador. Pare e pergunte em uma frase se continua."
        asyncio.run_coroutine_threadsafe(voice.send_text(aviso), _loop)
