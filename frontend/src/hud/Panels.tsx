import { Activity, AudioLines, Cpu, MessageSquare, SendHorizontal, Thermometer, Waves } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type MutableRefObject, type ReactNode } from 'react'
import { api } from '../lib/api'
import type { Live, LogLine } from './useJarvis'

export type PanelId = 'entrada' | 'espectro' | 'leitura' | 'servicos' | 'clima' | 'canal'

export const PANELS: Record<PanelId, { nome: string; desc: string }> = {
  entrada: { nome: 'Sinal · Entrada', desc: 'Onda ao vivo do som que entra e sai.' },
  espectro: { nome: 'Sinal · Espectro', desc: 'Frequências da voz, de 20 Hz a 20 kHz.' },
  leitura: { nome: 'Voz · Leitura', desc: 'Intensidade da voz agora.' },
  servicos: { nome: 'Núcleo · Serviços', desc: 'Estado de cada parte do sistema.' },
  clima: { nome: 'Sensores · Clima', desc: 'Temperatura e umidade da sua cidade.' },
  canal: { nome: 'Jarvis · Canal ativo', desc: 'A conversa por escrito, com campo para digitar.' },
}

function Frame({ icon: Icon, title, tag, children, grow }: { icon: typeof Activity; title: string; tag?: ReactNode; children: ReactNode; grow?: boolean }) {
  return (
    <section className={`hp ${grow ? 'grow' : ''}`}>
      <header>
        <Icon size={12} strokeWidth={1.75} />
        <span>{title}</span>
        {tag && <em>{tag}</em>}
      </header>
      {children}
    </section>
  )
}

/** Canvas que redesenha a cada quadro a partir do analisador de áudio atual. */
function useScope(draw: (ctx: CanvasRenderingContext2D, w: number, h: number, an: AnalyserNode | null) => void, getAn: () => AnalyserNode | null) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawRef = useRef(draw)
  drawRef.current = draw
  useEffect(() => {
    const cv = ref.current!
    const ctx = cv.getContext('2d')!
    let raf = 0
    const loop = () => {
      const dpr = Math.min(2, devicePixelRatio || 1)
      const w = cv.clientWidth
      const h = cv.clientHeight
      if (cv.width !== Math.round(w * dpr)) {
        cv.width = Math.round(w * dpr)
        cv.height = Math.round(h * dpr)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      ctx.clearRect(0, 0, w, h)
      drawRef.current(ctx, w, h, getAn())
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [getAn])
  return ref
}

const wave = new Float32Array(1024)
const bins = new Uint8Array(256)

export function SignalIn({ scope, live }: { scope: () => AnalyserNode | null; live: MutableRefObject<Live> }) {
  const ref = useScope((ctx, w, h, an) => {
    ctx.strokeStyle = 'rgb(95 212 255 / 0.9)'
    ctx.lineWidth = 1.4
    ctx.shadowColor = 'rgb(95 212 255 / 0.7)'
    ctx.shadowBlur = 6
    ctx.beginPath()
    const n = 160
    if (an) an.getFloatTimeDomainData(wave)
    for (let i = 0; i < n; i++) {
      const v = an ? wave[Math.floor((i / n) * an.fftSize)] * 3 : Math.sin(i / 6 + performance.now() / 400) * 0.02
      const y = h / 2 + Math.max(-1, Math.min(1, v)) * (h / 2 - 2)
      if (i === 0) ctx.moveTo(0, y)
      else ctx.lineTo((i / (n - 1)) * w, y)
    }
    ctx.stroke()
  }, scope)
  return (
    <Frame icon={Activity} title="Sinal · Entrada" tag={live.current.phase === 'espera' ? 'em espera' : 'ao vivo'}>
      <canvas ref={ref} className="scope" aria-hidden="true" />
    </Frame>
  )
}

export function Spectrum({ scope }: { scope: () => AnalyserNode | null }) {
  const ref = useScope((ctx, w, h, an) => {
    const bars = 30
    if (an) an.getByteFrequencyData(bins)
    const gap = 2
    const bw = (w - gap * (bars - 1)) / bars
    for (let i = 0; i < bars; i++) {
      // escala logarítmica: mais barras nas frequências da voz
      const idx = Math.min(bins.length - 1, Math.floor(Math.pow(i / bars, 1.7) * 120) + 1)
      const v = an ? bins[idx] / 255 : 0.04 + 0.03 * Math.abs(Math.sin(i * 1.3 + performance.now() / 700))
      const bh = Math.max(2, v * h)
      ctx.fillStyle = `rgb(${70 + v * 40} ${150 + v * 70} 255 / ${0.45 + v * 0.55})`
      ctx.fillRect(i * (bw + gap), h - bh, bw, bh)
    }
  }, scope)
  return (
    <Frame icon={AudioLines} title="Sinal · Espectro" tag="20Hz–20kHz">
      <canvas ref={ref} className="scope tall" aria-hidden="true" />
    </Frame>
  )
}

export function VoiceRead({ live }: { live: MutableRefObject<Live> }) {
  const [v, setV] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setV(Math.round(live.current.level * 100)), 120)
    return () => clearInterval(t)
  }, [live])
  return (
    <Frame icon={Waves} title="Voz · Leitura" tag={`${v}%`}>
      <div className="meter">
        <span style={{ width: `${v}%` }} />
      </div>
    </Frame>
  )
}

