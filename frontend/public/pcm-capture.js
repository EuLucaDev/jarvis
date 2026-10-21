// Captura o microfone, reduz para 16 kHz e envia blocos de 50 ms em PCM 16 bits.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / 16000
    this.pos = 0
    this.acc = 0
    this.cnt = 0
    this.buf = new Int16Array(800)
    this.n = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]
      this.cnt++
      this.pos += 1
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio
        const s = Math.max(-1, Math.min(1, this.acc / this.cnt))
        this.acc = 0
        this.cnt = 0
        this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.buffer, [this.buf.buffer])
          this.buf = new Int16Array(800)
          this.n = 0
        }
      }
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)
