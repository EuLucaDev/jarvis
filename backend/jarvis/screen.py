"""Espelho da tela: com ele ligado, o Jarvis vê a tela principal o tempo todo (como compartilhar a tela numa
chamada). Os quadros vão para a sessão de voz da Gemini a cada 2 s e para o painel "Visão · Tela" do HUD.

Liga e desliga por voz ("Jarvis, espelha minha tela") ou pelo botão do HUD. No Mac precisa da permissão de
Gravação de Tela para o "Jarvis".

Sem o espelho, a tela fica desligada, mas o Jarvis ainda vê quando precisa:
  - `foto(todas)`: a tela principal ou todos os monitores juntos, na hora ("veja minha tela", menu da palma);
  - `ao_falar()`: quando a pessoa começa a falar, uma foto da tela vai junto para a conversa, só se a tela mudou
    desde a última (e nunca com app de senhas ou de banco na frente). Sem aparecer no HUD.
"""

import asyncio
import logging
import threading
import time
from typing import Any

from .hub import hub

log = logging.getLogger("jarvis.screen")

PARA_GEMINI_S = 2.0  # um quadro a cada 2 s para a conversa (é o ritmo que a Gemini Live aceita bem)
AO_FALAR_S = 4.0  # no máximo uma foto por fala a cada tantos segundos
PRIVADOS = ("1password", "bitwarden", "keychain", "chaves", "senhas", "passwords", "lastpass", "dashlane", "keepass",
            "itaú", "itau", "bradesco", "nubank", "santander", "caixa", "banco", "inter&co", "sicredi", "sicoob")


def foto(todas: bool = False, max_w: int = 1600) -> bytes | None:
    """A tela agora: a principal ou a área de trabalho inteira (todos os monitores lado a lado)."""
    from . import pc

    x, y, w, h = pc.desktop_bounds() if todas else pc.main_bounds()
    return pc.capture(x, y, w, h, max_w if todas else 1280)


def _assinatura(jpeg: bytes) -> list[int] | None:
    """Miniatura cinza 32x18: duas telas "iguais" ficam com quase os mesmos números."""
    try:
        import io

        from PIL import Image

        im = Image.open(io.BytesIO(jpeg)).convert("L").resize((32, 18))
        return list(im.getdata())
    except Exception:  # noqa: BLE001
        return None


class Espelho:
    def __init__(self) -> None:
        self.on = False
        self.erro: str | None = None
        self.viewers = 0  # painéis mostrando o espelho (aí os quadros saem mais rápido)
        self._jpeg: bytes | None = None
        self._stop = threading.Event()
        self.loop: asyncio.AbstractEventLoop | None = None
        self._fala_em = 0.0
        self._fala_ass: list[int] | None = None

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

    async def ao_falar(self) -> None:
        """A pessoa começou a falar: a tela vai junto, se mudou (sem espelho e sem aparecer no HUD)."""
        from . import pc, store
        from .live import voice

        if self.on or not voice.session or time.monotonic() - self._fala_em < AO_FALAR_S:
            return
        if not (store.get("voz") or {}).get("ver_tela_ao_falar", True):
            return
        self._fala_em = time.monotonic()
        try:
            frente = (await asyncio.to_thread(pc.front_app) or "").lower()
            if any(p in frente for p in PRIVADOS):
                return
            img = await asyncio.to_thread(foto, False)
        except Exception as exc:  # noqa: BLE001
            log.debug("foto ao falar falhou: %s", exc)
            return
        if not img:
            return
        ass = _assinatura(img)
        if ass and self._fala_ass and sum(abs(a - b) for a, b in zip(ass, self._fala_ass)) / len(ass) < 3:
            return  # a tela é a mesma que ele já viu
        self._fala_ass = ass
        await voice.send_image(img)

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