type Svc = { nome: string; estado: string; ok: boolean | null }

export function Services({ items }: { items: Svc[] }) {
  const allOk = items.every((s) => s.ok !== false)
  return (
    <Frame icon={Cpu} title="Núcleo · Serviços" tag={allOk ? 'operacional' : 'atenção'}>
      <dl className="svc">
        {items.map((s) => (
          <div key={s.nome}>
            <dt>{s.nome}</dt>
            <dd className={s.ok === false ? 'bad' : s.ok ? 'ok' : 'idle'}>
              <i />
              {s.estado}
            </dd>
          </div>
        ))}
      </dl>
    </Frame>
  )
}

export function Weather() {
  const [c, setC] = useState<Record<string, any> | null>(null)
  useEffect(() => {
    const load = () =>
      api('/api/briefing')
        .then((b) => setC(b?.clima ?? null))
        .catch(() => {})
    load()
    const t = setInterval(load, 600000)
    return () => clearInterval(t)
  }, [])
  const hum = c?.umidade ?? 0
  const r = 30
  const circ = 2 * Math.PI * r
  return (
    <Frame icon={Thermometer} title="Sensores · Clima" tag={c?.cidade}>
      <div className="wx">
        <svg viewBox="0 0 72 72" aria-hidden="true">
          <circle cx="36" cy="36" r={r} className="ring-bg" />
          <circle cx="36" cy="36" r={r} className="ring" strokeDasharray={`${(hum / 100) * circ} ${circ}`} />
        </svg>
        <dl>
          <div>
            <dt>Umid.</dt>
            <dd>{c ? `${hum}%` : '—'}</dd>
          </div>
          <div>
            <dt>Temp.</dt>
            <dd>{c ? `${Math.round(c.temperatura)}°C` : '—'}</dd>
          </div>
          <div>
            <dt>Chuva</dt>
            <dd>{c ? `${c.chuva}%` : '—'}</dd>
          </div>
        </dl>
      </div>
    </Frame>
  )
}

export function Channel({ log, ready, onSend }: { log: LogLine[]; ready: boolean; onSend: (t: string) => void }) {
  const [text, setText] = useState('')
  const end = useRef<HTMLLIElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [log])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    onSend(text.trim())
    setText('')
  }
  return (
    <Frame icon={MessageSquare} title="Jarvis · Canal ativo" tag={ready ? 'pronto' : 'em espera'} grow>
      <ul className="chan">
        {log.length === 0 && <li className="hint">Fale ou escreva. A conversa aparece aqui.</li>}
        {log.map((l, i) => (
          <li key={i} className={l.quem}>
            <b>{l.quem === 'jarvis' ? 'JARVIS' : 'Você'}</b> ▸ {l.texto}
          </li>
        ))}
        <li ref={end} aria-hidden="true" />
      </ul>
      <form className="chan-ask" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Escreva para o JARVIS…" aria-label="Mensagem para o Jarvis" />
        <button disabled={!text.trim()} aria-label="Enviar">
          <SendHorizontal size={14} />
        </button>
      </form>
    </Frame>
  )
}
