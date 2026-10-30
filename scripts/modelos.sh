#!/bin/bash
# Baixa os modelos que vão dentro do app (ficam fora do git):
#  - voz offline em português (Vosk, ~50 MB) para "Jarvis"
#  - mãos (MediaPipe Gesture Recognizer, ~8 MB; no Windows/Linux também o RTMPose, ~60 MB; o Mac usa o Vision da Apple)
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
# rosto (presença na frente do computador, fora do Mac; ~230 KB)
[ -f models/rosto.tflite ] || curl -sSL -o models/rosto.tflite \
  https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite
# RTMPose (detector de mão + 21 pontos), o motor das mãos no Windows e no Linux
if [ "$(uname)" != "Darwin" ] || [ "${RTM:-}" = "1" ]; then
  mkdir -p models/rtm
  baixar_rtm() {  # url → models/rtm/<nome>.onnx (o zip traz end2end.onnx numa pasta)
    [ -f "models/rtm/$2.onnx" ] && return
    curl -sSL -o "models/rtm/$2.zip" "$1" || curl -sSL -o "models/rtm/$2.zip" "https://huggingface.co/Tau-J/RTMPose/resolve/main/$(basename "$1")"
    unzip -q -o "models/rtm/$2.zip" -d "models/rtm/$2.tmp"
    mv "$(find "models/rtm/$2.tmp" -name end2end.onnx | head -1)" "models/rtm/$2.onnx"
    rm -rf "models/rtm/$2.zip" "models/rtm/$2.tmp"
  }
  baixar_rtm https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmdet_nano_8xb32-300e_hand-267f9c8f.zip detector
  baixar_rtm https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-m_simcc-hand5_pt-aic-coco_210e-256x256-74fb594_20230320.zip pontos
fi
ls -la models
TESS=../financeiro/motor/tessdata
mkdir -p "$TESS"
[ -f "$TESS/por.traineddata.gz" ] || curl -sSL -o "$TESS/por.traineddata.gz" \
  https://cdn.jsdelivr.net/npm/@tesseract.js-data/por/4.0.0_best_int/por.traineddata.gz
ls -la "$TESS"
