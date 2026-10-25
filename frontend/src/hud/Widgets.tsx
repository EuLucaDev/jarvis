// Widgets dos painéis do HUD (agenda, e-mails, notícias, sistema, câmeras…), com os dados do briefing.
import { CalendarDays, Mail, Newspaper } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { Telemetry } from '../lib/socket'
import { usePhase } from '../lib/live'
import { Aura } from '../ui/Aura'
import { CardView } from './Cards'
import type { Jarvis } from './useJarvis'

type Briefing = Record<string, any>
type J = Jarvis

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
  const card = j.cards.at(-1)
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

function upsert(l: { quem: string; texto: string }[], quem: string, texto: string, append = false) {
  const last = l.at(-1)
  if (last && last.quem === quem) {
    const t = append && !texto.startsWith(last.texto.slice(0, 10)) ? `${last.texto} ${texto}` : texto
    return [...l.slice(0, -1), { quem, texto: t.slice(-280) }]
  }
  return [...l, { quem, texto }].slice(-6)
}

function OrbWidget() {
  const fase = usePhase()
  return (
    <div className="w-orb">
      <span className="w-label">{({ espera: 'Em espera', ouvindo: 'Ouvindo', pensando: 'Pensando', falando: 'Falando' } as const)[fase]}</span>
      <Aura maxRes={360} />
    </div>
  )
}

function Widget({ id, j, brief, card, lines, cams }: { id: string; j: J; brief: Briefing; card: any; lines: { quem: string; texto: string }[]; cams: { id: string; nome: string }[] }) {
  const [kind, arg] = id.split(/:(.*)/s)
  if (kind === 'orbe') return <OrbWidget />
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
