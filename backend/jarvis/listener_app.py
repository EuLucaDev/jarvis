"""Ouvido do Jarvis em segundo plano (processo à parte): a palavra "Jarvis" e duas palmas.

Usa o reconhecimento de fala do próprio macOS, em português e no aparelho (nada vai para a internet), e
detecta palmas pelo áudio do microfone. Escreve no stdout:
  "pronto"            microfone e reconhecimento no ar
  "wake|<comando>"    ouviu "Jarvis" (com o resto da frase, se houver: "Jarvis, bom dia" → "bom dia")
  "palmas"            duas palmas seguidas
  "erro|<motivo>"     sem permissão de microfone ou de reconhecimento de fala
Comandos no stdin: "pausa" (o Jarvis está conversando) e "volta".
Rodar: python -m jarvis.listener_app
"""

import re
import sys
import threading
import time

import AVFoundation
import Foundation
import Speech
from PyObjCTools import AppHelper

WAKE = re.compile(r"\b(jarvis|jarves|djarvis|jarbas|jarviz|jarvi)\b", re.I)


def say(msg: str) -> None:
    print(msg, flush=True)


class Ouvido:
    def __init__(self) -> None:
        self.engine = AVFoundation.AVAudioEngine.alloc().init()
        self.rec = Speech.SFSpeechRecognizer.alloc().initWithLocale_(Foundation.NSLocale.localeWithLocaleIdentifier_("pt-BR"))
        self.req = None
        self.task = None
        self.pausado = False
        self.inicio = 0.0
        # palmas
        self.ruido = 0.01
        self.picos: list[float] = []
        self.ultimo_pico = 0.0
        self.cooldown = 0.0
        # palavra
        self.armado = 0.0
        self.comando = ""
        self.mudou = 0.0
        self.ja_disparou = ""

    # ---------- reconhecimento ----------

    def nova_tarefa(self) -> None:
        if self.task:
            self.task.cancel()
        if self.req:
            self.req.endAudio()
        self.req = Speech.SFSpeechAudioBufferRecognitionRequest.alloc().init()
        self.req.setShouldReportPartialResults_(True)
        if self.rec.supportsOnDeviceRecognition():
            self.req.setRequiresOnDeviceRecognition_(True)
        self.inicio = time.time()
        self.armado = 0.0
        self.comando = ""
        self.ja_disparou = ""
        self.task = self.rec.recognitionTaskWithRequest_resultHandler_(self.req, self.resultado)

    def resultado(self, res, err) -> None:
        if res is None:
            return
        texto = str(res.bestTranscription().formattedString())
        m = None
        for m in WAKE.finditer(texto):
            pass  # a última ocorrência de "Jarvis" na frase
        if m and not self.pausado:
            cmd = texto[m.end():].strip(" ,.!?:;-")
            if not self.armado:
                self.armado = time.time()
            if cmd != self.comando:
                self.comando = cmd
                self.mudou = time.time()
            if res.isFinal():
                self.disparar()

    def disparar(self) -> None:
        chave = f"{self.armado}:{self.comando}"
        if not self.armado or chave == self.ja_disparou:
            return
        self.ja_disparou = chave
        say(f"wake|{self.comando}")
        self.armado = 0.0
        self.comando = ""
        # recomeça limpo: a frase antiga não pode disparar de novo
        AppHelper.callLater(0.2, self.nova_tarefa)

    def relogio(self) -> None:
        agora = time.time()
        # "Jarvis" ouvido: espera o fim da frase (1,2 s sem palavra nova; 1,6 s se veio só "Jarvis")
        if self.armado and agora - max(self.mudou, self.armado) > (1.2 if self.comando else 1.6):
            self.disparar()
        # o reconhecimento tem fôlego limitado: renova a cada 50 s sem frase em andamento
        if not self.armado and agora - self.inicio > 50:
            self.nova_tarefa()
        AppHelper.callLater(0.2, self.relogio)

    # ---------- áudio e palmas ----------

    def audio(self, buf, when) -> None:
        if self.req is not None:
            self.req.appendAudioPCMBuffer_(buf)
        if self.pausado:
            return
        n = buf.frameLength()
        dados = buf.floatChannelData()[0]
        pico = 0.0
        soma = 0.0
        for i in range(0, n, 2):
            v = abs(dados[i])
            soma += v
            if v > pico:
                pico = v
        media = soma / max(1, n // 2)
        agora = time.time()
        # palma: estalo curto bem acima do ruído de fundo
        if pico > 0.3 and pico > self.ruido * 12 and media < pico * 0.35 and agora - self.ultimo_pico > 0.12:
            self.ultimo_pico = agora
            self.picos = [p for p in self.picos if agora - p < 0.9] + [agora]
            if len(self.picos) >= 2 and 0.15 < self.picos[-1] - self.picos[-2] < 0.75 and agora > self.cooldown:
                self.cooldown = agora + 2.5
                self.picos = []
                say("palmas")
        else:
            self.ruido = self.ruido * 0.98 + media * 0.02

    def iniciar(self) -> None:
        entrada = self.engine.inputNode()
        formato = entrada.outputFormatForBus_(0)
        entrada.installTapOnBus_bufferSize_format_block_(0, 1024, formato, self.audio)
        self.engine.prepare()
        ok, err = self.engine.startAndReturnError_(None)
        if not ok:
            say(f"erro|microfone: {err}")
            return
        self.nova_tarefa()
        AppHelper.callLater(0.2, self.relogio)
        say("pronto")


def main() -> None:
    ouvido = Ouvido()

    def autorizado(status) -> None:
        if status != Speech.SFSpeechRecognizerAuthorizationStatusAuthorized:
            say("erro|sem permissão de reconhecimento de fala")
            return
        AppHelper.callAfter(ouvido.iniciar)

    def comandos() -> None:
        for line in sys.stdin:
            c = line.strip()
            if c == "pausa":
                ouvido.pausado = True
            elif c == "volta":
                ouvido.pausado = False
        AppHelper.callAfter(AppHelper.stopEventLoop)  # o servidor fechou

    threading.Thread(target=comandos, daemon=True).start()
    Speech.SFSpeechRecognizer.requestAuthorization_(autorizado)
    AppHelper.runConsoleEventLoop(installInterrupt=True)


if __name__ == "__main__":
    main()
