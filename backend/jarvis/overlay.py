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
