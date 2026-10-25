"""Espelho da tela: com ele ligado, o Jarvis vê a tela principal o tempo todo (como compartilhar a tela numa
chamada). Os quadros vão para a sessão de voz da Gemini a cada 2 s e para o painel "Visão · Tela" do HUD.

Liga e desliga por voz ("Jarvis, espelha minha tela") ou pelo botão do HUD. No Mac precisa da permissão de
Gravação de Tela para o "Jarvis".
"""

import asyncio
import logging
import threading
import time
from typing import Any

from .hub import hub

log = logging.getLogger("jarvis.screen")

PARA_GEMINI_S = 2.0  # um quadro a cada 2 s para a conversa (é o ritmo que a Gemini Live aceita bem)


class Espelho:
    def __init__(self) -> None:
        self.on = False
        self.erro: str | None = None
        self.viewers = 0  # painéis mostrando o espelho (aí os quadros saem mais rápido)
        self._jpeg: bytes | None = None
        self._stop = threading.Event()
        self.loop: asyncio.AbstractEventLoop | None = None

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop

    def latest(self) -> bytes | None:
        return self._jpeg

    def estado(self) -> dict[str, Any]:
        return {"type": "tela", "ligada": self.on, "erro": self.erro}

    def _emit(self, msg: dict[str, Any]) -> None:
        if self.loop:
            asyncio.run_coroutine_threadsafe(hub.broadcast(msg), self.loop)

    def start(self) -> None:
        if self.on:
            self._emit(self.estado())
            return
        self.on, self.erro = True, None
        self._stop.clear()
        threading.Thread(target=self._run, daemon=True, name="espelho").start()
        self._emit(self.estado())
        log.info("espelho da tela ligado")

    def stop(self) -> None:
        self._stop.set()
        self.on = False
        self._jpeg = None
        self._emit(self.estado())
        log.info("espelho da tela desligado")

    def _run(self) -> None:
        from . import pc
        from .live import voice

        ultimo_envio = 0.0
        falhas = 0
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                x, y, w, h = pc.main_bounds()
                img = pc.capture(x, y, w, h, 1280)
            except Exception as exc:  # noqa: BLE001
                img = None
                log.warning("captura da tela falhou: %s", exc)
            if not img:
                falhas += 1
                if falhas >= 3:
                    self.erro = "Não consegui ver a tela. No Mac, libere Gravação de Tela para o Jarvis nos Ajustes."
                    self.on = False
                    self._emit(self.estado())
                    return
            else:
                falhas = 0
                self._jpeg = img
                if voice.session and self.loop and t0 - ultimo_envio >= PARA_GEMINI_S:
                    ultimo_envio = t0
                    asyncio.run_coroutine_threadsafe(voice.send_image(img), self.loop)
            pausa = (0.5 if self.viewers else PARA_GEMINI_S) - (time.monotonic() - t0)
            if pausa > 0:
                self._stop.wait(pausa)


espelho = Espelho()
