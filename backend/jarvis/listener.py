"""Ouvido em segundo plano: "Jarvis" e duas palmas, no próprio computador, sem internet.

- Palavra: Vosk com o modelo pequeno em português. "Jarvis" não está no vocabulário do modelo, mas "Jarbas"
  soa igual; "jantar" entra como isca para não confundir. Vale o resultado final da frase com confiança
  mínima (testado: "Jarvis…" dá 0,78 a 0,95; frases sem a palavra ficam abaixo de 0,6).
- Como o resultado sai no fim da frase, a frase inteira ("Jarvis, bom dia") vai junto para a Gemini.
- Palmas: dois estalos curtos bem acima do ruído de fundo, entre 0,15 e 0,75 s um do outro.
- Durante a conversa o ouvido não dispara (quem ouve é a sessão de voz).
"""

import asyncio
import json
import logging
import queue
import threading
import time

import numpy as np

from . import store
from .audio import IN_RATE, audio
from .config import CODE_ROOT
from .hub import hub

log = logging.getLogger("jarvis.listener")

MODELO = CODE_ROOT / "models" / "vosk-pt"
GRAMATICA = ["jarbas", "jantar", "[unk]"]

estado: dict = {"ativo": False, "erro": None}


class Ouvido:
    def __init__(self) -> None:
        self.q: queue.Queue[bytes] = queue.Queue(maxsize=200)
        self.loop: asyncio.AbstractEventLoop | None = None
        self.ruido = 0.01
        self.picos: list[float] = []
        self.ultimo_pico = 0.0
        self.cooldown = 0.0

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        audio.subscribe(self._on_mic)
        threading.Thread(target=self._fala, daemon=True, name="ouvido").start()

    def _on_mic(self, pcm: bytes) -> None:
        if from_voice_live():
            return
        self._palmas(pcm)
        try:
            self.q.put_nowait(pcm)
        except queue.Full:
            pass

    def _palmas(self, pcm: bytes) -> None:
        if not (store.get("despertar") or {}).get("palmas", True):
            return
        a = np.abs(np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768)
        if not a.size:
            return
        pico, media = float(a.max()), float(a.mean())
        agora = time.time()
        if pico > 0.3 and pico > self.ruido * 12 and media < pico * 0.35 and agora - self.ultimo_pico > 0.12:
            self.ultimo_pico = agora
            self.picos = [p for p in self.picos if agora - p < 0.9] + [agora]
            if len(self.picos) >= 2 and 0.15 < self.picos[-1] - self.picos[-2] < 0.75 and agora > self.cooldown:
                self.cooldown = agora + 2.5
                self.picos = []
                self._disparar("palmas")
        else:
            self.ruido = self.ruido * 0.98 + media * 0.02

    def _fala(self) -> None:
        try:
            import vosk
        except ImportError as exc:
            estado.update(ativo=False, erro=f"reconhecimento offline indisponível: {exc}")
            return
        if not MODELO.exists():
            estado.update(ativo=False, erro="modelo de voz offline não encontrado")
            return
        vosk.SetLogLevel(-1)
        modelo = vosk.Model(str(MODELO))
        rec = vosk.KaldiRecognizer(modelo, IN_RATE, json.dumps(GRAMATICA, ensure_ascii=False))
        rec.SetWords(True)
        estado.update(ativo=True, erro=None)
        log.info("ouvido em segundo plano no ar (Jarvis e palmas)")
        while True:
            pcm = self.q.get()
            if not rec.AcceptWaveform(pcm):
                continue
            cfg = store.get("despertar") or {}
            if not cfg.get("palavra", True) or from_voice_live():
                continue
            minimo = float(cfg.get("sensibilidade", 0.7))
            for w in json.loads(rec.Result()).get("result", []):
                if w["word"] == "jarbas" and w["conf"] >= minimo:
                    self._disparar("voz")
                    break

    def _disparar(self, origem: str) -> None:
        if self.loop:
            asyncio.run_coroutine_threadsafe(despertar(origem), self.loop)


def from_voice_live() -> bool:
    return hub.status.get("voice") in ("live", "connecting")


async def despertar(origem: str) -> None:
    """Ele chamou: o HUD aparece com a abertura e a conversa liga. Pela voz, a frase dita junto vai para a
    Gemini; nas palmas (ou só "Jarvis"), ele cumprimenta, e na primeira chamada da manhã abre com o bom dia."""
    from .live import voice

    if voice.live:
        return
    cfg = store.get("despertar") or {}
    p = store.get("presenca") or {}
    hoje = time.strftime("%Y-%m-%d")
    bom_dia = 5 <= int(time.strftime("%H")) < 12 and p.get("ultimo_briefing") != hoje and cfg.get("bom_dia", True)
    if bom_dia:
        store.put("presenca", {**p, "ultimo_briefing": hoje})
    log.info("despertar por %s", origem)
    await hub.broadcast({"type": "despertar", "origem": origem, "bom_dia": bom_dia})
    if origem == "voz":
        # a frase inteira ("Jarvis, abre o Notas") já está no microfone: vai junto, e a instrução vem como texto
        voice.pending_ask.append(
            "[Ativação] Ele te chamou pela voz agora. Se no áudio que você ouviu ele já pediu algo, faça; "
            + ("senão, dê bom dia e chame briefing_bom_dia." if bom_dia else "senão, cumprimente em uma frase curta.")
        )
        await voice.start(preroll=audio.recent(3.0))
    else:
        voice.pending_ask.append("Bom dia" if bom_dia else "[Ativação] Ele te chamou com palmas. Cumprimente em uma frase curta, pelo horário.")
        await voice.start()


ouvido = Ouvido()
