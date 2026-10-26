#!/bin/bash
# Baixa os modelos que vão dentro do app (ficam fora do git):
#  - voz offline em português (Vosk, ~50 MB) para "Jarvis"
#  - mãos (MediaPipe Gesture Recognizer, ~8 MB)
#  - português do leitor de fotos de extrato do financeiro (Tesseract, ~11 MB), para não baixar na hora
set -euo pipefail
cd "$(dirname "$0")/../backend"
mkdir -p models
if [ ! -d models/vosk-pt ]; then
  curl -sSL -o models/vosk.zip https://alphacephei.com/vosk/models/vosk-model-small-pt-0.3.zip
  unzip -q models/vosk.zip -d models && mv models/vosk-model-small-pt-0.3 models/vosk-pt && rm models/vosk.zip
fi
[ -f models/gesture_recognizer.task ] || curl -sSL -o models/gesture_recognizer.task \
  https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task
ls -la models
TESS=../financeiro/motor/tessdata
mkdir -p "$TESS"
[ -f "$TESS/por.traineddata.gz" ] || curl -sSL -o "$TESS/por.traineddata.gz" \
  https://cdn.jsdelivr.net/npm/@tesseract.js-data/por/4.0.0_best_int/por.traineddata.gz
ls -la "$TESS"
