// Copia os modelos de visão (rosto e gestos) para public/, onde o Vite os empacota.
// Ficam fora do git por tamanho; rodar uma vez depois do npm install (o instalar.sh já chama).
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'

const face = 'node_modules/@vladmandic/face-api/model'
const mp = 'node_modules/@mediapipe/tasks-vision/wasm'
mkdirSync('public/models', { recursive: true })
mkdirSync('public/mediapipe', { recursive: true })
for (const f of readdirSync(face)) {
  if (/^(tiny_face_detector_model|face_landmark_68_tiny_model|face_recognition_model)/.test(f)) copyFileSync(`${face}/${f}`, `public/models/${f}`)
}
for (const f of readdirSync(mp)) if (/^vision_wasm_internal/.test(f)) copyFileSync(`${mp}/${f}`, `public/mediapipe/${f}`)
const task = 'public/models/gesture_recognizer.task'
if (!existsSync(task)) {
  const url = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task'
  const res = await fetch(url)
  if (!res.ok) throw new Error(`não baixei o modelo de gestos: ${res.status}`)
  writeFileSync(task, Buffer.from(await res.arrayBuffer()))
}
console.log('modelos prontos')
