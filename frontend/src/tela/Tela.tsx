import { ArrowDown, ArrowUp, Lock, Settings2, Unlock, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { ScreenConfig, Telemetry } from '../lib/socket'
import { CardView } from '../hud/Cards'
import { Orb } from '../hud/Orb'
import { useJarvis } from '../hud/useJarvis'
import './tela.css'

// Catálogo de widgets. "noticias:<tema>" e "camera:<id>" são gerados a partir dos ajustes.
const BASE_WIDGETS: { id: string; nome: string; desc: string }[] = [
  { id: 'orbe', nome: 'Orbe de voz', desc: 'A esfera sincronizada com a voz do Jarvis.' },
  { id: 'relogio', nome: 'Relógio', desc: 'Hora e data grandes.' },
  { id: 'agenda', nome: 'Agenda', desc: 'Compromissos de hoje.' },
  { id: 'emails', nome: 'E-mails', desc: 'Mensagens que pedem atenção.' },
  { id: 'clima', nome: 'Clima', desc: 'Condição agora e máxima do dia.' },
  { id: 'cartoes', nome: 'Cartões visuais', desc: 'O cartão que o Jarvis está mostrando agora.' },
  { id: 'sistema', nome: 'Sistema', desc: 'CPU, memória, disco, rede e bateria do Mac.' },
  { id: 'transcricao', nome: 'Transcrição', desc: 'Última fala sua e do Jarvis.' },
  { id: 'sessao', nome: 'Sessão', desc: 'Estado da voz, modelo e memória.' },
]

type Briefing = Record<string, any>

export function Tela({ id }: { id: string }) {
  const j = useJarvis('tela', `&tela=${encodeURIComponent(id)}`)
  const [all, setAll] = useState<ScreenConfig[] | null>(null)
  const [brief, setBrief] = useState<Briefing>({})
  const [cams, setCams] = useState<{ id: string; nome: string }[]>([])
  const [editing, setEditing] = useState(false)
  const [phase, setPhase] = useState<'locked' | 'unlocking' | 'open'>('locked')
  const [lines, setLines] = useState<{ quem: string; texto: string }[]>([])
  const prev = useRef(j.status.telas)

  useEffect(() => {
    api<ScreenConfig[]>('/api/ajustes/telas').then(setAll)
    api('/api/ajustes/cameras').then(setCams).catch(() => {})
    const load = () => api<Briefing>('/api/briefing').then(setBrief).catch(() => {})
    load()
    const t = setInterval(load, 120000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (j.screens) setAll(j.screens)
  }, [j.screens])

  // Bloqueio compartilhado: quando o Jarvis ativa as telas, todas desbloqueiam juntas.
  useEffect(() => {
    const now = j.status.telas
    if (now === 'ativas' && prev.current !== 'ativas') {
      setPhase('unlocking')
      const t = setTimeout(() => setPhase('open'), 1600)
      prev.current = now
      return () => clearTimeout(t)
    }
    if (now === 'bloqueadas') setPhase('locked')
    prev.current = now
  }, [j.status.telas])

  // Transcrição: junta os pedaços por quem falou.
  useEffect(() => {
    if (j.userLine) setLines((l) => upsert(l, 'Você', j.userLine))
  }, [j.userLine])
  useEffect(() => {
    if (j.caption) setLines((l) => upsert(l, 'Jarvis', j.caption, true))
  }, [j.caption])

  const screen = all?.find((s) => s.id === id)
  const catalog = useMemo(() => {
    const temas: string[] = (brief.noticias ?? []).map((n: any) => n.tema)
    return [
      ...BASE_WIDGETS,
      ...temas.map((t) => ({ id: `noticias:${t}`, nome: `Notícias · ${t}`, desc: 'Card independente para este tema.' })),
      ...cams.map((c) => ({ id: `camera:${c.id}`, nome: `Câmera · ${c.nome}`, desc: 'Imagem atualizada a cada 10 s.' })),
    ]
  }, [brief.noticias, cams])

  if (all && !screen) {
    return (
      <main className="tela tela-list">
        <h1>Telas</h1>
        <p className="muted">Não existe a tela “{id}”. Abra uma destas em outro monitor:</p>
        <ul>
          {all.map((s) => (
            <li key={s.id}>
              <a href={`/tela/${s.id}`}>{s.nome}</a>
            </li>
          ))}
        </ul>
      </main>
    )
  }

  const save = async (next: ScreenConfig) => {
    const list = (all ?? []).map((s) => (s.id === next.id ? next : s))
    setAll(list)
    await api('/api/ajustes/telas', { method: 'PUT', json: list })
  }

  const widgets = screen?.widgets ?? []
  const card = j.cards.find((c) => c.id === j.focusId) ?? j.cards.at(-1)

  return (
    <main className={`tela tela-${phase}`}>
      <div className="hud-grid" aria-hidden="true" />
      <header className="tela-bar">
        <span className="hud-brand">J.A.R.V.I.S.</span>
        <span>{screen?.nome ?? '…'}</span>
        <span className="hud-spacer" />
        <span className={`hud-dot ${j.online ? 'on' : ''}`} />
        <span>{j.online ? 'Sincronizada' : 'Reconectando'}</span>
        <button className="icon-btn" onClick={() => setEditing(true)} aria-label="Personalizar tela">
          <Settings2 size={15} />
        </button>
        {phase === 'open' && (
          <button className="icon-btn" onClick={() => j.setScreensState('bloqueadas')} aria-label="Bloquear telas">
            <Lock size={15} />
          </button>
        )}
      </header>

      {phase !== 'open' && (
        <section className="lock" aria-live="polite">
          <div className="lock-title">
            <span>{phase === 'unlocking' ? 'Acesso liberado' : 'Em espera'}</span>
            <small>{describe(widgets)}</small>
          </div>
          <div className="reticle">
            <svg viewBox="0 0 200 200" aria-hidden="true">
              <circle cx="100" cy="100" r="92" className="r1" />
              <circle cx="100" cy="100" r="78" className="r2" />
              <circle cx="100" cy="100" r="64" className="r3" />
              <path d="M8 40V8h32M160 8h32v32M192 160v32h-32M40 192H8v-32" className="corners" />
            </svg>
            <div className="reticle-core">
              {phase === 'unlocking' ? <Unlock size={22} /> : <Lock size={22} />}
              <strong>{screen?.nome}</strong>
              <span>{phase === 'unlocking' ? 'Telas sincronizadas' : 'Diga “Jarvis, ativar monitores”'}</span>
            </div>
          </div>
          <button className="unlock-btn" onClick={() => j.setScreensState('ativas')}>
            <Unlock size={14} /> Desbloquear
          </button>
        </section>
      )}

      {phase === 'open' && (
        <section className="widgets">
          {widgets.map((w, i) => (
            <div className={`widget w-${w.split(':')[0]}`} key={w} style={{ animationDelay: `${i * 90}ms` }}>
              <Widget id={w} j={j} brief={brief} card={card} lines={lines} cams={cams} />
            </div>
          ))}
          {widgets.length === 0 && <p className="muted">Nenhum widget nesta tela. Abra a engrenagem para montar.</p>}
        </section>
      )}

      {editing && screen && (
        <Personalizar screen={screen} catalog={catalog} onClose={() => setEditing(false)} onSave={save} />
      )}
    </main>
  )
}

function upsert(l: { quem: string; texto: string }[], quem: string, texto: string, append = false) {
  const last = l.at(-1)
  if (last && last.quem === quem) {
    const t = append && !texto.startsWith(last.texto.slice(0, 10)) ? `${last.texto} ${texto}` : texto
    return [...l.slice(0, -1), { quem, texto: t.slice(-280) }]
  }
  return [...l, { quem, texto }].slice(-6)
}

function describe(widgets: string[]) {
  const names = widgets.map((w) => (w.startsWith('noticias:') ? 'notícias' : w.startsWith('camera:') ? 'câmeras' : w))
  return [...new Set(names)].slice(0, 5).join(' · ')
}

function Widget({ id, j, brief, card, lines, cams }: { id: string; j: ReturnType<typeof useJarvis>; brief: Briefing; card: any; lines: { quem: string; texto: string }[]; cams: { id: string; nome: string }[] }) {
  const [kind, arg] = id.split(/:(.*)/s)
  if (kind === 'orbe')
    return (
      <div className="w-orb">
        <span className="w-label">{({ espera: 'Em espera', ouvindo: 'Ouvindo', pensando: 'Pensando', falando: 'Falando' } as const)[j.phase]}</span>
        <Orb live={j.live} phase={j.phase} />
      </div>
    )
  if (kind === 'relogio') return <Clock />
  if (kind === 'sistema') return <System t={j.telemetry} />
  if (kind === 'cartoes')
    return card ? <CardView card={card} /> : <Empty title="Cartões visuais" text="O que o Jarvis projetar aparece aqui." />
  if (kind === 'transcricao')
    return (
      <div className="panel">
        <span className="w-label">Transcrição</span>
        {lines.length ? (
          <ul className="transcript">
            {lines.map((l, i) => (
              <li key={i} className={l.quem === 'Jarvis' ? 'is-j' : ''}>
                <b>{l.quem}</b> {l.texto}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Fale com o Jarvis no monitor principal.</p>
        )}
      </div>
    )
  if (kind === 'sessao') return <Session status={j.status} />
  if (kind === 'clima' && brief.clima) return <CardView card={{ id: 'w-clima', kind: 'clima', at: brief.gerado ?? '', data: brief.clima }} />
  if (kind === 'agenda')
    return <CardView card={{ id: 'w-ag', kind: 'agenda', at: brief.gerado ?? '', data: { titulo: 'Agenda de hoje', eventos: brief.agenda ?? [], hoje: brief.hoje, configurado: brief.configurado?.agenda } }} />
  if (kind === 'emails' && brief.emails)
    return <CardView card={{ id: 'w-em', kind: 'emails', at: brief.gerado ?? '', data: { titulo: 'Pedem sua atenção', total: brief.emails.total, itens: brief.emails.atencao, outros: brief.emails.outros, configurado: brief.configurado?.gmail } }} />
  if (kind === 'noticias') {
    const n = (brief.noticias ?? []).find((x: any) => x.tema === arg)
    return n ? <CardView card={{ id: `w-n-${arg}`, kind: 'noticia', at: brief.gerado ?? '', data: n }} /> : <Empty title={`Notícias · ${arg}`} text="Aparece depois do próximo briefing." />
  }
  if (kind === 'camera') {
    const cam = cams.find((c) => c.id === arg)
    return cam ? <CamFeed id={cam.id} nome={cam.nome} /> : <Empty title="Câmera" text="Câmera removida dos ajustes." />
  }
  return <Empty title={id} text="Carregando dados do briefing…" />
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="panel">
      <span className="w-label">{title}</span>
      <p className="muted">{text}</p>
    </div>
  )
}

function Clock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="panel w-clock">
      <span className="clock-big">{now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
      <span className="muted">{now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
    </div>
  )
}

function Gauge({ label, value, sub, warnHigh = true }: { label: string; value: number | null; sub?: string; warnHigh?: boolean }) {
  const v = value ?? 0
  const r = 26
  const c = 2 * Math.PI * r
  return (
    <div className="gauge">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r={r} className="g-bg" />
        <circle cx="32" cy="32" r={r} className={`g-fg ${(warnHigh ? v > 85 : value != null && v < 20) ? 'hot' : ''}`} strokeDasharray={`${(v / 100) * c} ${c}`} />
      </svg>
      <b>{value == null ? '—' : `${v}%`}</b>
      <span>{label}</span>
      {sub && <small>{sub}</small>}
    </div>
  )
}

function System({ t }: { t: Telemetry | null }) {
  return (
    <div className="panel">
      <span className="w-label">Sistema · Telemetria</span>
      <div className="gauges">
        <Gauge label="CPU" value={t?.cpu ?? null} />
        <Gauge label="Memória" value={t?.ram ?? null} />
        <Gauge label="Disco" value={t?.disco ?? null} />
        <Gauge label="Bateria" value={t?.bateria ?? null} sub={t?.carregando ? 'na tomada' : undefined} warnHigh={false} />
      </div>
      <p className="net">
        Rede ↓ {t ? fmtKb(t.rede_kbps.down) : '—'} · ↑ {t ? fmtKb(t.rede_kbps.up) : '—'} · ligado há {t ? `${t.uptime_h.toLocaleString('pt-BR')} h` : '—'}
      </p>
    </div>
  )
}

const fmtKb = (k: number) => (k > 1024 ? `${(k / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB/s` : `${k} KB/s`)

function Session({ status }: { status: { voice: string; model?: string } }) {
  const [s, setS] = useState<Record<string, any>>({})
  useEffect(() => {
    const load = () => api('/api/status').then(setS).catch(() => {})
    load()
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [])
  const voz = { off: 'Desligada', connecting: 'Conectando', live: 'Ao vivo', error: 'Com erro', demo: 'Demonstração' }[status.voice] ?? status.voice
  return (
    <div className="panel">
      <span className="w-label">Sessão</span>
      <dl className="kv">
        <dt>Voz</dt>
        <dd>{voz}</dd>
        <dt>Modelo</dt>
        <dd>{s.model ?? '—'}</dd>
        <dt>Memórias</dt>
        <dd>{s.memorias ?? '—'}</dd>
        <dt>Telas</dt>
        <dd>{s.screens ?? '—'} conectadas</dd>
        <dt>No ar há</dt>
        <dd>{s.uptime_min != null ? `${s.uptime_min} min` : '—'}</dd>
      </dl>
    </div>
  )
}

function CamFeed({ id, nome }: { id: string; nome: string }) {
  const [t, setT] = useState(Date.now())
  const [err, setErr] = useState(false)
  useEffect(() => {
    const i = setInterval(() => setT(Date.now()), 10000)
    return () => clearInterval(i)
  }, [])
  return (
    <div className="panel">
      <span className="w-label">Câmera · {nome}</span>
      {err ? (
        <p className="muted">A câmera não respondeu. Confira o endereço nos ajustes.</p>
      ) : (
        <img className="cam" src={`/api/cameras/${id}/foto?t=${t}`} alt={`Câmera ${nome}`} onError={() => setErr(true)} onLoad={() => setErr(false)} />
      )}
    </div>
  )
}

function Personalizar({ screen, catalog, onClose, onSave }: { screen: ScreenConfig; catalog: { id: string; nome: string; desc: string }[]; onClose: () => void; onSave: (s: ScreenConfig) => void }) {
  const [nome, setNome] = useState(screen.nome)
  const [ws, setWs] = useState<string[]>(screen.widgets)
  const toggle = (id: string) => setWs((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]))
  const move = (id: string, d: -1 | 1) =>
    setWs((w) => {
      const i = w.indexOf(id)
      const k = i + d
      if (i < 0 || k < 0 || k >= w.length) return w
      const n = [...w]
      ;[n[i], n[k]] = [n[k], n[i]]
      return n
    })
  return (
    <aside className="drawer" role="dialog" aria-label="Personalizar tela">
      <header>
        <h2>Personalizar tela</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Fechar">
          <X size={15} />
        </button>
      </header>
      <label className="field">
        <span>Nome da tela</span>
        <input value={nome} onChange={(e) => setNome(e.target.value)} />
      </label>
      <p className="muted small">Marque os widgets e use as setas para ordenar. A ordem vale de cima para baixo.</p>
      <ul className="wlist">
        {[...ws.map((id) => catalog.find((c) => c.id === id) ?? { id, nome: id, desc: '' }), ...catalog.filter((c) => !ws.includes(c.id))].map((c) => {
          const on = ws.includes(c.id)
          return (
            <li key={c.id} className={on ? 'on' : ''}>
              <label>
                <input type="checkbox" checked={on} onChange={() => toggle(c.id)} />
                <span className="check" aria-hidden="true" />
                <span>
                  <b>{c.nome}</b>
                  <small>{c.desc}</small>
                </span>
              </label>
              {on && (
                <span className="order">
                  <button onClick={() => move(c.id, -1)} aria-label={`Subir ${c.nome}`}>
                    <ArrowUp size={13} />
                  </button>
                  <button onClick={() => move(c.id, 1)} aria-label={`Descer ${c.nome}`}>
                    <ArrowDown size={13} />
                  </button>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <footer>
        <button className="ghost" onClick={onClose}>
          Cancelar
        </button>
        <button
          className="primary"
          onClick={() => {
            onSave({ ...screen, nome: nome.trim() || screen.nome, widgets: ws })
            onClose()
          }}
        >
          Salvar tela
        </button>
      </footer>
    </aside>
  )
}
