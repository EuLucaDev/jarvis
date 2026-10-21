// Reconhecimento facial local (face-api, MIT). Nada sai do computador: a câmera é lida no navegador
// e só os descritores numéricos do rosto ficam salvos no SQLite local.
import type * as FaceApi from '@vladmandic/face-api'

let api: typeof FaceApi | null = null
let loading: Promise<typeof FaceApi> | null = null

export async function loadFace(): Promise<typeof FaceApi> {
  if (api) return api
  loading ??= (async () => {
    const f = await import('@vladmandic/face-api')
    await (f.tf as unknown as { ready: () => Promise<void> }).ready()
    await Promise.all([
      f.nets.tinyFaceDetector.loadFromUri('/models'),
      f.nets.faceLandmark68TinyNet.loadFromUri('/models'),
      f.nets.faceRecognitionNet.loadFromUri('/models'),
    ])
    api = f
    return f
  })()
  return loading
}

const opts = () => new api!.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })

/** Um rosto na imagem: caixa e descritor de 128 números (ou null). */
export async function readFace(video: HTMLVideoElement) {
  const f = await loadFace()
  const r = await f.detectSingleFace(video, opts()).withFaceLandmarks(true).withFaceDescriptor()
  if (!r) return null
  return { box: r.detection.box, score: r.detection.score, descriptor: Array.from(r.descriptor) }
}

/** Menor distância até as amostras salvas. Abaixo de ~0,5 é a mesma pessoa. */
export function distance(desc: number[], samples: number[][]) {
  let best = Infinity
  for (const s of samples) {
    let sum = 0
    for (let i = 0; i < 128; i++) sum += (desc[i] - s[i]) ** 2
    best = Math.min(best, Math.sqrt(sum))
  }
  return best
}

export const MATCH = 0.5

export async function openCamera(width = 640) {
  return navigator.mediaDevices.getUserMedia({ video: { width, facingMode: 'user' }, audio: false })
}

/** Converte o quadro atual do vídeo em JPEG base64 (para a Gemini ver). */
export function frameJpeg(video: HTMLVideoElement, maxW = 768, quality = 0.7): string | null {
  if (!video.videoWidth) return null
  const scale = Math.min(1, maxW / video.videoWidth)
  const c = document.createElement('canvas')
  c.width = Math.round(video.videoWidth * scale)
  c.height = Math.round(video.videoHeight * scale)
  c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', quality).split(',')[1]
}
