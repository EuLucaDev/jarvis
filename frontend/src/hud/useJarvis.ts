import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Player } from '../lib/audio'
import { JarvisSocket, type Card, type ServerEvent, type VoiceStatus } from '../lib/socket'

export type Phase = 'espera' | 'ouvindo' | 'pensando' | 'falando'

// Sinais que mudam a cada quadro ficam em ref; o React só re-renderiza quando a fase muda.
export type Live = {
  phase: Phase
  level: number // 0..1, volume que move a esfera
  lastUser: number
  lastModel: number
  tool: boolean
  turnDone: boolean
}

const BARGE_KEY = 'jarvis.bargeIn'

export function useJarvis(role = 'hud') {
  const [status, setStatus] = useState<VoiceStatus>({ voice: 'off' })
  const [online, setOnline] = useState(false)
  const [cards, setCards] = useState<Card[]>([])
  const [focusId, setFocusId] = useState<string | null>(null)
  const [caption, setCaption] = useState('')
  const [userLine, setUserLine] = useState('')
  const [phase, setPhase] = useState<Phase>('espera')
  const [micError, setMicError] = useState<string | null>(null)
  const [bargeIn, setBargeIn] = useState(() => {
    try {
      return localStorage.getItem(BARGE_KEY) === '1'
    } catch {
      return false
    }
  })

  const live = useRef<Live>({ phase: 'espera', level: 0, lastUser: 0, lastModel: 0, tool: false, turnDone: true })
  const sock = useRef<JarvisSocket | null>(null)
  const mic = useRef<Mic | null>(null)
  const player = useRef<Player | null>(null)
  const statusRef = useRef(status)
  statusRef.current = status
  const bargeRef = useRef(bargeIn)
  bargeRef.current = bargeIn
  const modelBuf = useRef('')
  const quietAt = useRef(0)

  const onEvent = useCallback((e: ServerEvent) => {
    const L = live.current
    const now = performance.now()
    switch (e.type) {
      case 'sync':
        setCards(e.cards)
        setStatus(e.status)
        setFocusId(e.cards.at(-1)?.id ?? null)
        break
      case 'status':
        setStatus({ voice: e.voice, model: e.model, error: e.error })
        break
      case 'user.text':
        if (L.turnDone || L.lastModel > L.lastUser) {
          setUserLine('')
          modelBuf.current = ''
        }
        L.turnDone = false
        L.lastUser = now
        setUserLine((s) => (e.typed ? e.text : s + e.text).slice(-160))
        break
      case 'model.text':
        if (L.turnDone) modelBuf.current = ''
        L.turnDone = false
        L.lastModel = now
        modelBuf.current += e.text
        setCaption(lastWords(modelBuf.current, 8))
        break
      case 'turn':
        L.turnDone = true
        if (e.phase === 'interrupted') player.current?.flush()
        break
      case 'tool':
        L.tool = e.phase === 'start'
        break
      case 'card':
        setCards((c) => [...c.filter((x) => x.id !== e.card.id), e.card].slice(-8))
        setFocusId(e.card.id)
        break
      case 'card.close':
        setCards((c) => c.filter((x) => x.id !== e.id))
        setFocusId((f) => (f === e.id ? null : f))
        break
      case 'cards.clear':
        setCards([])
        setFocusId(null)
        break
      case 'audio.flush':
        player.current?.flush()
        break
    }
  }, [])

  useEffect(() => {
    player.current = new Player()
    const s = new JarvisSocket(role, {
      onEvent,
      onOpen: setOnline,
      onAudio: (pcm) => {
        live.current.lastModel = performance.now()
        player.current?.enqueue(pcm)
      },
    })
    sock.current = s
    return () => {
      s.close()
      mic.current?.stop()
    }
  }, [role, onEvent])

  // Relógio da fase: decide a cada quadro o que a esfera está fazendo.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const L = live.current
      const now = performance.now()
      const v = statusRef.current.voice
      const speaking = !!player.current?.playing() || now - L.lastModel < 700
      let next: Phase
      if (v === 'off' || v === 'error') next = speaking ? 'falando' : 'espera'
      else if (v === 'connecting') next = 'pensando'
      else if (speaking) next = 'falando'
      else if (L.tool || (!L.turnDone && L.lastUser > L.lastModel && now - L.lastUser < 12000)) next = 'pensando'
      else next = 'ouvindo'

      const raw =
        next === 'falando'
          ? player.current?.playing()
            ? player.current.level()
            : 0.35 + 0.3 * Math.abs(Math.sin(now / 140)) * Math.random() // demo sem áudio
          : next === 'ouvindo'
            ? (mic.current?.level() ?? 0)
            : next === 'pensando'
              ? 0.18
              : 0.04
      L.level += (raw - L.level) * (raw > L.level ? 0.35 : 0.08)
      if (speaking) quietAt.current = now
      if (L.phase !== next) {
        L.phase = next
        setPhase(next)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // A legenda some um tempo depois que ele termina de falar.
  useEffect(() => {
    if (phase === 'falando' || !caption) return
    const t = setTimeout(() => setCaption(''), 3200)
    return () => clearTimeout(t)
  }, [phase, caption])

  const startVoice = useCallback(async () => {
    setMicError(null)
    await player.current?.resume()
    try {
      const m = new Mic()
      await m.start((pcm) => {
        // Sem fone, a voz do Jarvis volta pelo microfone; por padrão o mic fica mudo enquanto ele fala.
        const now = performance.now()
        if (!bargeRef.current && (player.current?.playing() || now - quietAt.current < 300)) return
        sock.current?.sendAudio(pcm)
      })
      mic.current = m
      sock.current?.send({ type: 'voice.start' })
    } catch (err) {
      // Sem microfone a conversa continua por texto, com a resposta em voz.
      setMicError(err instanceof Error && err.name === 'NotAllowedError'
        ? 'Microfone bloqueado: libere no ícone ao lado do endereço. Por enquanto, escreva abaixo.'
        : 'Microfone indisponível. Por enquanto, escreva abaixo.')
      sock.current?.send({ type: 'voice.start' })
    }
  }, [])

  const stopVoice = useCallback(() => {
    mic.current?.stop()
    mic.current = null
    sock.current?.send({ type: 'voice.stop' })
  }, [])

  const toggleBarge = useCallback(() => {
    setBargeIn((b) => {
      try {
        localStorage.setItem(BARGE_KEY, b ? '0' : '1')
      } catch {
        /* sem armazenamento: vale só nesta aba */
      }
      return !b
    })
  }, [])

  return {
    status,
    online,
    cards,
    focusId,
    setFocusId,
    caption,
    userLine,
    phase,
    live,
    micError,
    bargeIn,
    toggleBarge,
    startVoice,
    stopVoice,
    sendText: (text: string) => sock.current?.send({ type: 'text', text }),
    closeCard: (id: string) => sock.current?.send({ type: 'card.close', id }),
    clearCards: () => sock.current?.send({ type: 'cards.clear' }),
  }
}

function lastWords(text: string, n: number) {
  const words = text.trim().split(/\s+/)
  // Mostra a frase em blocos, como legenda: troca o bloco inteiro a cada n palavras.
  const start = Math.max(0, Math.floor((words.length - 1) / n) * n)
  return words.slice(start, start + n).join(' ')
}
