"""Controle do cursor do Jarvis (overlay_app.py roda à parte) e do "parar": Esc ou "Jarvis, espera"."""

import asyncio
import json
import logging
import subprocess
import sys
import threading
import time
from pathlib import Path

log = logging.getLogger("jarvis.overlay")

_proc: subprocess.Popen | None = None
_loop: asyncio.AbstractEventLoop | None = None
_lock = threading.Lock()
_ativo_em = 0.0  # última vez que o Jarvis mexeu no Mac; Esc só vale como "parar" logo depois disso


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def _start() -> subprocess.Popen | None:
    global _proc
    with _lock:
        if _proc and _proc.poll() is None:
            return _proc
        try:
            _proc = subprocess.Popen(
                [sys.executable, "-m", "jarvis.overlay_app"],
                cwd=Path(__file__).resolve().parents[1],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
            )
        except OSError as exc:
            log.warning("overlay não abriu: %s", exc)
            return None
        threading.Thread(target=_read, args=(_proc,), daemon=True).start()
        return _proc


def _read(p: subprocess.Popen) -> None:
    for line in p.stdout or []:
        if line.strip() == "esc" and time.time() - _ativo_em < 60:
            stop("Esc")


def _send(cmd: dict) -> None:
    p = _start()
    if not p or not p.stdin:
        return
    try:
        p.stdin.write(json.dumps(cmd) + "\n")
        p.stdin.flush()
    except (BrokenPipeError, OSError):
        pass


def _app_overlay() -> bool:
    """O app Jarvis (Electron) está aberto com a camada sobre a tela? Então a esfera faz a animação lá."""
    from .hub import hub

    return hub.count("overlay") > 0


def look(x: float, y: float, w: float = 0, h: float = 0, label: str = "", modo: str = "agir") -> None:
    """A esfera do Jarvis vai até um ponto/área da tela (coordenadas globais em pontos, topo à esquerda do
    monitor principal), destaca a área e mostra a etiqueta. Sem o app, cai no cursor AppKit."""
    global _ativo_em
    _ativo_em = time.time()
    if _app_overlay() and _loop:
        from .hub import hub

        msg = {"type": "olhar", "x": x, "y": y, "w": w, "h": h, "label": label, "modo": modo}
        asyncio.run_coroutine_threadsafe(hub.broadcast(msg), _loop)
        return
    _send({"cmd": "point", "x": x + w / 2, "y": y + h / 2, "label": label})


def point(x: float, y: float, label: str = "") -> None:
    look(x, y, 0, 0, label)


def label(text: str) -> None:
    global _ativo_em
    _ativo_em = time.time()
    if _app_overlay() and _loop:
        from .hub import hub

        asyncio.run_coroutine_threadsafe(hub.broadcast({"type": "olhar.rotulo", "label": text}), _loop)
        return
    _send({"cmd": "label", "text": text})


def hide() -> None:
    if _app_overlay() and _loop:
        from .hub import hub

        asyncio.run_coroutine_threadsafe(hub.broadcast({"type": "olhar.fim"}), _loop)
    if _proc and _proc.poll() is None:
        _send({"cmd": "hide"})


def stop(origem: str = "voz") -> None:
    """Interrompe o que o Jarvis estiver fazendo no Mac (digitação, plano em andamento)."""
    from . import desktop
    from .hub import hub

    desktop.cancel.set()
    hide()
    log.info("ação no Mac interrompida (%s)", origem)
    if _loop:
        asyncio.run_coroutine_threadsafe(hub.broadcast({"type": "parado", "origem": origem}), _loop)
        if origem != "voz" and hub.voice and hub.voice.session:
            # Esc ou botão: o modelo precisa saber, senão segue o plano como se nada tivesse acontecido
            aviso = "[Aviso do sistema, não é o usuário falando.] Ele apertou Esc para parar a tarefa no Mac. Pare e pergunte em uma frase se continua."
            asyncio.run_coroutine_threadsafe(hub.voice.send_text(aviso), _loop)


def close() -> None:
    if _proc and _proc.poll() is None:
        _proc.terminate()
