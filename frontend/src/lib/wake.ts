// Palavra de ativação "Jarvis" com o reconhecimento de fala do Chrome (gratuito, roda pelo Google).
// Fica escutando só enquanto a sessão de voz está fechada. Ao ouvir "Jarvis" avisa na hora (bipe) e
// espera o resto da frase: "Jarvis, bom dia" vira o pedido "bom dia", sem precisar repetir.

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
  private onWake: (command: string) => void
  private onArm: () => void
  private onError: (msg: string | null) => void
  private armed = false
  private command = ''
  private timer = 0

  constructor(onWake: (command: string) => void, onError: (msg: string | null) => void, onArm: () => void = () => {}) {
    this.onWake = onWake
    this.onArm = onArm
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
        const m = WAKE.exec(text)
        if (!m && !this.armed) continue
        if (m) this.command = text.slice(m.index + m[0].length)
        else this.command = text // frase seguinte, depois de uma pausa curta
        if (!this.armed) {
          this.armed = true
          this.onArm()
        }
        clearTimeout(this.timer)
        // fim da frase: resultado final, ou 1,2 s sem palavra nova
        if (e.results[i].isFinal && this.command.trim()) this.fire()
        else this.timer = window.setTimeout(() => this.fire(), this.command.trim() ? 1200 : 1600)
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

  private fire() {
    clearTimeout(this.timer)
    if (!this.armed) return
    const cmd = this.command.replace(/^[\s,.!?:;-]+/, '').trim()
    this.armed = false
    this.command = ''
    this.pause()
    this.onWake(cmd)
  }

  resume() {
    if (!this.rec || this.on) return
    this.on = true
    this.safeStart()
  }

  pause() {
    clearTimeout(this.timer)
    this.armed = false
    this.on = false
    this.rec?.stop()
  }

  stop() {
    this.pause()
    this.rec = null
  }
}

const WAKE = /\b(jarvis|jarves|djarvis|jarbas|jarviz)\b/
