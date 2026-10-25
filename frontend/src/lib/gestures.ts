// Gestos pela câmera (MediaPipe Gesture Recognizer, Apache-2.0), tudo no navegador, até duas mãos.
//
// Cada quadro vira um HandFrame: onde está a pinça de cada mão (ponto entre polegar e indicador, já
// espelhado como num espelho e esticado para a tela inteira), se a pinça está fechada e o centro da palma.
// Em cima disso saem as ações discretas:
// - poses paradas (mão aberta, punho, dois dedos, polegar) valem depois de um instante, com intervalo entre ações;
// - deslizes rápidos da mão aberta para os lados, para cima e para baixo.

export type GestureAction = 'ouvir' | 'fechar' | 'proximo' | 'sim' | 'nao' | 'esquerda' | 'direita' | 'cima' | 'baixo'

const POSES: Record<string, { action: GestureAction; hold: number; label: string }> = {
  Open_Palm: { action: 'ouvir', hold: 1400, label: 'Mão aberta parada · liga/desliga a voz' },
  Closed_Fist: { action: 'fechar', hold: 700, label: 'Punho fechado · fecha os cartões' },
  Victory: { action: 'proximo', hold: 600, label: 'Dois dedos · próximo cartão' },
  Thumb_Up: { action: 'sim', hold: 600, label: 'Polegar para cima · sim' },
  Thumb_Down: { action: 'nao', hold: 600, label: 'Polegar para baixo · não' },
}

const SWIPES: Record<'esquerda' | 'direita' | 'cima' | 'baixo', string> = {
  esquerda: 'Deslizar para a esquerda · próximo',
  direita: 'Deslizar para a direita · anterior',
  cima: 'Deslizar para cima · abre os painéis',
  baixo: 'Deslizar para baixo · fecha o que está aberto',
}

export const GESTURE_HELP = [
  'Pinça e solta · clica',
  'Pinça e mexe · arrasta (cartão, chip, lista)',
  'Pinça parada no cartão · entra no ajuste de tamanho (o anel enche)',
  'No ajuste, polegar e indicador em L · abrir aumenta, fechar diminui',
  'No ajuste, ficar parado · fixa o tamanho (o anel enche de novo)',
  'No ajuste, mão aberta ou soltar · cancela e volta ao tamanho antigo',
  'Duas pinças paradas · ajuste com as duas mãos',
  ...Object.values(SWIPES),
  ...Object.values(POSES).map((p) => p.label),
]

/** O HUD liga e desliga partes do reconhecimento conforme o modo (ajuste, mouse do Mac). */
export const gestureOptions = { poses: true, swipes: true }

export type Pt = { x: number; y: number }

export type Hand = {
  key: string // mão esquerda ou direita, estável entre quadros
  x: number // ponto da pinça na tela, 0..1
  y: number
  pinch: boolean
  spread: number // abertura polegar-indicador em relação ao tamanho da mão (≈0,2 em pinça, ≈1,2 em L aberto)
  palm: Pt // centro da palma na tela, 0..1
  pose: string // nome da pose do MediaPipe ('' se nenhuma)
  points: Pt[] // 21 pontos espelhados, no quadro da câmera (para desenhar o esqueleto)
}

export type HandFrame = { hands: Hand[]; t: number }

/** Compatibilidade: cursor de uma mão só. */
export type HandPointer = { x: number; y: number; pinch: boolean; seen: boolean }

// Miolo do quadro da câmera que vira a tela inteira: alcançar os cantos sem esticar o braço.
const AREA = { x0: 0.18, x1: 0.82, y0: 0.14, y1: 0.7 }

