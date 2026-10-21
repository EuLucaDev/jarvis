// Palavra de ativação "Jarvis" com o reconhecimento de fala do Chrome (gratuito, roda pelo Google).
// Fica escutando só enquanto a sessão de voz está fechada.

type Rec = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: any) => void) | null
  onend: (() => void) | null
  onerror: ((e: any) => void) | null
  start(): void
  stop(): void
}

export class WakeWord {
  private rec: Rec | null = null
  private on = false
  private onWake: () => void
  private onError: (msg: string | null) => void

  constructor(onWake: () => void, onError: (msg: string | null) => void) {
    this.onWake = onWake
    this.onError = onError
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!Ctor) {
      onError('Este navegador não tem reconhecimento de fala. Use o Chrome.')
      return
    }
    const rec: Rec = new Ctor()
    rec.lang = 'pt-BR'
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text: string = e.results[i][0].transcript.toLowerCase()
        if (/\b(jarvis|jarves|djarvis|jarbas)\b/.test(text)) {
          this.pause()
          this.onWake()
          return
        }
      }
    }
    rec.onerror = (e) => {
      if (e.error === 'not-allowed') {
        this.on = false
        onError('Microfone bloqueado para a palavra de ativação.')
      }
    }
    rec.onend = () => {
      if (this.on) setTimeout(() => this.on && this.safeStart(), 300)
    }
    this.rec = rec
  }

  private safeStart() {
    try {
      this.rec?.start()
      this.onError(null)
    } catch {
      /* já estava rodando */
    }
  }

  resume() {
    if (!this.rec || this.on) return
    this.on = true
    this.safeStart()
  }

  pause() {
    this.on = false
    this.rec?.stop()
  }

  stop() {
    this.pause()
    this.rec = null
  }
}
