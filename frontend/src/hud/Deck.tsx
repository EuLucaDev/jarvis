// Painéis dentro do HUD (os widgets em tela grande, para quem tem um monitor só) e a lista de tarefas
// passadas a outras IAs.
import { Bot, CheckCircle2, LoaderCircle, RefreshCw, X, XCircle } from 'lucide-react'
import { useEffect } from 'react'
import type { Task } from '../lib/socket'
import type { Jarvis } from './useJarvis'
import { standardViews, WidgetGrid, type WidgetData } from './Widgets'

type J = Jarvis

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
