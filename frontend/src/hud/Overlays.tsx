import { Archive, Bot, Copy, Brush, CheckCircle2, Eraser, HelpCircle, LoaderCircle, MousePointer2, Pin, PinOff, RefreshCw, Send, X, XCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { GESTURE_HELP, HAND_LINKS } from '../lib/gestures'
import type { Task } from '../lib/socket'
import { standardViews, WidgetGrid, type WidgetData } from '../tela/Tela'
import { airStore, HOLD_OPTIONS, useHandFrame, type Pinned, type Zone } from './air'
import { CardView } from './Cards'
import type { useJarvis } from './useJarvis'

type J = ReturnType<typeof useJarvis>

/** Painéis dentro do HUD: com uma tela só, agenda, e-mails, notícias e sistema ficam a um toque (ou "Jarvis, mostra a agenda"). */
export function Deck({ j, data, view, onView, onClose }: { j: J; data: WidgetData; view: string; onView: (v: string) => void; onClose: () => void }) {
  const views = [...standardViews(data.temas)]
  if (data.cams.length) views.push({ id: 'cameras', nome: 'Câmeras', widgets: data.cams.map((c) => `camera:${c.id}`) })
  const current = views.find((v) => v.id === view) ?? views[0]
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <section className="deck" aria-label="Painéis">
      <header className="deck-bar">
        <nav className="tabs" aria-label="Painéis">
          {views.map((v) => (
            <button key={v.id} className={v.id === current.id ? 'on' : ''} onClick={() => onView(v.id)}>
              {v.nome}
            </button>
          ))}
        </nav>
        <button className="chip-btn" onClick={data.refresh} disabled={data.refreshing}>
          <RefreshCw size={12} className={data.refreshing ? 'spin' : ''} /> {data.refreshing ? 'Atualizando' : 'Atualizar'}
        </button>
        <button className="icon-btn" onClick={onClose} aria-label="Fechar painéis (Esc)">
          <X size={15} />
        </button>
      </header>
      <div className="widgets deck-grid" key={current.id}>
        <WidgetGrid j={j} widgets={current.widgets} data={data} />
        {current.widgets.length === 0 && <p className="muted">Nada aqui ainda. Os temas de notícias vêm do briefing.</p>}
      </div>
    </section>
  )
}

const INKS = ['#5fd4ff', '#f4f7fb', '#ffb547', '#7cf29a']

