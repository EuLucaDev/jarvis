// Conexão única com o backend: eventos em JSON e áudio em frames binários.

export type ServerEvent =
  | { type: 'sync'; cards: Card[]; status: VoiceStatus }
  | ({ type: 'status' } & VoiceStatus)
  | { type: 'user.text'; text: string; typed?: boolean }
  | { type: 'model.text'; text: string }
  | { type: 'turn'; phase: 'complete' | 'interrupted' }
  | { type: 'tool'; name: string; phase: 'start' | 'end' }
  | { type: 'card'; card: Card }
  | { type: 'card.close'; id: string }
  | { type: 'cards.clear' }
  | { type: 'audio.flush' }
  | { type: 'sequence.plan'; palavras: number[] }
  | { type: 'presenca'; etapa: string }
  | ({ type: 'telemetria' } & Telemetry)
  | { type: 'telas.config'; telas: ScreenConfig[] }

export type Telemetry = {
  cpu: number
  ram: number
  disco: number
  rede_kbps: { down: number; up: number }
  bateria: number | null
  carregando: boolean | null
  uptime_h: number
}

export type ScreenConfig = { id: string; nome: string; widgets: string[] }

export type VoiceStatus = {
  voice: 'off' | 'connecting' | 'live' | 'error' | 'demo'
  telas?: 'ativas' | 'bloqueadas'
  model?: string
  error?: string | null
}

export type Card = {
  id: string
  kind: 'pesquisa' | 'clima' | 'lista' | 'emails' | 'agenda' | 'noticia' | 'carregando' | 'camera' | 'mercado'
  at: string
  data: Record<string, any>
}

type Handlers = {
  onEvent: (e: ServerEvent) => void
  onAudio: (pcm: ArrayBuffer) => void
  onOpen: (open: boolean) => void
}

export class JarvisSocket {
  private ws?: WebSocket
  private retry = 0
  private closed = false
  private role: string
  private h: Handlers

  constructor(role: string, h: Handlers) {
    this.role = role
    this.h = h
    this.connect()
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws?role=${this.role}`)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      this.retry = 0
      this.h.onOpen(true)
    }
    ws.onmessage = (m) => {
      if (typeof m.data === 'string') this.h.onEvent(JSON.parse(m.data))
      else this.h.onAudio(m.data as ArrayBuffer)
    }
    ws.onclose = () => {
      this.h.onOpen(false)
      if (this.closed) return
      const wait = Math.min(8000, 500 * 2 ** this.retry++)
      setTimeout(() => this.connect(), wait)
    }
    this.ws = ws
  }

  send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  sendAudio(pcm: ArrayBuffer) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm)
  }

  close() {
    this.closed = true
    this.ws?.close()
  }
}