export async function startGestures(
  onAction: (a: GestureAction, label: string) => void,
  onError: (m: string) => void,
  onFrame: (f: HandFrame) => void = () => {},
) {
  const { FilesetResolver, GestureRecognizer } = await import('@mediapipe/tasks-vision')
  const fileset = await FilesetResolver.forVisionTasks('/mediapipe')
  const rec = await GestureRecognizer.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: '/models/gesture_recognizer.task', delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.6,
    minTrackingConfidence: 0.5,
  })
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false })
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

  // estado por mão: suavização, pinça firme (com histerese e tempo mínimo), histórico da palma para os deslizes
  const state = new Map<
    string,
    { x: number; y: number; px: number; py: number; pinch: boolean; raw: boolean; since: number; spread: number; seen: number; trail: { x: number; y: number; t: number }[] }
  >()
  let pose = ''
  let poseSince = 0
  let poseAnchor: Pt = { x: 0, y: 0 }
  let cooldown = 0
  let stopped = false
  let last = 0
  let hadHands = false

  const fire = (a: GestureAction, label: string, now: number, wait = 900) => {
    if (now < cooldown) return
    cooldown = now + wait
    onAction(a, label)
  }

  const loop = (now: number) => {
    if (stopped) return
    if (now - last > 28 && video.readyState >= 2) {
      last = now
      const r = rec.recognizeForVideo(video, now)
      const hands: Hand[] = []
      const seen = new Set<string>()
      r.landmarks.forEach((lm, i) => {
        const hd = r.handedness[i]?.[0]
        const key = hd?.categoryName ?? `m${i}`
        if (seen.has(key)) return
        const points = lm.map((p) => ({ x: 1 - p.x, y: p.y }))
        // mão pequena demais (longe, no fundo) ou detecção duvidosa: ignora, era o que "pegava" do nada
        const size = dist(points[0], points[9])
        if (size < 0.07 || (hd && hd.score < 0.7)) return
        seen.add(key)
        const raw = toScreen({ x: (points[4].x + points[8].x) / 2, y: (points[4].y + points[8].y) / 2 })
        const palmRaw = toScreen(avg([points[0], points[5], points[9], points[13], points[17]]))
        let s = state.get(key)
        if (!s) {
          s = { x: raw.x, y: raw.y, px: palmRaw.x, py: palmRaw.y, pinch: false, raw: false, since: now, spread: 1, seen: now, trail: [] }
          state.set(key, s)
        }
        // suavização que acompanha a velocidade: parado não treme, rápido não atrasa
        const speed = Math.hypot(raw.x - s.x, raw.y - s.y)
        const a = Math.min(0.85, Math.max(0.22, speed * 9))
        s.x += (raw.x - s.x) * a
        s.y += (raw.y - s.y) * a
        s.px += (palmRaw.x - s.px) * 0.5
        s.py += (palmRaw.y - s.py) * 0.5
        const d = dist(points[4], points[8]) / size
        s.spread += (d - s.spread) * 0.5
        // pinça firme: fecha abaixo de 0,25 e só abre acima de 0,4 (histerese), e precisa durar ~100 ms
        const want = s.raw ? d < 0.4 : d < 0.25
        if (want !== s.raw) {
          s.raw = want
          s.since = now
        }
        if (s.raw !== s.pinch && now - s.since > (s.raw ? 100 : 70)) s.pinch = s.raw
        const g = r.gestures[i]?.[0]
        const name = g && g.score > 0.65 ? g.categoryName : ''
        s.trail = [...s.trail.filter((p) => now - p.t < 320), { x: s.px, y: s.py, t: now }]
        // mão recém-chegada não pinça nos primeiros 250 ms (evita "clique" quando ela entra no quadro)
        const pinch = s.pinch && now - s.seen > 250
        hands.push({ key, x: s.x, y: s.y, pinch, spread: s.spread, palm: { x: s.px, y: s.py }, pose: name, points })
      })
      for (const k of state.keys()) if (!seen.has(k)) state.delete(k)
      hands.sort((a, b) => (a.key === 'Right' ? -1 : b.key === 'Right' ? 1 : 0)) // mão principal primeiro

      if (hands.length || hadHands) onFrame({ hands, t: now })
      hadHands = hands.length > 0

      // deslize: mão aberta, sem pinça, andou muito em pouco tempo
      const h = hands.length === 1 ? hands[0] : null
      const s = h && state.get(h.key)
      if (gestureOptions.swipes && h && s && !h.pinch && s.trail.length > 3 && (h.pose === 'Open_Palm' || h.pose === '')) {
        const first = s.trail[0]
        const dx = s.px - first.x
        const dy = s.py - first.y
        if (Math.abs(dx) > 0.3 && Math.abs(dx) > Math.abs(dy) * 1.8) {
          s.trail = []
          const dir = dx < 0 ? 'esquerda' : 'direita'
          fire(dir, SWIPES[dir], now)
        } else if (Math.abs(dy) > 0.28 && Math.abs(dy) > Math.abs(dx) * 1.8) {
          s.trail = []
          const dir = dy < 0 ? 'cima' : 'baixo'
          fire(dir, SWIPES[dir], now)
        }
      }

      // poses: uma mão só, sem pinça, parada um instante
      const name = gestureOptions.poses && h && !h.pinch ? h.pose : ''
      if (name !== pose) {
        pose = name
        poseSince = now
        poseAnchor = h ? h.palm : { x: 0, y: 0 }
      } else if (name && POSES[name] && h) {
        if (dist(h.palm, poseAnchor) > 0.06) {
          poseSince = now // mexeu: não é pose parada (evita disparar no meio de um deslize)
          poseAnchor = h.palm
        } else if (now - poseSince >= POSES[name].hold) {
          poseSince = now + 100000 // exige soltar e repetir a pose
          fire(POSES[name].action, POSES[name].label, now, 1600)
        }
      }
    }
    // timer em vez de requestAnimationFrame: continua rodando com o HUD atrás de outra janela
    // (o lançador abre o HUD com o Chrome sem frear janelas encobertas)
    setTimeout(() => loop(performance.now()), 30)
  }
  setTimeout(() => loop(performance.now()), 30)
  return () => {
    stopped = true
    stream.getTracks().forEach((t) => t.stop())
    rec.close()
  }
}

const clamp = (v: number) => Math.min(1, Math.max(0, v))
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const avg = (ps: Pt[]) => ({ x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length })
const toScreen = (p: Pt) => ({ x: clamp((p.x - AREA.x0) / (AREA.x1 - AREA.x0)), y: clamp((p.y - AREA.y0) / (AREA.y1 - AREA.y0)) })

/** Ligações entre os 21 pontos da mão, para desenhar o esqueleto. */
export const HAND_LINKS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
]
