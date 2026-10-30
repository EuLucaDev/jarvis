"""Microfone e alto-falante do Jarvis (sounddevice/PortAudio), iguais no Mac, Windows e Linux.

- Microfone sempre aberto a 16 kHz mono: alimenta o ouvido ("Jarvis" e palmas) e, durante a conversa, a Gemini.
  Guarda os últimos 3 s, para a frase dita junto com "Jarvis" não se perder enquanto a conversa conecta.
- Alto-falante a 24 kHz: toca a voz da Gemini numa fila; conta o que já tocou, para a legenda andar junto.
- Nível de entrada e de saída (0..1) para a esfera e o espectro.
- Efeito "HUD" na voz (ajuste "voz", campo efeito; padrão ligado): leve corte de graves e agudos, um brilho metálico
  curto e um eco de 18 ms, como a voz do J.A.R.V.I.S. dos filmes. Tudo em numpy, sem atraso perceptível.
"""

import collections
import logging
import threading
import time
from collections.abc import Callable

import numpy as np

log = logging.getLogger("jarvis.audio")

IN_RATE = 16000
OUT_RATE = 24000
BLOCK = 512  # 32 ms de microfone por pedaço
_CAUDA = 640  # amostras do pedaço anterior que o efeito precisa (o eco mais longo é 430)


class EfeitoHUD:
    """Voz "de filme" vetorizada: cada pedaço usa a cauda do anterior, então não há emendas audíveis."""

    def __init__(self) -> None:
        self.cauda = np.zeros(_CAUDA, np.float32)
        self.media_ant = np.zeros(63, np.float32)

    def __call__(self, pcm: bytes) -> bytes:
        x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768
        if x.size == 0:
            return pcm
        ext = np.concatenate([self.cauda, x])
        n, c = x.size, _CAUDA
        lp = np.convolve(ext, np.array([0.25, 0.5, 0.25], np.float32), "same")  # tira o chiado de cima
        caixa = np.convolve(ext, np.full(64, 1 / 64, np.float32), "same")  # graves (média de ~2,7 ms)
        y = lp[c:] - 0.55 * caixa[c:]  # menos grave: voz de rádio, sem ficar fina
        y += 0.16 * ext[c - 72 : c - 72 + n]  # brilho metálico (3 ms)
        y += 0.11 * ext[c - 430 : c - 430 + n]  # espaço (18 ms)
        y = np.tanh(1.5 * y) / np.tanh(1.5) * 0.92
        self.cauda = ext[-c:].copy()
        return (np.clip(y, -1, 1) * 32767).astype(np.int16).tobytes()


def _efeito_ligado() -> bool:
    try:
        from . import store

        return (store.get("voz") or {}).get("efeito", "hud") == "hud"
    except Exception:  # noqa: BLE001
        return False


class AudioIO:
    def __init__(self) -> None:
        self._subs: list[Callable[[bytes], None]] = []
        self._out = bytearray()
        self._lock = threading.Lock()
        self.queued = 0  # amostras de saída já enfileiradas desde o início
        self.played = 0  # amostras de saída já tocadas
        self.level_in = 0.0
        self.level_out = 0.0
        self.last_out = 0.0  # quando tocou voz pela última vez
        self.ring: collections.deque[bytes] = collections.deque(maxlen=int(3 * IN_RATE / BLOCK))
        self.erro: str | None = None
        self._in = None
        self._outs = None
        self._efeito = EfeitoHUD()
        self._efeito_em = 0.0
        self._efeito_on = True

    # ---------- entrada ----------

    def subscribe(self, fn: Callable[[bytes], None]) -> None:
        self._subs.append(fn)

    def _on_in(self, data, frames, t, status) -> None:
        pcm = bytes(data)
        a = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768
        lvl = float(min(1.0, np.sqrt(np.mean(a * a)) * 6)) if a.size else 0.0
        self.level_in += (lvl - self.level_in) * (0.5 if lvl > self.level_in else 0.15)
        self.ring.append(pcm)
        for fn in self._subs:
            try:
                fn(pcm)
            except Exception:  # noqa: BLE001 - um ouvinte com erro não pode calar o microfone
                log.exception("ouvinte do microfone falhou")

    def recent(self, segundos: float) -> bytes:
        n = int(segundos * IN_RATE / BLOCK)
        return b"".join(list(self.ring)[-n:]) if n > 0 else b""

    # ---------- saída ----------

    def enqueue(self, pcm: bytes) -> None:
        if self._outs is None:
            return  # sem alto-falante: não acumula (a legenda segue sem esperar o áudio)
        if time.time() - self._efeito_em > 5:  # o ajuste é relido de vez em quando, não a cada pedaço
            self._efeito_em = time.time()
            self._efeito_on = _efeito_ligado()
        if self._efeito_on:
            pcm = self._efeito(pcm)
        with self._lock:
            self._out.extend(pcm)
            self.queued += len(pcm) // 2

    def flush(self) -> None:
        with self._lock:
            self.played += len(self._out) // 2
            self._out.clear()

    def playing(self) -> bool:
        with self._lock:
            return len(self._out) > 0 or time.time() - self.last_out < 0.25

    def _on_out(self, outdata, frames, t, status) -> None:
        need = frames * 2
        with self._lock:
            chunk = bytes(self._out[:need])
            del self._out[:need]
        if chunk:
            self.last_out = time.time()
            self.played += len(chunk) // 2
        outdata[: len(chunk)] = chunk
        if len(chunk) < need:
            outdata[len(chunk) :] = b"\x00" * (need - len(chunk))
        a = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768 if chunk else np.zeros(1, np.float32)
        lvl = float(min(1.0, np.sqrt(np.mean(a * a)) * 4))
        self.level_out += (lvl - self.level_out) * (0.5 if lvl > self.level_out else 0.12)

    # ---------- ciclo de vida ----------

    def start(self) -> None:
        try:
            import sounddevice as sd
        except OSError as exc:  # Linux sem a biblioteca PortAudio
            self.erro = f"Áudio indisponível: {exc}. No Linux, instale: sudo apt install libportaudio2"
            log.warning(self.erro)
            return
        try:
            self._in = sd.RawInputStream(samplerate=IN_RATE, channels=1, dtype="int16", blocksize=BLOCK, callback=self._on_in)
            self._in.start()
        except Exception as exc:  # noqa: BLE001
            self.erro = f"Microfone indisponível: {exc}"
            log.warning(self.erro)
        try:
            self._outs = sd.RawOutputStream(samplerate=OUT_RATE, channels=1, dtype="int16", blocksize=1024, callback=self._on_out)
            self._outs.start()
        except Exception as exc:  # noqa: BLE001
            self.erro = (self.erro or "") + f" Alto-falante indisponível: {exc}"
            log.warning("alto-falante: %s", exc)

    def stop(self) -> None:
        for s in (self._in, self._outs):
            try:
                if s:
                    s.stop()
                    s.close()
            except Exception:  # noqa: BLE001
                pass


audio = AudioIO()
