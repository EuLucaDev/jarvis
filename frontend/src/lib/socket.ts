// Conexão única com o núcleo: eventos em JSON (a voz, a câmera e as mãos rodam no núcleo, não aqui).

import { handStore, voiceStore, type Phase } from './live'

export type Alert = { id: string; titulo: string; texto: string; nivel: string; at: string; silencioso?: boolean }

export type Telemetry = {
  cpu: number
  ram: number
  disco: number
  rede_kbps: { down: number; up: number }
  bateria: number | null
  carregando: boolean | null
  uptime_h: number
}

export type VoiceStatus = {
  voice: 'off' | 'connecting' | 'live' | 'error' | 'demo'
  model?: string
  error?: string | null
}

export type Card = {
  id: string
  kind: 'pesquisa' | 'clima' | 'lista' | 'emails' | 'agenda' | 'noticia' | 'carregando' | 'camera' | 'mercado' | 'mensagens' | 'saude' | 'plano' | 'financeiro'
  at: string
  data: Record<string, any>
}

export type Task = { id: string; agente: string; titulo: string; estado: 'rodando' | 'feito' | 'erro'; resumo?: string; pasta?: string; inicio: string }

export type ServerEvent =
  | { type: 'sync'; cards: Card[]; status: VoiceStatus; tarefas?: Task[] }
  | ({ type: 'status' } & VoiceStatus)
  | { type: 'user.text'; text: string; typed?: boolean; novo?: boolean }
  | { type: 'legenda'; texto: string }
  | { type: 'tool'; name: string; phase: 'start' | 'end' }
  | { type: 'card'; card: Card }
  | { type: 'card.update'; card: Card }
  | { type: 'card.close'; id: string }
  | { type: 'cards.clear' }
  | ({ type: 'alerta' } & Alert)
  | ({ type: 'telemetria' } & Telemetry)
  | { type: 'painel'; visao: string | null }
  | { type: 'tarefa'; tarefa: Task }
  | { type: 'sugestao'; id: string; texto: string; pedido: string }
  | { type: 'parado'; origem: string }
  | { type: 'foco'; ate: number }
  | { type: 'janela'; acao: 'minimizar' | 'mostrar' | 'esconder' }
  | { type: 'despertar'; origem: string; bom_dia: boolean }
  | { type: 'camera'; ligada: boolean; erro?: string }
  | { type: 'tela'; ligada: boolean; erro?: string }
  | { type: 'gesto'; gesto: string; acao: string; rotulo: string }
  | { type: 'olhar'; x: number; y: number; w: number; h: number; label: string; modo: string }
  | { type: 'olhar.rotulo'; label: string }
  | { type: 'olhar.fim' }
  | { type: 'janela.realce'; estado: string | null; janela: any; escala?: number }
  | { type: 'janela.erro'; texto: string }
  | { type: 'configurado' }

type Handlers = { onEvent: (e: ServerEvent) => void; onOpen: (open: boolean) => void }

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
    const ws = new WebSocket(`${proto}://${location.host}/ws?role=${encodeURIComponent(this.role)}`)
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.h.onOpen(true)
    }
    ws.onmessage = (m) => {
      const e = JSON.parse(m.data)
      // os sinais rápidos vão direto para os stores (sem passar pelo React)
      if (e.type === 'vivo') voiceStore.set({ fase: e.fase as Phase, nivel: e.nivel, ouvindo: e.ouvindo })
      else if (e.type === 'maos') handStore.set({ hands: e.hands, pts: e.pts ?? handStore.get().pts })
      // ninguém na frente do computador: a interface escurece devagar (volta quando a pessoa chega)
      else if (e.type === 'presenca') document.documentElement.classList.toggle('ausente', !e.presente)
      else this.h.onEvent(e as ServerEvent)
    }
    ws.onclose = () => {
      this.h.onOpen(false)
      if (this.closed) return
      const wait = Math.min(8000, 500 * 2 ** this.retry++)
      setTimeout(() => this.connect(), wait)
    }
  }

  send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  close() {
    this.closed = true
    this.ws?.close()
  }
}
