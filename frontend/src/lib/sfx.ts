// Efeitos sonoros do HUD, sintetizados na hora (sem arquivos): bipe de "ouvi", abertura do
// briefing, cartão chegando, desbloqueio das telas, aviso e erro. Volume baixo, por baixo da voz.

export type Sfx = 'ack' | 'listen' | 'start' | 'card' | 'close' | 'unlock' | 'alert' | 'error' | 'step'

const KEY = 'jarvis.sons'
let ctx: AudioContext | null = null
let noise: AudioBuffer | null = null
let lastAt: Partial<Record<Sfx, number>> = {}

export function soundsOn() {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

export function setSoundsOn(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* só nesta aba */
  }
}

function audio() {
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

// som com lado: avisos à direita (onde aparecem), cartões no centro; tudo passa por aqui
let out: AudioNode | null = null

function tone(c: AudioContext, at: number, freq: number, dur: number, vol: number, type: OscillatorType = 'sine', to?: number) {
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, at)
  if (to) o.frequency.exponentialRampToValueAtTime(to, at + dur)
  g.gain.setValueAtTime(0, at)
  g.gain.linearRampToValueAtTime(vol, at + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  o.connect(g).connect(out ?? c.destination)
  o.start(at)
  o.stop(at + dur + 0.02)
}

function hiss(c: AudioContext, at: number, dur: number, vol: number, from: number, to: number) {
  if (!noise) {
    noise = c.createBuffer(1, c.sampleRate, c.sampleRate)
    const d = noise.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }
  const src = c.createBufferSource()
  src.buffer = noise
  const f = c.createBiquadFilter()
  f.type = 'bandpass'
  f.Q.value = 1.4
  f.frequency.setValueAtTime(from, at)
  f.frequency.exponentialRampToValueAtTime(to, at + dur)
  const g = c.createGain()
  g.gain.setValueAtTime(0, at)
  g.gain.linearRampToValueAtTime(vol, at + dur * 0.3)
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  src.connect(f).connect(g).connect(out ?? c.destination)
  src.start(at, Math.random() * 0.5)
  src.stop(at + dur + 0.02)
}

export function play(kind: Sfx, pan = 0) {
  if (!soundsOn()) return
  const now = performance.now()
  if (now - (lastAt[kind] ?? 0) < 120) return // vários eventos juntos soam uma vez só
  lastAt = { ...lastAt, [kind]: now }
  let c: AudioContext
  try {
    c = audio()
  } catch {
    return
  }
  const t = c.currentTime + 0.01
  const p = c.createStereoPanner()
  p.pan.value = Math.max(-1, Math.min(1, pan))
  p.connect(c.destination)
  out = p
  switch (kind) {
    case 'ack': // ouvi "Jarvis"
      tone(c, t, 1180, 0.09, 0.07)
      tone(c, t + 0.08, 1760, 0.14, 0.06)
      break
    case 'listen': // sessão de voz no ar
      tone(c, t, 520, 0.28, 0.05, 'sine', 1040)
      hiss(c, t, 0.3, 0.025, 600, 4000)
      break
    case 'start': // abertura do briefing
      ;[660, 880, 990, 1320].forEach((f, i) => tone(c, t + i * 0.09, f, 0.18, 0.05, 'triangle'))
      break
    case 'card': // cartão chegando: clique seco e um sopro
      tone(c, t, 2400, 0.03, 0.06, 'square', 1200)
      hiss(c, t, 0.22, 0.04, 900, 5200)
      break
    case 'close':
      hiss(c, t, 0.2, 0.03, 4200, 700)
      break
    case 'unlock': // arpejo subindo
      ;[523, 659, 784, 1047, 1319].forEach((f, i) => tone(c, t + i * 0.07, f, 0.32, 0.045, 'triangle'))
      hiss(c, t + 0.3, 0.5, 0.03, 500, 6000)
      break
    case 'alert':
      tone(c, t, 880, 0.28, 0.07)
      tone(c, t + 0.16, 1320, 0.3, 0.07)
      break
    case 'error':
      tone(c, t, 330, 0.18, 0.06, 'triangle')
      tone(c, t + 0.14, 220, 0.26, 0.06, 'triangle')
      break
    case 'step': // etapa nova enquanto ele trabalha
      tone(c, t, 1600, 0.05, 0.03)
      break
  }
  out = null
}
