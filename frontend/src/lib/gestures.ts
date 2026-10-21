// Gestos pela câmera (MediaPipe Gesture Recognizer, Apache-2.0), tudo no navegador.
// Um gesto só vale se ficar parado um instante (evita disparo por engano) e há um intervalo entre ações.

export type GestureAction = 'ouvir' | 'fechar' | 'proximo' | 'sim' | 'nao'

const MAP: Record<string, { action: GestureAction; hold: number; label: string }> = {
  Open_Palm: { action: 'ouvir', hold: 800, label: 'Mão aberta · ligar/desligar a voz' },
  Closed_Fist: { action: 'fechar', hold: 600, label: 'Punho fechado · fechar cartões' },
  Victory: { action: 'proximo', hold: 600, label: 'Dois dedos · próximo cartão' },
  Thumb_Up: { action: 'sim', hold: 600, label: 'Polegar para cima · sim' },
  Thumb_Down: { action: 'nao', hold: 600, label: 'Polegar para baixo · não' },
}

export const GESTURE_HELP = Object.values(MAP).map((m) => m.label)

export async function startGestures(onAction: (a: GestureAction, label: string) => void, onError: (m: string) => void) {
  const { FilesetResolver, GestureRecognizer } = await import('@mediapipe/tasks-vision')
  const fileset = await FilesetResolver.forVisionTasks('/mediapipe')
  const rec = await GestureRecognizer.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: '/models/gesture_recognizer.task', delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 1,
  })
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, facingMode: 'user' }, audio: false })
  } catch {
    rec.close()
    onError('Não consegui abrir a câmera para os gestos.')
    return () => {}
  }
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  await video.play()

  let current = ''
  let since = 0
  let cooldown = 0
  let stopped = false
  let last = 0
  const loop = (now: number) => {
    if (stopped) return
    if (now - last > 90 && video.readyState >= 2) {
      last = now
      const r = rec.recognizeForVideo(video, now)
      const g = r.gestures[0]?.[0]
      const name = g && g.score > 0.7 ? g.categoryName : ''
      if (name !== current) {
        current = name
        since = now
      } else if (name && MAP[name] && now - since >= MAP[name].hold && now > cooldown) {
        cooldown = now + 1600
        since = now + 100000 // exige soltar e repetir o gesto
        onAction(MAP[name].action, MAP[name].label)
      }
    }
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  return () => {
    stopped = true
    stream.getTracks().forEach((t) => t.stop())
    rec.close()
  }
}
