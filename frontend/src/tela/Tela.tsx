import { ArrowDown, ArrowUp, CalendarDays, Expand, Lock, Mail, Newspaper, RefreshCw, Settings2, Unlock, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { ScreenConfig, Telemetry } from '../lib/socket'
import { CardView } from '../hud/Cards'
import { Orb } from '../hud/Orb'
import { useJarvis } from '../hud/useJarvis'

// Catálogo de widgets. "noticias:<tema>" e "camera:<id>" são gerados a partir dos ajustes.
const BASE_WIDGETS: { id: string; nome: string; desc: string }[] = [
  { id: 'orbe', nome: 'Orbe de voz', desc: 'A esfera sincronizada com a voz do Jarvis.' },
  { id: 'relogio', nome: 'Relógio', desc: 'Hora e data grandes.' },
  { id: 'agenda', nome: 'Agenda', desc: 'Próximos 7 dias, com o próximo compromisso em destaque.' },
  { id: 'emails', nome: 'Comunicações', desc: 'E-mails que pedem ação e outros relevantes.' },
  { id: 'clima', nome: 'Clima', desc: 'Condição agora e máxima do dia.' },
  { id: 'cartoes', nome: 'Cartões visuais', desc: 'O cartão que o Jarvis está mostrando agora.' },
  { id: 'sistema', nome: 'Sistema', desc: 'CPU, memória, disco, rede e bateria do Mac.' },
  { id: 'transcricao', nome: 'Transcrição', desc: 'Última fala sua e do Jarvis.' },
  { id: 'sessao', nome: 'Sessão', desc: 'Estado da voz, modelo e memória.' },
]

type Briefing = Record<string, any>
type J = ReturnType<typeof useJarvis>

/** Dados que os widgets usam (briefing, câmeras, transcrição); serve à tela extra e ao HUD. */
export function useWidgetData(j: J) {
  const [brief, setBrief] = useState<Briefing>({})
  const [cams, setCams] = useState<{ id: string; nome: string }[]>([])
  const [lines, setLines] = useState<{ quem: string; texto: string }[]>([])
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => {
    api('/api/ajustes/cameras').then(setCams).catch(() => {})
    const load = () => api<Briefing>('/api/briefing').then(setBrief).catch(() => {})
    load()
    const t = setInterval(load, 120000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (j.userLine) setLines((l) => upsert(l, 'Você', j.userLine))
  }, [j.userLine])
  useEffect(() => {
    if (j.caption) setLines((l) => upsert(l, 'Jarvis', j.caption, true))
  }, [j.caption])
  const refresh = async () => {
    setRefreshing(true)
    try {
      setBrief(await api('/api/briefing/gerar', { method: 'POST' }))
    } finally {
      setRefreshing(false)
    }
  }
  const temas: string[] = (brief.noticias ?? []).map((n: any) => n.tema)
  return { brief, cams, lines, refresh, refreshing, temas }
}
export type WidgetData = ReturnType<typeof useWidgetData>

/** Visões prontas (abas). A primeira é a própria tela, quando houver. */
export function standardViews(temas: string[]) {
  return [
    { id: 'agenda', nome: 'Agenda tática', widgets: ['agenda', 'relogio', 'clima'] },
    { id: 'comunicacoes', nome: 'Comunicações', widgets: ['emails', 'transcricao'] },
    { id: 'radar', nome: 'Radar de notícias', widgets: temas.map((t) => `noticias:${t}`) },
    { id: 'nucleo', nome: 'Núcleo do sistema', widgets: ['sistema', 'sessao', 'transcricao'] },
  ]
}

export function WidgetGrid({ j, widgets, data }: { j: J; widgets: string[]; data: WidgetData }) {
  const card = j.cards.find((c) => c.id === j.focusId) ?? j.cards.at(-1)
  return (
    <>
      {widgets.map((w, i) => (
        <div className={`widget w-${w.split(':')[0]}`} key={w} style={{ animationDelay: `${i * 90}ms` }}>
          <Widget id={w} j={j} brief={data.brief} card={card} lines={data.lines} cams={data.cams} />
        </div>
      ))}
    </>
  )
}

export function Tela({ id }: { id: string }) {
  const j = useJarvis('tela', `&tela=${encodeURIComponent(id)}`)
  const data = useWidgetData(j)
  const { brief, cams, refresh, refreshing } = data
  const [all, setAll] = useState<ScreenConfig[] | null>(null)
  const [editing, setEditing] = useState(false)
  const [phase, setPhase] = useState<'locked' | 'unlocking' | 'open'>('locked')
  const [view, setView] = useState<string>(() => {
    try {
      return localStorage.getItem(`jarvis.tela.${id}`) || 'propria'
    } catch {
      return 'propria'
    }
  })
  const now = useNow()
  const prev = useRef(j.status.telas)
  useEffect(() => {
    try {
      localStorage.setItem(`jarvis.tela.${id}`, view)
    } catch {
      /* só nesta aba */
    }
  }, [id, view])

  useEffect(() => {
    api<ScreenConfig[]>('/api/ajustes/telas').then(setAll)
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

  const views = [{ id: 'propria', nome: screen?.nome ?? 'Esta tela', widgets: screen?.widgets ?? [] }, ...standardViews(data.temas)]
  // sem aba repetida quando a tela já tem o nome de uma visão pronta
  const own = views[0].nome.toLowerCase()
  for (let i = views.length - 1; i > 0; i--) if (views[i].nome.toLowerCase() === own) views.splice(i, 1)
  const current = views.find((v) => v.id === view) ?? views[0]
  const widgets = current.widgets

  return (
    <main className={`tela tela-${phase} ${phase === 'open' ? 'has-tabs' : ''}`}>
      <div className="hud-grid" aria-hidden="true" />
      <header className="tela-bar">
        <b className="tb-brand">JARVIS</b>
        <span className="tb-name">{current.nome}</span>
        <span className="hud-spacer" />
        <span className={`hud-dot ${j.online ? 'on' : ''}`} />
        <span>{j.online ? 'Sincronizado' : 'Reconectando'}</span>
        <time className="tb-clock">{now.toLocaleTimeString('pt-BR')}</time>
        <button className="icon-btn" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())} aria-label="Tela cheia">
          <Expand size={14} />
        </button>
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
        <nav className="tabs" aria-label="Visões desta tela">
          {views.map((v) => (
            <button key={v.id} className={v.id === current.id ? 'on' : ''} onClick={() => setView(v.id)}>
              {v.nome}
            </button>
          ))}
        </nav>
      )}

      {phase === 'open' && (
        <section className="widgets" key={current.id}>
          <WidgetGrid j={j} widgets={widgets} data={data} />
          {widgets.length === 0 && <p className="muted">Nenhum widget nesta visão. Abra a engrenagem para montar.</p>}
        </section>
      )}

      {phase === 'open' && (
        <footer className="tela-foot">
          <span>{current.nome}</span>
          <button className="unlock-btn" onClick={refresh} disabled={refreshing}>
            <RefreshCw size={12} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Atualizando…' : 'Atualizar dados'}
          </button>
          <span>Monitor ativo</span>
        </footer>
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
  if (kind === 'agenda') return <AgendaWeek brief={brief} />
  if (kind === 'emails') return <Comms brief={brief} />
  if (kind === 'noticias') {
    const n = (brief.noticias ?? []).find((x: any) => x.tema === arg)
    return n ? <Radar tema={arg} itens={n.itens} /> : <Empty title={`Radar · ${arg}`} text="Aparece depois do próximo briefing." />
  }
  if (kind === 'camera') {
    const cam = cams.find((c) => c.id === arg)
    return cam ? <CamFeed id={cam.id} nome={cam.nome} /> : <Empty title="Câmera" text="Câmera removida dos ajustes." />
  }
  return <Empty title={id} text="Carregando dados do briefing…" />
}

function TW({ icon: Icon, eyebrow, title, tag, foot, children }: { icon: typeof Mail; eyebrow: string; title: string; tag?: string; foot: string; children: React.ReactNode }) {
  return (
    <div className="tw">
      <header>
        <span className="tw-ico">
          <Icon size={15} strokeWidth={1.6} />
        </span>
        <div>
          <span className="tw-eye">{eyebrow}</span>
          <h3>{title}</h3>
        </div>
        {tag && <em className="tw-tag">{tag}</em>}
      </header>
      {children}
      <footer>{foot}</footer>
    </div>
  )
}

const DIAS = ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.']
function fmtDay(iso: string) {
  const d = new Date(`${iso}T12:00:00`)
  const today = new Date()
  const diff = Math.round((d.setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / 86400000)
  if (diff === 0) return 'Hoje'
  if (diff === 1) return 'Amanhã'
  const dd = new Date(`${iso}T12:00:00`)
  return `${DIAS[dd.getDay()]} ${dd.getDate()}/${dd.getMonth() + 1}`
}

function AgendaWeek({ brief }: { brief: Briefing }) {
  const evs: any[] = brief.agenda_semana ?? brief.agenda ?? []
  const nowHM = new Date().toTimeString().slice(0, 5)
  const todayIso = new Date().toISOString().slice(0, 10)
  const next = evs.find((e) => e.data > todayIso || (e.data === todayIso && (e.dia_todo || (e.inicio ?? '') >= nowHM))) ?? null
  const rest = evs.filter((e) => e !== next).slice(0, 5)
  return (
    <TW icon={CalendarDays} eyebrow="Agenda · Próximos 7 dias" title="Seu período organizado" tag="7 dias" foot="Agenda · leitura atual">
      {!brief.configurado?.agenda ? (
        <p className="muted small">Conecte sua agenda em Painel → Conexões.</p>
      ) : !next ? (
        <p className="muted small">Nada marcado para os próximos 7 dias.</p>
      ) : (
        <div className="ag-grid">
          <div className="ag-next">
            <span className="tw-eye">● Próximo</span>
            <div className="ag-time">
              <b>{next.dia_todo ? 'Dia' : next.inicio}</b>
              <span>{next.titulo}</span>
            </div>
            <small>
              {fmtDay(next.data)}
              {next.local ? ` · ${next.local}` : ''}
            </small>
          </div>
          <ul className="ag-list">
            {rest.map((e, i) => (
              <li key={i}>
                <time>{e.dia_todo ? 'dia' : e.inicio}</time>
                <span>
                  {e.titulo}
                  <small>{fmtDay(e.data)}</small>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </TW>
  )
}

function Comms({ brief }: { brief: Briefing }) {
  const e = brief.emails ?? { atencao: [], relevantes: [], total: 0 }
  const items: any[] = e.atencao ?? []
  const rel: any[] = e.relevantes ?? []
  return (
    <TW icon={Mail} eyebrow="Comunicações · E-mail" title="Pedem sua atenção" foot="Triagem do briefing · itens verificados">
      {!brief.configurado?.gmail ? (
        <p className="muted small">Conecte o Gmail em Painel → Conexões.</p>
      ) : (
        <>
          <div className="cm-count">
            <b>{items.length}</b>
            <span>{items.length === 1 ? 'mensagem exige ação' : 'mensagens exigem ação'}</span>
          </div>
          {items.length > 0 && <span className="tw-sub">Precisam de ação</span>}
          <ol className="cm-list">
            {items.map((m, i) => (
              <li key={i}>
                <i>{String(i + 1).padStart(2, '0')}</i>
                <span>
                  <b>{m.de}</b>
                  {m.motivo || m.assunto}
                </span>
              </li>
            ))}
          </ol>
          {rel.length > 0 && <span className="tw-sub">Outros relevantes</span>}
          <ol className="cm-list dim">
            {rel.map((m, i) => (
              <li key={i}>
                <span>
                  <b>{m.de}</b>
                  {m.assunto}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </TW>
  )
}

function Radar({ tema, itens }: { tema: string; itens: any[] }) {
  const [top, ...rest] = itens
  return (
    <TW icon={Newspaper} eyebrow="Radar · Notícias" title={tema} tag="Notícias" foot="Curadoria atual · fontes verificadas">
      <div className="rd-grid">
        <a className="rd-top" href={top.url} target="_blank" rel="noreferrer" style={top.imagem ? { backgroundImage: `linear-gradient(180deg, rgb(3 10 26 / 0.15), rgb(3 10 26 / 0.92)), url(${top.imagem})` } : undefined}>
          <span className="tw-eye">● Destaque</span>
          <b>{top.titulo}</b>
          <small>{[top.fonte, top.data].filter(Boolean).join(' · ')}</small>
        </a>
        <ol className="rd-list">
          {rest.slice(0, 2).map((n, i) => (
            <li key={i}>
              <i>{String(i + 2).padStart(2, '0')}</i>
              <a href={n.url} target="_blank" rel="noreferrer">
                <span className="tw-eye">{n.fonte}</span>
                {n.titulo}
              </a>
            </li>
          ))}
        </ol>
      </div>
    </TW>
  )
}

function useNow() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
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
