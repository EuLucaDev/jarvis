import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Player } from '../lib/audio'
import { JarvisSocket, type Card, type ScreenConfig, type ServerEvent, type Telemetry, type VoiceStatus } from '../lib/socket'
import { frameJpeg } from '../lib/face'
import { WakeWord } from '../lib/wake'

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
const WAKE_KEY = 'jarvis.wake'
const IDLE_MS = 45000 // com a palavra de ativação ligada, a sessão volta a dormir após esse silêncio

export type LogLine = { quem: 'voce' | 'jarvis'; texto: string }
export type Vision = 'off' | 'camera' | 'tela'

export function useJarvis(role = 'hud', query = '') {
  const [log, setLog] = useState<LogLine[]>([])
  const [presence, setPresence] = useState<string | null>(null)
  const [vision, setVision] = useState<Vision>('off')
  const visionStream = useRef<MediaStream | null>(null)
  const visionVideo = useRef<HTMLVideoElement | null>(null)
  const [status, setStatus] = useState<VoiceStatus>({ voice: 'off' })
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null)
  const [screens, setScreens] = useState<ScreenConfig[] | null>(null)
  const [wake, setWake] = useState(() => {
    try {
      return localStorage.getItem(WAKE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [wakeError, setWakeError] = useState<string | null>(null)
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
  // pedaços da fala ainda não mostrados, com o instante do áudio em que devem aparecer
  const pending = useRef<{ t: string; at: number }[]>([])
  const plan = useRef<{ offsets: number[]; next: number; spoken: number }>({ offsets: [], next: 0, spoken: 0 })
  const lastAudioAt = useRef(0)
  const lastActive = useRef(0)
  const wakeRef = useRef(wake)
  wakeRef.current = wake
  const stopRef = useRef<() => void>(() => {})
  const wakeWord = useRef<WakeWord | null>(null)
  const quietAt = useRef(0)
  const pendingAsk = useRef<string | null>(null) // texto que espera a voz ficar ao vivo

  const pushLog = useCallback((quem: LogLine['quem'], texto: string, novo: boolean) => {
    setLog((l) => {
      const last = l.at(-1)
      if (!novo && last && last.quem === quem) return [...l.slice(0, -1), { quem, texto: (last.texto + texto).slice(-600) }]
      return [...l, { quem, texto }].slice(-30)
    })
  }, [])

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
        setStatus({ voice: e.voice, model: e.model, error: e.error, telas: e.telas })
        if (e.voice === 'live' && pendingAsk.current) {
          sock.current?.send({ type: 'text', text: pendingAsk.current })
          pendingAsk.current = null
        }
        break
      case 'telemetria':
        setTelemetry(e)
        break
      case 'telas.config':
        setScreens(e.telas)
        break
      case 'user.text': {
        const novo = L.turnDone || L.lastModel > L.lastUser
        if (novo) {
          setUserLine('')
          modelBuf.current = ''
        }
        pushLog('voce', e.text, novo || !!e.typed)
        L.turnDone = false
        L.lastUser = now
        setUserLine((s) => (e.typed ? e.text : s + e.text).slice(-160))
        break
      }
      case 'presenca':
        setPresence(e.etapa)
        break
      case 'model.text':
        if (L.turnDone) {
          modelBuf.current = ''
          pending.current = []
        }
        L.turnDone = false
        L.lastModel = now
        {
          const at = player.current?.queuedUntil() ?? 0
          pending.current.push(...e.text.split(/(?<=\s)/).map((t) => ({ t, at })))
        }
        break
      case 'sequence.plan':
        plan.current = { offsets: e.palavras, next: 0, spoken: 0 }
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
  }, [pushLog])

  useEffect(() => {
    player.current = new Player()
    const s = new JarvisSocket(role + query, {
      onEvent,
      onOpen: setOnline,
      onAudio: (pcm) => {
        live.current.lastModel = performance.now()
        lastAudioAt.current = performance.now()
        player.current?.enqueue(pcm)
      },
    })
    sock.current = s
    return () => {
      s.close()
      mic.current?.stop()
    }
  }, [role, query, onEvent])

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

      // Legenda no ritmo da voz: cada pedaço aparece quando o áudio chega ao ponto em que ele veio.
      if (pending.current.length) {
        const p = player.current
        const audioRecent = now - lastAudioAt.current < 1500
        let n = 0
        if (!audioRecent && now - L.lastModel > 250) n = pending.current.length // sem áudio: direto
        else if (p) {
          const clock = p.now()
          while (n < pending.current.length && pending.current[n].at <= clock + 0.08) n++
        }
        if (n > 0) {
          const chunk = pending.current.splice(0, n).map((x) => x.t).join('')
          pushLog('jarvis', chunk, modelBuf.current === '')
          modelBuf.current += chunk
          setCaption(lastWords(modelBuf.current, 8))
          // briefing: pede o próximo cartão quando a fala chega no trecho dele
          const pl = plan.current
          if (pl.next < pl.offsets.length) {
            pl.spoken += chunk.trim().split(/\s+/).filter(Boolean).length
            while (pl.next < pl.offsets.length && pl.spoken >= pl.offsets[pl.next]) {
              sock.current?.send({ type: 'sequence.show', index: pl.next })
              pl.next++
            }
          }
        }
      }
      if (next !== 'ouvindo' || L.level > 0.12) lastActive.current = now
      if (wakeRef.current && mic.current && next === 'ouvindo' && now - lastActive.current > IDLE_MS) {
        lastActive.current = now
        stopRef.current()
      }
      if (L.phase !== next) {
        L.phase = next
        setPhase(next)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [pushLog])

  // Visão: câmera ou tela vão para a Gemini a 1 quadro por segundo, enquanto a voz está ao vivo.
  useEffect(() => {
    if (vision === 'off' || status.voice !== 'live') return
    const t = setInterval(() => {
      const v = visionVideo.current
      const jpeg = v && frameJpeg(v)
      if (jpeg) sock.current?.send({ type: 'video.frame', jpeg })
    }, 1000)
    return () => clearInterval(t)
  }, [vision, status.voice])

  const stopVision = useCallback(() => {
    visionStream.current?.getTracks().forEach((t) => t.stop())
    visionStream.current = null
    setVision('off')
  }, [])

  const startVision = useCallback(
    async (kind: Exclude<Vision, 'off'>) => {
      stopVision()
      try {
        const stream =
          kind === 'camera'
            ? await navigator.mediaDevices.getUserMedia({ video: { width: 960 }, audio: false })
            : await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false })
        stream.getVideoTracks()[0].onended = () => setVision('off')
        visionStream.current = stream
        const v = visionVideo.current ?? document.createElement('video')
        v.muted = true
        v.playsInline = true
        v.srcObject = stream
        await v.play()
        visionVideo.current = v
        setVision(kind)
      } catch {
        setVision('off')
      }
    },
    [stopVision],
  )

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
      lastActive.current = performance.now()
      wakeWord.current?.pause()
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
    if (wakeRef.current) setTimeout(() => wakeWord.current?.resume(), 400)
  }, [])
  stopRef.current = stopVoice

  // Palavra de ativação: o navegador escuta "Jarvis" e só então abre a sessão de voz.
  useEffect(() => {
    if (!wake || role !== 'hud') return
    const w = new WakeWord(() => {
      if (!mic.current) startVoice()
    }, setWakeError)
    wakeWord.current = w
    if (!mic.current) w.resume()
    return () => {
      w.stop()
      wakeWord.current = null
    }
  }, [wake, role, startVoice])

  const toggleWake = useCallback(() => {
    setWakeError(null)
    setWake((v) => {
      try {
        localStorage.setItem(WAKE_KEY, v ? '0' : '1')
      } catch {
        /* só nesta aba */
      }
      return !v
    })
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

  /** Pergunta por texto; se a voz estiver desligada, liga e envia assim que conectar. */
  const ask = useCallback(
    async (text: string) => {
      if (statusRef.current.voice === 'live') {
        sock.current?.send({ type: 'text', text })
        return
      }
      pendingAsk.current = text
      await startVoice()
    },
    [startVoice],
  )

  /** Analisador do que está soando agora: a voz do Jarvis falando, senão o microfone. */
  const scope = useCallback(() => {
    if (player.current?.playing()) return player.current.analyser()
    return mic.current?.analyser() ?? null
  }, [])

  return {
    ask,
    send: (msg: object) => sock.current?.send(msg),
    log,
    presence,
    vision,
    visionVideo,
    visionStream,
    startVision,
    stopVision,
    scope,
    micOn: () => !!mic.current,
    status,
    telemetry,
    screens,
    wake,
    wakeError,
    toggleWake,
    setScreensState: (estado: 'ativas' | 'bloqueadas') => sock.current?.send({ type: 'telas', estado }),
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
