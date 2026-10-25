#!/bin/bash
# Baixa os modelos que vão dentro do app (ficam fora do git):
#  - voz offline em português (Vosk, ~50 MB) para "Jarvis"
#  - mãos (MediaPipe Gesture Recognizer, ~8 MB)
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
