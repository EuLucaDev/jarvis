// Microfone (16 kHz para a Gemini) e reprodução da voz (24 kHz vinda da Gemini).

function rms(an: AnalyserNode, buf: Float32Array<ArrayBuffer>) {
  an.getFloatTimeDomainData(buf)
  let s = 0
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
  return Math.sqrt(s / buf.length)
}

export class Mic {
  private ctx?: AudioContext
  private stream?: MediaStream
  private node?: AudioWorkletNode
  private an?: AnalyserNode
  private buf = new Float32Array(512)

  async start(onChunk: (pcm: ArrayBuffer) => void) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
    this.ctx = new AudioContext()
    await this.ctx.audioWorklet.addModule('/pcm-capture.js')
    const src = this.ctx.createMediaStreamSource(this.stream)
    this.an = this.ctx.createAnalyser()
    this.an.fftSize = 512
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture')
    this.node.port.onmessage = (e) => onChunk(e.data as ArrayBuffer)
    src.connect(this.an)
    src.connect(this.node)
  }

  level() {
    return this.an ? Math.min(1, rms(this.an, this.buf) * 6) : 0
  }

  stop() {
    this.node?.port.close()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.ctx?.close()
    this.ctx = this.node = this.an = this.stream = undefined
  }
}

export class Player {
  private ctx = new AudioContext({ sampleRate: 24000 })
  private an = this.ctx.createAnalyser()
  private gain = this.ctx.createGain()
  private next = 0
  private sources = new Set<AudioBufferSourceNode>()
  private buf = new Float32Array(512)

  constructor() {
    this.an.fftSize = 512
    this.gain.connect(this.an)
    this.an.connect(this.ctx.destination)
  }

  resume() {
    return this.ctx.resume()
  }

  enqueue(pcm: ArrayBuffer) {
    const i16 = new Int16Array(pcm)
    const f32 = new Float32Array(i16.length)
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000
    const ab = this.ctx.createBuffer(1, f32.length, 24000)
    ab.copyToChannel(f32, 0)
    const src = this.ctx.createBufferSource()
    src.buffer = ab
    src.connect(this.gain)
    const at = Math.max(this.ctx.currentTime + 0.03, this.next)
    src.start(at)
    this.next = at + ab.duration
    this.sources.add(src)
    src.onended = () => this.sources.delete(src)
  }

  // Interrompido pelo usuário: corta o que ainda estava na fila.
  flush() {
    this.sources.forEach((s) => s.stop())
    this.sources.clear()
    this.next = 0
  }

  playing() {
    return this.ctx.currentTime < this.next
  }

  // Relógio do áudio e até onde já há fala agendada (para casar texto com voz).
  now() {
    return this.ctx.currentTime
  }
  queuedUntil() {
    return Math.max(this.next, this.ctx.currentTime)
  }

  // Segundos de fala ainda na fila (para a legenda andar junto com a voz).
  remaining() {
    return Math.max(0, this.next - this.ctx.currentTime)
  }

  level() {
    return Math.min(1, rms(this.an, this.buf) * 4)
  }
}