/** Quadro: desenhe com o mouse, a caneta ou a pinça no ar e mande para o Jarvis interpretar. */
export function Board({ onSend, onClose }: { onSend: (jpeg: string, pedido: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const last = useRef<{ x: number; y: number } | null>(null)
  const [ink, setInk] = useState(INKS[0])
  const [pedido, setPedido] = useState('')
  const [empty, setEmpty] = useState(true)

  useEffect(() => {
    const cv = ref.current!
    const fit = () => {
      const r = cv.getBoundingClientRect()
      const keep = document.createElement('canvas')
      keep.width = cv.width
      keep.height = cv.height
      keep.getContext('2d')!.drawImage(cv, 0, 0)
      cv.width = r.width
      cv.height = r.height
      cv.getContext('2d')!.drawImage(keep, 0, 0)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(cv)
    return () => ro.disconnect()
  }, [])

  const line = (x: number, y: number) => {
    const ctx = ref.current!.getContext('2d')!
    const p = last.current
    ctx.strokeStyle = ink
    ctx.lineWidth = 4
    ctx.lineCap = ctx.lineJoin = 'round'
    ctx.shadowColor = ink
    ctx.shadowBlur = 8
    ctx.beginPath()
    ctx.moveTo(p?.x ?? x, p?.y ?? y)
    ctx.lineTo(x, y)
    ctx.stroke()
    last.current = { x, y }
    setEmpty(false)
  }

  // mão: a pinça é a caneta encostada no quadro (lê o quadro da mão direto, sem re-renderizar)
  const lineRef = useRef(line)
  lineRef.current = line
  useEffect(
    () =>
      airStore.subscribe(() => {
        const h = airStore.get().hands[0]
        if (!h?.pinch) {
          last.current = null
          return
        }
        const r = ref.current!.getBoundingClientRect()
        lineRef.current(h.x * innerWidth - r.left, h.y * innerHeight - r.top)
      }),
    [],
  )

  const clear = () => {
    const cv = ref.current!
    cv.getContext('2d')!.clearRect(0, 0, cv.width, cv.height)
    setEmpty(true)
  }
  const send = () => {
    const cv = ref.current!
    const out = document.createElement('canvas')
    const scale = Math.min(1, 1024 / cv.width)
    out.width = Math.round(cv.width * scale)
    out.height = Math.round(cv.height * scale)
    const ctx = out.getContext('2d')!
    ctx.fillStyle = '#04102a'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.drawImage(cv, 0, 0, out.width, out.height)
    onSend(out.toDataURL('image/jpeg', 0.85).split(',')[1], pedido.trim())
  }

  return (
    <section className="board" aria-label="Quadro de desenho">
      <canvas
        ref={ref}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          last.current = null
          line(e.nativeEvent.offsetX, e.nativeEvent.offsetY)
        }}
        onPointerMove={(e) => e.buttons === 1 && line(e.nativeEvent.offsetX, e.nativeEvent.offsetY)}
        onPointerUp={() => (last.current = null)}
      />
      {empty && (
        <p className="board-hint">
          <Brush size={16} /> Desenhe com o mouse ou, com os gestos ligados, juntando polegar e indicador no ar.
        </p>
      )}
      <footer className="board-bar">
        <div className="inks" role="radiogroup" aria-label="Cor">
          {INKS.map((c) => (
            <button key={c} role="radio" aria-checked={c === ink} aria-label={`Cor ${c}`} className={c === ink ? 'on' : ''} style={{ background: c }} onClick={() => setInk(c)} />
          ))}
        </div>
        <input value={pedido} onChange={(e) => setPedido(e.target.value)} placeholder="O que fazer com o desenho? (opcional)" onKeyDown={(e) => e.key === 'Enter' && !empty && send()} />
        <button className="chip-btn" onClick={clear}>
          <Eraser size={12} /> Limpar
        </button>
        <button className="chip-btn primary" onClick={send} disabled={empty}>
          <Send size={12} /> Mandar ao Jarvis
        </button>
        <button className="icon-btn" onClick={onClose} aria-label="Fechar quadro">
          <X size={15} />
        </button>
      </footer>
    </section>
  )
}

/** Cursores das mãos: aparecem só enquanto a câmera vê a mão. Com duas pinças, uma linha liga as duas (zoom). */
export function HandCursors() {
  const { hands, ring } = useHandFrame()
  const [a, b] = hands
  const zooming = a?.pinch && b?.pinch
  return (
    <>
      {ring && (
        <div
          className={`air-ring ${ring.kind}`}
          style={{ transform: `translate(${ring.x * innerWidth}px, ${ring.y * innerHeight}px)`, ['--p' as string]: ring.p }}
          aria-hidden="true"
        >
          <span>{ring.kind === 'armar' ? 'Ajustar' : 'Fixar'}</span>
        </div>
      )}
      {zooming && (
        <svg className="zoom-line" aria-hidden="true">
          <line x1={a.x * innerWidth} y1={a.y * innerHeight} x2={b.x * innerWidth} y2={b.y * innerHeight} />
        </svg>
      )}
      {hands.map((h, i) => (
        <div key={h.key} className={`hand-cursor ${h.pinch ? 'pinch' : ''} ${i ? 'second' : ''}`} style={{ transform: `translate(${h.x * innerWidth}px, ${h.y * innerHeight}px)` }} aria-hidden="true" />
      ))}
    </>
  )
}

/** Prévia da câmera com o esqueleto da mão, o que o gesto está fazendo agora e a ajuda. */
export function GesturePanel({
  status,
  toast,
  hold,
  onHold,
  mouse,
  onMouse,
}: {
  status: string
  toast: string | null
  hold: number
  onHold: (ms: number) => void
  mouse: boolean
  onMouse: (on: boolean) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [help, setHelp] = useState(() => {
    try {
      return localStorage.getItem('jarvis.gestureHelp') !== '0'
    } catch {
      return true
    }
  })
  const { hands } = useHandFrame()
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, cv.width, cv.height)
    for (const h of hands) {
      ctx.strokeStyle = h.pinch ? '#ffffff' : 'rgb(95 212 255 / 0.9)'
      ctx.lineWidth = 1.6
      ctx.beginPath()
      for (const [i, k] of HAND_LINKS) {
        ctx.moveTo(h.points[i].x * cv.width, h.points[i].y * cv.height)
        ctx.lineTo(h.points[k].x * cv.width, h.points[k].y * cv.height)
      }
      ctx.stroke()
      ctx.fillStyle = h.pinch ? '#ffffff' : '#5fd4ff'
      for (const i of [4, 8]) {
        ctx.beginPath()
        ctx.arc(h.points[i].x * cv.width, h.points[i].y * cv.height, 3, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }, [hands])
  const toggleHelp = () => {
    setHelp((v) => {
      try {
        localStorage.setItem('jarvis.gestureHelp', v ? '0' : '1')
      } catch {
        /* só nesta aba */
      }
      return !v
    })
  }
  const label = toast ?? status ?? ''
  return (
    <aside className={`gesture-panel ${mouse ? 'is-mouse' : ''}`} aria-live="polite">
      <div className="gp-cam">
        <canvas ref={ref} width={192} height={144} aria-hidden="true" />
        <span className="gp-tag">{hands.length ? `${hands.length === 2 ? 'Duas mãos' : 'Mão'}${hands.some((h) => h.pinch) ? ' · pinça' : ''}` : 'Procurando a mão'}</span>
        <button className="gp-help" onClick={toggleHelp} aria-pressed={help} aria-label="Ajuda dos gestos">
          <HelpCircle size={13} />
        </button>
      </div>
      {label && <p className="gp-status">{label}</p>}
      <div className="gp-row">
        <button className={`chip-btn ${mouse ? 'on' : ''}`} onClick={() => onMouse(!mouse)} aria-pressed={mouse} title="A mão controla o mouse do Mac. Punho fechado sai.">
          <MousePointer2 size={12} /> {mouse ? 'Mouse do Mac · ligado' : 'Mouse do Mac'}
        </button>
      </div>
      {mouse && <p className="gp-hint">Pinça clica · pinça e mexe arrasta · dois dedos rolam · punho sai</p>}
      {help && !mouse && (
        <div className="gp-row" role="radiogroup" aria-label="Tempo parado para ajustar e fixar">
          <small>Segurar</small>
          {HOLD_OPTIONS.map((ms) => (
            <button key={ms} role="radio" aria-checked={hold === ms} className={`gp-seg ${hold === ms ? 'on' : ''}`} onClick={() => onHold(ms)}>
              {(ms / 1000).toLocaleString('pt-BR')} s
            </button>
          ))}
        </div>
      )}
      {help && !mouse && (
        <ul className="gp-list">
          {GESTURE_HELP.map((g) => {
            const [nome, acao] = g.split(' · ')
            return (
              <li key={g}>
                <b>{nome}</b> {acao}
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}

/** Zonas de soltar enquanto um cartão é arrastado: esquerda fixa, direita fecha, embaixo guarda. */
export function DropZones({ zone }: { zone: Zone }) {
  return (
    <div className="drop-zones" aria-hidden="true">
      <div className={`dz dz-fixar ${zone === 'fixar' ? 'on' : ''}`}>
        <Pin size={18} /> Fixar
      </div>
      <div className={`dz dz-fechar ${zone === 'fechar' ? 'on' : ''}`}>
        <X size={18} /> Fechar
      </div>
      <div className={`dz dz-guardar ${zone === 'guardar' ? 'on' : ''}`}>
        <Archive size={18} /> Guardar na fileira
      </div>
      <div className={`dz dz-copiar ${zone === 'copiar' ? 'on' : ''}`}>
        <Copy size={18} /> Copiar para colar em outro app
      </div>
    </div>
  )
}

/** Cartões fixos: ficam na tela até você soltar. Arrastam com o mouse ou com a pinça. */
export function PinnedCards({
  pinned,
  onChange,
  onPeriod,
  live,
  preview,
}: {
  pinned: Pinned[]
  onChange: (p: Pinned[]) => void
  onPeriod: (id: string, p: string) => void
  live: { id: string; z: number } | null
  preview: string | null
}) {
  const drag = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number } | null>(null)
  if (!pinned.length) return null
  return (
    <>
      {pinned.map((p) => (
        <div
          key={p.card.id}
          className={`pinned ${live?.id === p.card.id ? 'resizing' : ''}`}
          data-id={p.card.id}
          style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, transform: `scale(${live?.id === p.card.id ? live.z : (p.scale ?? 1)})` }}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('button, a')) return
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { id: p.card.id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y }
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d || d.id !== p.card.id) return
            const x = Math.min(0.8, Math.max(0, d.ox + (e.clientX - d.sx) / innerWidth))
            const y = Math.min(0.8, Math.max(0.04, d.oy + (e.clientY - d.sy) / innerHeight))
            onChange(pinned.map((q) => (q.card.id === p.card.id ? { ...q, x, y } : q)))
          }}
          onPointerUp={() => (drag.current = null)}
        >
          <button className="pin-off" onClick={() => onChange(pinned.filter((q) => q.card.id !== p.card.id))} aria-label="Desafixar cartão">
            <PinOff size={12} />
          </button>
          <CardView card={p.card} onPeriod={p.card.kind === 'mercado' ? (per) => onPeriod(p.card.id, per) : undefined} preview={live?.id === p.card.id ? preview : null} />
        </div>
      ))}
    </>
  )
}

const AGENTE: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', chatgpt: 'ChatGPT' }

/** Tarefas passadas a outras IAs (Claude Code, Codex/ChatGPT), com o estado de cada uma. */
export function Tasks({ tasks }: { tasks: Task[] }) {
  if (!tasks.length) return null
  return (
    <section className="hp tasks">
      <header>
        <Bot size={12} strokeWidth={1.75} />
        <span>Operações · Tarefas</span>
        <em>{tasks.filter((t) => t.estado === 'rodando').length} em curso</em>
      </header>
      <ul>
        {tasks.slice(0, 4).map((t) => (
          <li key={t.id} className={t.estado}>
            {t.estado === 'rodando' ? <LoaderCircle size={13} className="spin" /> : t.estado === 'feito' ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
            <span>
              <b>{t.titulo}</b>
              <small>
                {AGENTE[t.agente] ?? t.agente} · {t.inicio}
                {t.resumo && t.estado !== 'rodando' ? ` · ${t.resumo}` : ''}
              </small>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
