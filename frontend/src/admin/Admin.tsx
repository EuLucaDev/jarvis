import {
  Bot,
  BrainCircuit,
  CalendarDays,
  Cpu,
  LineChart,
  ScanFace,
  Camera,
  Home,
  BellRing,
  Music,
  Laptop,
  Smartphone,
  HeartPulse,
  NotebookPen,
  MessageCircle,
  Monitor,
  MessagesSquare,
  Newspaper,
  Plug,
  Plus,
  RefreshCw,
  Send,
  Sun,
  Trash2,
  X,
  Mail,
  Play,
  ExternalLink,
  Check,
  ScrollText,
  Sparkles,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../lib/api'
import { loadFace, openCamera, readFace } from '../lib/face'
import type { ScreenConfig, Telemetry } from '../lib/socket'
import { useJarvis } from '../hud/useJarvis'
import './admin.css'

type Page = 'chat' | 'briefing' | 'conexoes' | 'memorias' | 'financeiro' | 'presenca' | 'conversas' | 'telas' | 'sistema'

const NAV: { group: string; items: { id: Page; label: string; desc: string; icon: typeof Bot }[] }[] = [
  {
    group: 'Visão geral',
    items: [
      { id: 'chat', label: 'Chat', desc: 'Converse por texto', icon: MessagesSquare },
      { id: 'briefing', label: 'Briefing', desc: 'Agenda, e-mails, notícias e clima', icon: Sun },
    ],
  },
  {
    group: 'Dados e automação',
    items: [
      { id: 'conexoes', label: 'Conexões', desc: 'E-mail, agenda, casa, mercado', icon: Plug },
      { id: 'memorias', label: 'Memórias', desc: 'O que ele sabe sobre você', icon: BrainCircuit },
      { id: 'financeiro', label: 'Financeiro', desc: 'Bolsa, câmbio e cripto', icon: LineChart },
      { id: 'presenca', label: 'Presença', desc: 'Reconhecimento facial', icon: ScanFace },
    ],
  },
  {
    group: 'Sistema',
    items: [
      { id: 'telas', label: 'Telas', desc: 'Monitores extras e widgets', icon: Monitor },
      { id: 'conversas', label: 'Conversas', desc: 'Histórico e aprendizado', icon: ScrollText },
      { id: 'sistema', label: 'Sistema', desc: 'Modelos, saúde e logs', icon: Cpu },
    ],
  },
]

function currentPage(): Page {
  const raw = location.pathname.split('/')[2]
  const p = (raw === 'fontes' || raw === 'integracoes' ? 'conexoes' : raw) as Page
  return NAV.some((g) => g.items.some((i) => i.id === p)) ? p : 'chat'
}

export function Admin() {
  const [page, setPage] = useState<Page>(currentPage)
  const j = useJarvis('admin')
  useEffect(() => {
    const onPop = () => setPage(currentPage())
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])
  const go = (p: Page) => {
    history.pushState(null, '', `/admin/${p}`)
    setPage(p)
  }
  const meta = NAV.flatMap((g) => g.items).find((i) => i.id === page)!

  return (
    <div className="admin">
      <aside className="side-nav">
        <a className="brand" href="/">
          <span className="brand-mark" aria-hidden="true" />
          <span>
            <b>Jarvis</b>
            <small>Assistente de voz</small>
          </span>
        </a>
        {NAV.map((g) => (
          <nav key={g.group} aria-label={g.group}>
            <span className="nav-group">{g.group}</span>
            {g.items.map((it) => (
              <button key={it.id} className={`nav-item ${page === it.id ? 'active' : ''}`} onClick={() => go(it.id)}>
                <it.icon size={17} strokeWidth={1.75} />
                <span>
                  {it.label}
                  <small>{it.desc}</small>
                </span>
              </button>
            ))}
          </nav>
        ))}
        <a className="hud-open" href="/">
          <Bot size={16} strokeWidth={1.75} />
          <span>
            Abrir o HUD
            <small>{j.status.voice === 'live' ? 'Voz ao vivo agora' : 'Esfera de voz'}</small>
          </span>
        </a>
        <div className={`online ${j.online ? 'on' : ''}`}>
          <i /> {j.online ? 'Sistema online' : 'Reconectando'}
        </div>
      </aside>

      <main className="stage">
        <header className="page-head">
          <div>
            <h1>{meta.label}</h1>
            <p>{meta.desc}</p>
          </div>
        </header>
        <div className="page-body" key={page}>
          {page === 'chat' && <ChatPage />}
          {page === 'briefing' && <BriefingPage />}
          {page === 'conexoes' && <ConexoesPage />}
          {page === 'financeiro' && <FinanceiroPage />}
          {page === 'presenca' && <PresencaPage />}
          {page === 'memorias' && <MemoriasPage />}
          {page === 'conversas' && <ConversasPage />}
          {page === 'telas' && <TelasPage screensLive={j.screens} />}
          {page === 'sistema' && <SistemaPage t={j.telemetry} />}
        </div>
      </main>
    </div>
  )
}

/* ---------- peças ---------- */

function Panel({ title, desc, actions, children, className = '' }: { title?: string; desc?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel-a ${className}`}>
      {(title || actions) && (
        <header>
          <div>
            {title && <h2>{title}</h2>}
            {desc && <p>{desc}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  )
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <i />
      <span>{label}</span>
    </button>
  )
}

function useToast() {
  const [msg, setMsg] = useState<string | null>(null)
  const show = useCallback((m: string) => {
    setMsg(m)
    setTimeout(() => setMsg(null), 2600)
  }, [])
  const node = msg ? (
    <div className="toast" role="status">
      <Check size={14} /> {msg}
    </div>
  ) : null
  return [show, node] as const
}

/* ---------- chat ---------- */

type Msg = { papel: 'usuario' | 'jarvis'; texto: string; ferramentas?: string[] }
const SUGESTOES = ['Bom dia', 'Como está o tempo?', 'Quais as notícias de IA de hoje?', 'O que você sabe sobre mim?']

function ChatPage() {
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem('jarvis.chat') || '[]')
    } catch {
      return []
    }
  })
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    try {
      sessionStorage.setItem('jarvis.chat', JSON.stringify(msgs.slice(-40)))
    } catch {
      /* sem armazenamento */
    }
    end.current?.scrollIntoView({ block: 'end' })
  }, [msgs])

  const send = async (t: string) => {
    if (!t.trim() || busy) return
    const hist = msgs.map(({ papel, texto }) => ({ papel, texto }))
    setMsgs((m) => [...m, { papel: 'usuario', texto: t }])
    setText('')
    setBusy(true)
    try {
      const r = await api<{ resposta: string; ferramentas: string[] }>('/api/chat', { method: 'POST', json: { texto: t, historico: hist } })
      setMsgs((m) => [...m, { papel: 'jarvis', texto: r.resposta, ferramentas: r.ferramentas }])
    } catch {
      setMsgs((m) => [...m, { papel: 'jarvis', texto: 'Não consegui falar com o servidor. Ele está rodando?' }])
    } finally {
      setBusy(false)
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    send(text)
  }

  return (
    <div className="chat">
      <div className="chat-log">
        {msgs.length === 0 && (
          <div className="empty">
            <Sparkles size={22} strokeWidth={1.5} />
            <h3>O mesmo Jarvis da voz, por escrito</h3>
            <p>Ele usa as mesmas ferramentas: pesquisa, memória, briefing, computador. Os cartões aparecem no HUD.</p>
            <div className="sugs">
              {SUGESTOES.map((s) => (
                <button key={s} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`bubble ${m.papel}`}>
            <p>{m.texto}</p>
            {m.ferramentas && m.ferramentas.length > 0 && <small>Usou: {[...new Set(m.ferramentas)].join(', ')}</small>}
          </div>
        ))}
        {busy && (
          <div className="bubble jarvis typing">
            <i />
            <i />
            <i />
          </div>
        )}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Escreva para o Jarvis…" aria-label="Mensagem" />
        <button className="btn primary" disabled={!text.trim() || busy}>
          <Send size={15} /> Enviar
        </button>
      </form>
    </div>
  )
}

/* ---------- briefing ---------- */

function BriefingPage() {
  const [b, setB] = useState<Record<string, any> | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, toastNode] = useToast()
  useEffect(() => {
    api('/api/briefing').then(setB)
  }, [])
  const gerar = async () => {
    setBusy(true)
    try {
      setB(await api('/api/briefing/gerar', { method: 'POST' }))
      toast('Briefing atualizado')
    } finally {
      setBusy(false)
    }
  }
  const mostrar = async () => {
    await api('/api/briefing/apresentar', { method: 'POST' })
    toast('Cartões enviados ao HUD')
  }
  if (!b) return <p className="muted">Carregando…</p>
  if (!b.roteiro)
    return (
      <Panel title="Nenhum briefing ainda" desc="Ele é montado sozinho a cada poucos minutos. Você também pode gerar agora.">
        <button className="btn primary" onClick={gerar} disabled={busy}>
          <RefreshCw size={15} className={busy ? 'spin' : ''} /> {busy ? 'Montando…' : 'Gerar agora'}
        </button>
      </Panel>
    )
  const rot = b.roteiro
  const fala = [rot.abertura, ...rot.segmentos.map((s: any) => s.fala), rot.fechamento].join(' ')
  return (
    <div className="grid-brief">
      <div className="kpis">
        <Kpi icon={CalendarDays} label="Agenda" value={b.configurado?.agenda ? (b.agenda.length ? String(b.agenda.length) : 'Livre') : '—'} sub={b.configurado?.agenda ? (b.agenda.length ? 'compromissos hoje' : 'nenhum compromisso') : 'não configurada'} />
        <Kpi icon={Mail} label="Prioridade" value={b.configurado?.gmail ? String(b.emails.atencao.length) : '—'} sub={b.configurado?.gmail ? `de ${b.emails.total} não lidos` : 'Gmail não configurado'} accent />
        <Kpi icon={Newspaper} label="Radar" value={String(b.noticias.reduce((n: number, t: any) => n + t.itens.length, 0))} sub={`notícias em ${b.noticias.length} temas`} />
        <Kpi icon={Sun} label="Clima" value={b.clima ? `${fmt(b.clima.minima)}°–${fmt(b.clima.maxima)}°` : '—'} sub={b.clima ? `${b.clima.cidade} · ${b.clima.chuva}% de chuva` : 'desligado'} />
      </div>

      <Panel
        className="speak"
        title="Resumo executivo falável"
        desc={`${b.hoje} · montado às ${b.gerado}. É isto que ele lê quando você diz “bom dia”.`}
        actions={
          <div className="row">
            <button className="btn" onClick={mostrar}>
              <Play size={14} /> Mostrar no HUD
            </button>
            <button className="btn primary" onClick={gerar} disabled={busy}>
              <RefreshCw size={14} className={busy ? 'spin' : ''} /> {busy ? 'Montando…' : 'Gerar agora'}
            </button>
          </div>
        }
      >
        <p className="script">{fala}</p>
        {b.erros?.length > 0 && <p className="warn">Fontes com problema: {b.erros.join(' · ')}</p>}
      </Panel>

      <Panel title="Agenda consolidada" desc="Compromissos de hoje de todas as agendas.">
        {!b.configurado?.agenda ? (
          <p className="muted">Cole o link iCal da sua agenda em Fontes de dados.</p>
        ) : b.agenda.length === 0 ? (
          <p className="muted">Dia livre.</p>
        ) : (
          <ul className="rows">
            {b.agenda.map((e: any, i: number) => (
              <li key={i}>
                <time>{e.dia_todo ? 'Dia todo' : e.inicio}</time>
                <span>
                  <b>{e.titulo}</b>
                  {e.local && <small>{e.local}</small>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Caixa de entrada" desc="Não lidos das últimas 24 h que pedem ação.">
        {!b.configurado?.gmail ? (
          <p className="muted">Adicione sua conta Gmail com senha de app em Fontes de dados.</p>
        ) : b.emails.atencao.length === 0 ? (
          <p className="muted">Nada urgente. {b.emails.total} não lidos sem prioridade.</p>
        ) : (
          <ul className="rows">
            {b.emails.atencao.map((m: any, i: number) => (
              <li key={i}>
                <time>{m.data?.split(' ')[1]}</time>
                <span>
                  <b>{m.assunto}</b>
                  <small>
                    {m.de} · {m.motivo}
                  </small>
                </span>
                {m.acao && <em className="tag">{m.acao}</em>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Radar de notícias" desc="As mais relevantes de cada tema, da última semana." className="wide">
        <div className="news-grid">
          {b.noticias.map((n: any) => (
            <div key={n.tema} className="news-col">
              <span className="tag">{n.tema}</span>
              {n.itens.map((it: any, i: number) => (
                <a key={i} className="news-item" href={it.url} target="_blank" rel="noreferrer">
                  {i === 0 && it.imagem && <img src={it.imagem} alt="" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} />}
                  <b>{it.titulo}</b>
                  <small>
                    {[it.fonte, it.data].filter(Boolean).join(' · ')} <ExternalLink size={10} />
                  </small>
                </a>
              ))}
            </div>
          ))}
        </div>
      </Panel>
      {toastNode}
    </div>
  )
}

const fmt = (n: number) => n?.toLocaleString('pt-BR', { maximumFractionDigits: 0 })

function Kpi({ icon: Icon, label, value, sub, accent }: { icon: typeof Bot; label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <div className={`kpi ${accent ? 'accent' : ''}`}>
      <span className="kpi-label">
        <Icon size={15} strokeWidth={1.75} /> {label}
      </span>
      <b>{value}</b>
      <small>{sub}</small>
    </div>
  )
}

/* ---------- fontes ---------- */

function FontesPage({ only }: { only?: 'gmail' | 'agendas' | 'radar' }) {
  const [cfg, setCfg] = useState<Record<string, any> | null>(null)
  const [tests, setTests] = useState<{ fonte: string; ok: boolean; detalhe: string }[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [toast, toastNode] = useToast()
  useEffect(() => {
    api('/api/ajustes/briefing').then(setCfg)
  }, [])
  if (!cfg) return <p className="muted">Carregando…</p>
  const set = (k: string, v: unknown) => setCfg((c) => ({ ...c!, [k]: v }))
  const save = async () => {
    setSaving(true)
    try {
      setCfg(await api('/api/ajustes/briefing', { method: 'PUT', json: cfg }))
      toast('Fontes salvas')
    } finally {
      setSaving(false)
    }
  }
  const test = async () => {
    await save()
    setTests(await api('/api/ajustes/briefing/testar', { method: 'POST' }))
  }
  const list = (k: string) => (cfg[k] as any[]) ?? []
  const upd = (k: string, i: number, field: string, v: string) => set(k, list(k).map((x, j) => (j === i ? { ...x, [field]: v } : x)))

  return (
    <div className="stack">
      {(!only || only === 'gmail') && (
      <Panel
        title="Contas de e-mail"
        desc="Gmail por IMAP, só leitura. Crie uma senha de app em myaccount.google.com/apppasswords (precisa da verificação em duas etapas)."
        actions={
          <button className="btn" onClick={() => set('gmail', [...list('gmail'), { email: '', senha_app: '' }])}>
            <Plus size={14} /> Adicionar conta
          </button>
        }
      >
        {list('gmail').length === 0 && <p className="muted">Nenhuma conta. O briefing segue sem e-mails.</p>}
        {list('gmail').map((a, i) => (
          <div className="form-row" key={i}>
            <label className="field-a">
              <span>E-mail</span>
              <input value={a.email} onChange={(e) => upd('gmail', i, 'email', e.target.value)} placeholder="voce@gmail.com" />
            </label>
            <label className="field-a">
              <span>Senha de app</span>
              <input type="password" value={a.senha_app} onChange={(e) => upd('gmail', i, 'senha_app', e.target.value)} placeholder="16 letras" autoComplete="off" />
            </label>
            <button className="icon" onClick={() => set('gmail', list('gmail').filter((_, j) => j !== i))} aria-label="Remover conta">
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </Panel>

      )}
      {(!only || only === 'agendas') && (
      <Panel
        title="Agendas"
        desc="Google Agenda → Configurações da agenda → Endereço secreto em formato iCal. Cole o link que termina em .ics."
        actions={
          <button className="btn" onClick={() => set('agendas', [...list('agendas'), { nome: '', url: '' }])}>
            <Plus size={14} /> Adicionar agenda
          </button>
        }
      >
        {list('agendas').length === 0 && <p className="muted">Nenhuma agenda.</p>}
        {list('agendas').map((a, i) => (
          <div className="form-row" key={i}>
            <label className="field-a narrow">
              <span>Nome</span>
              <input value={a.nome} onChange={(e) => upd('agendas', i, 'nome', e.target.value)} placeholder="Pessoal" />
            </label>
            <label className="field-a">
              <span>Link iCal</span>
              <input value={a.url} onChange={(e) => upd('agendas', i, 'url', e.target.value)} placeholder="https://calendar.google.com/…/basic.ics" />
            </label>
            <button className="icon" onClick={() => set('agendas', list('agendas').filter((_, j) => j !== i))} aria-label="Remover agenda">
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </Panel>

      )}
      {(!only || only === 'radar') && (
      <Panel title="Radar e contexto" desc="Temas das notícias, fontes preferidas, cidade e ritmo de atualização.">
        <div className="form-grid">
          <label className="field-a span2">
            <span>Temas das notícias</span>
            <input value={cfg.temas.join(', ')} onChange={(e) => set('temas', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
            <small>Separe por vírgula. Cada tema vira um cartão no bom dia.</small>
          </label>
          <label className="field-a span2">
            <span>Fontes preferidas (sites)</span>
            <input value={(cfg.fontes ?? []).join(', ')} onChange={(e) => set('fontes', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} placeholder="g1.globo.com, tecmundo.com.br" />
            <small>Opcional. Sem fontes, ele busca em toda a imprensa.</small>
          </label>
          <label className="field-a">
            <span>Cidade</span>
            <input value={cfg.cidade} onChange={(e) => set('cidade', e.target.value)} />
          </label>
          <label className="field-a">
            <span>Fuso horário</span>
            <input value={cfg.fuso} onChange={(e) => set('fuso', e.target.value)} />
          </label>
          <label className="field-a">
            <span>Atualizar a cada (min)</span>
            <input inputMode="numeric" value={cfg.atualizar_min} onChange={(e) => set('atualizar_min', Number(e.target.value.replace(/\D/g, '')) || 15)} />
          </label>
          <label className="field-a">
            <span>Notícias por tema</span>
            <input inputMode="numeric" value={cfg.noticias_por_tema} onChange={(e) => set('noticias_por_tema', Math.min(6, Number(e.target.value.replace(/\D/g, '')) || 3))} />
          </label>
          <div className="span2">
            <Switch on={!!cfg.clima} onChange={(v) => set('clima', v)} label="Incluir o clima no bom dia" />
          </div>
        </div>
      </Panel>
      )}

      {tests && (
        <Panel title="Resultado do teste">
          {tests.length === 0 && <p className="muted">Nada para testar: adicione uma conta ou agenda.</p>}
          <ul className="rows">
            {tests.map((t, i) => (
              <li key={i}>
                <em className={`dot ${t.ok ? 'ok' : 'bad'}`} />
                <span>
                  <b>{t.fonte}</b>
                  <small>{t.detalhe}</small>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <div className="actions-bar">
        <button className="btn" onClick={test}>
          Testar conexões
        </button>
        <button className="btn primary" onClick={save} disabled={saving}>
          {saving ? 'Salvando…' : 'Salvar alterações'}
        </button>
      </div>
      {toastNode}
    </div>
  )
}

/* ---------- memórias ---------- */

const TIPO_LABEL: Record<string, string> = { perfil: 'Perfil', preferencia: 'Preferência', correcao: 'Correção', licao: 'Lição', nota: 'Nota' }

function MemoriasPage() {
  const [data, setData] = useState<{ tipos: Record<string, string>; itens: any[] } | null>(null)
  const [filtro, setFiltro] = useState<string>('todas')
  const [novo, setNovo] = useState('')
  const [tipo, setTipo] = useState('nota')
  const load = () => api('/api/memorias').then(setData)
  useEffect(() => {
    load()
  }, [])
  if (!data) return <p className="muted">Carregando…</p>
  const itens = data.itens.filter((m) => filtro === 'todas' || m.tipo === filtro)
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (!novo.trim()) return
    await api('/api/memorias', { method: 'POST', json: { tipo, texto: novo } })
    setNovo('')
    load()
  }
  const del = async (id: string) => {
    await api(`/api/memorias/${id}`, { method: 'DELETE' })
    load()
  }
  return (
    <div className="stack">
      <Panel title="Como ele aprende" desc="Ao fim de cada conversa, ele relê o que foi dito e guarda fatos, preferências, correções e lições. As mais importantes entram em toda conversa nova. Tudo fica no seu Mac (data/jarvis.db).">
        <form className="form-row" onSubmit={add}>
          <label className="field-a">
            <span>Ensinar algo</span>
            <input value={novo} onChange={(e) => setNovo(e.target.value)} placeholder="Ex.: Luca prefere reuniões depois das 10h." />
          </label>
          <div className="seg" role="radiogroup" aria-label="Tipo">
            {Object.keys(data.tipos).map((t) => (
              <button type="button" key={t} role="radio" aria-checked={tipo === t} className={tipo === t ? 'on' : ''} onClick={() => setTipo(t)}>
                {TIPO_LABEL[t] ?? t}
              </button>
            ))}
          </div>
          <button className="btn primary" disabled={!novo.trim()}>
            <Plus size={14} /> Guardar
          </button>
        </form>
      </Panel>
      <Panel
        title={`${data.itens.length} memórias`}
        actions={
          <div className="seg">
            {['todas', ...Object.keys(data.tipos)].map((t) => (
              <button key={t} className={filtro === t ? 'on' : ''} onClick={() => setFiltro(t)}>
                {t === 'todas' ? 'Todas' : (TIPO_LABEL[t] ?? t)} {t !== 'todas' && <small>{data.itens.filter((m) => m.tipo === t).length}</small>}
              </button>
            ))}
          </div>
        }
      >
        {itens.length === 0 ? (
          <p className="muted">Nada aqui ainda. Converse com ele ou ensine algo acima.</p>
        ) : (
          <ul className="rows mem">
            {itens.map((m) => (
              <li key={m.id}>
                <em className={`tag t-${m.tipo}`}>{TIPO_LABEL[m.tipo] ?? m.tipo}</em>
                <span>
                  <b>{m.texto}</b>
                  <small>
                    {m.fonte === 'reflexao' ? 'Aprendido sozinho' : m.fonte === 'pedido' ? 'Você pediu' : m.fonte === 'painel' ? 'Pelo painel' : m.fonte} ·{' '}
                    {new Date(m.atualizada * 1000).toLocaleDateString('pt-BR')} · usada {m.usos}×
                  </small>
                </span>
                <button className="icon" onClick={() => del(m.id)} aria-label="Esquecer">
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

/* ---------- conversas ---------- */

function ConversasPage() {
  const [conv, setConv] = useState<any[] | null>(null)
  useEffect(() => {
    api('/api/conversas').then(setConv)
  }, [])
  if (!conv) return <p className="muted">Carregando…</p>
  if (!conv.length) return <Panel title="Nenhuma conversa ainda" desc="As conversas por voz aparecem aqui com o que ele aprendeu de cada uma."><span /></Panel>
  return (
    <div className="stack">
      {conv.map((c) => (
        <Panel key={c.id} title={`Conversa de ${c.inicio}`} desc={c.refletida ? 'Já relida para aprendizado' : 'Será relida ao terminar'}>
          <ul className="convo">
            {c.turnos.map((t: any, i: number) => (
              <li key={i} className={t.papel}>
                <b>{t.papel === 'usuario' ? 'Você' : 'Jarvis'}</b>
                <span>{t.texto}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ))}
    </div>
  )
}

/* ---------- telas ---------- */

function TelasPage({ screensLive }: { screensLive: ScreenConfig[] | null }) {
  const [telas, setTelas] = useState<ScreenConfig[] | null>(null)
  const [nome, setNome] = useState('')
  useEffect(() => {
    api('/api/ajustes/telas').then(setTelas)
  }, [])
  useEffect(() => {
    if (screensLive) setTelas(screensLive)
  }, [screensLive])
  if (!telas) return <p className="muted">Carregando…</p>
  const save = async (list: ScreenConfig[]) => setTelas(await api('/api/ajustes/telas', { method: 'PUT', json: list }))
  const add = (e: FormEvent) => {
    e.preventDefault()
    const id = nome.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `tela-${telas.length + 1}`
    save([...telas, { id, nome: nome.trim(), widgets: ['relogio', 'cartoes'] }])
    setNome('')
  }
  return (
    <div className="stack">
      <Panel title="Como usar" desc="Abra o link de cada tela num navegador em tela cheia no monitor extra. Diga “Jarvis, ativar monitores” para desbloquear todas juntas. Os widgets se montam pela engrenagem dentro da própria tela.">
        <form className="form-row" onSubmit={add}>
          <label className="field-a">
            <span>Nova tela</span>
            <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Monitor da esquerda" />
          </label>
          <button className="btn primary" disabled={!nome.trim()}>
            <Plus size={14} /> Criar tela
          </button>
        </form>
      </Panel>
      <div className="cards-grid">
        {telas.map((t) => (
          <section className="panel-a screen-card" key={t.id}>
            <header>
              <div>
                <h2>{t.nome}</h2>
                <p>/tela/{t.id}</p>
              </div>
              <button className="icon" onClick={() => save(telas.filter((x) => x.id !== t.id))} aria-label={`Remover ${t.nome}`}>
                <X size={15} />
              </button>
            </header>
            <div className="chips">
              {t.widgets.map((w) => (
                <em className="tag" key={w}>
                  {w.replace(':', ' · ')}
                </em>
              ))}
            </div>
            <a className="btn" href={`/tela/${t.id}`} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> Abrir tela
            </a>
          </section>
        ))}
      </div>
    </div>
  )
}

/* ---------- integrações ---------- */

function IntegracoesPage({ only }: { only?: 'computador' | 'atalhos' | 'cameras' }) {
  const [disp, setDisp] = useState<string[] | null>(null)
  const [atalhos, setAtalhos] = useState<string[]>([])
  const [cams, setCams] = useState<{ id: string; nome: string; url: string }[]>([])
  const [toast, toastNode] = useToast()
  useEffect(() => {
    api<string[]>('/api/atalhos/disponiveis').then(setDisp).catch(() => setDisp([]))
    api<string[]>('/api/ajustes/atalhos').then(setAtalhos)
    api('/api/ajustes/cameras').then(setCams)
  }, [])
  const toggle = async (n: string) => {
    const next = atalhos.includes(n) ? atalhos.filter((x) => x !== n) : [...atalhos, n]
    setAtalhos(await api('/api/ajustes/atalhos', { method: 'PUT', json: next }))
  }
  const saveCams = async () => {
    const clean = cams
      .filter((c) => c.nome.trim() && c.url.trim())
      .map((c) => ({ ...c, id: c.id || c.nome.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-') }))
    setCams(await api('/api/ajustes/cameras', { method: 'PUT', json: clean }))
    toast('Câmeras salvas')
  }
  return (
    <div className="stack">
      {(!only || only === 'computador') && (
      <Panel title="Computador" desc="Por voz ele abre apps e sites, controla a música (Spotify ou Música) e ajusta o volume. Não executa comandos livres.">
        <div className="chips">
          {['Abrir app', 'Abrir site', 'Tocar / pausar', 'Próxima faixa', 'Volume', 'Brilho', 'Bloquear tela', 'Criar pasta', 'Achar e abrir arquivo', 'Organizar pasta', 'Compactar', 'Lixeira (com confirmação)', 'Lembretes no iPhone'].map((c) => (
            <em className="tag" key={c}>
              {c}
            </em>
          ))}
        </div>
      </Panel>
      )}

      {(!only || only === 'atalhos') && (
      <Panel
        title="Atalhos: celular, casa e Alexa"
        desc="O Jarvis roda Atalhos do macOS que você liberar aqui. Com eles você alcança o iPhone (mensagens, localização) e a Casa (HomeKit). Para a Alexa, use a conexão Alexa. Crie o atalho no app Atalhos com um nome claro, como “Apagar luzes da sala”."
      >
        {disp === null ? (
          <p className="muted">Lendo seus atalhos…</p>
        ) : disp.length === 0 ? (
          <p className="muted">Nenhum atalho encontrado no app Atalhos deste Mac. Crie um e volte aqui.</p>
        ) : (
          <ul className="rows">
            {disp.map((n) => (
              <li key={n}>
                <span>
                  <b>{n}</b>
                </span>
                <Switch on={atalhos.includes(n)} onChange={() => toggle(n)} label={atalhos.includes(n) ? 'Liberado' : 'Bloqueado'} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
      )}

      {(!only || only === 'cameras') && (
      <Panel
        title="Câmeras"
        desc="Endereço RTSP (rtsp://usuário:senha@ip:554/…) ou de foto HTTP. Ele mostra a imagem num cartão e consegue descrever o que vê. As telas extras podem ter um widget por câmera."
        actions={
          <button className="btn" onClick={() => setCams([...cams, { id: '', nome: '', url: '' }])}>
            <Plus size={14} /> Adicionar câmera
          </button>
        }
      >
        {cams.length === 0 && <p className="muted">Nenhuma câmera.</p>}
        {cams.map((c, i) => (
          <div className="form-row" key={i}>
            <label className="field-a narrow">
              <span>Nome</span>
              <input value={c.nome} onChange={(e) => setCams(cams.map((x, j) => (j === i ? { ...x, nome: e.target.value } : x)))} placeholder="Garagem" />
            </label>
            <label className="field-a">
              <span>Endereço</span>
              <input value={c.url} onChange={(e) => setCams(cams.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} placeholder="rtsp://…" />
            </label>
            <button className="icon" onClick={() => setCams(cams.filter((_, j) => j !== i))} aria-label="Remover câmera">
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        <div className="row end">
          <button className="btn primary" onClick={saveCams}>
            Salvar câmeras
          </button>
        </div>
      </Panel>
      )}
      {toastNode}
    </div>
  )
}

/* ---------- sistema ---------- */

function SistemaPage({ t }: { t: Telemetry | null }) {
  const [s, setS] = useState<Record<string, any>>({})
  const [logs, setLogs] = useState<any[]>([])
  useEffect(() => {
    const load = () => {
      api('/api/status').then(setS)
      api('/api/logs').then(setLogs)
    }
    load()
    const i = setInterval(load, 5000)
    return () => clearInterval(i)
  }, [])
  return (
    <div className="stack">
      <div className="kpis">
        <Kpi icon={Cpu} label="CPU" value={t ? `${t.cpu}%` : '—'} sub={t ? `memória ${t.ram}% · disco ${t.disco}%` : 'aguardando'} />
        <Kpi icon={Bot} label="Voz" value={s.voice === 'live' ? 'Ao vivo' : s.voice === 'off' ? 'Desligada' : (s.voice ?? '—')} sub={s.model ?? ''} accent={s.voice === 'live'} />
        <Kpi icon={BrainCircuit} label="Memórias" value={String(s.memorias ?? '—')} sub="guardadas no Mac" />
        <Kpi icon={Monitor} label="Telas" value={String(s.screens ?? '—')} sub={s.telas === 'ativas' ? 'desbloqueadas' : 'bloqueadas'} />
      </div>
      <Panel title="Configuração" desc="Definida no arquivo .env na pasta do projeto.">
        <dl className="kv-a">
          <dt>Modelo de voz</dt>
          <dd>{s.model}</dd>
          <dt>Modelo de texto</dt>
          <dd>{s.text_model}</dd>
          <dt>Voz</dt>
          <dd>{s.voice_name}</dd>
          <dt>Pesquisa</dt>
          <dd>{s.search === 'google' ? 'Google (busca embutida da Gemini)' : 'DuckDuckGo + Google Notícias (grátis)'}</dd>
          <dt>Cidade padrão</dt>
          <dd>{s.city}</dd>
          <dt>No ar há</dt>
          <dd>{s.uptime_min} min</dd>
        </dl>
      </Panel>
      <Panel title="Logs" desc="Últimos eventos do servidor.">
        <ul className="logs">
          {logs.slice(0, 120).map((l, i) => (
            <li key={i} className={l.nivel === 'WARNING' || l.nivel === 'ERROR' ? 'warn' : ''}>
              <time>{l.em}</time>
              <span>{l.origem.replace('jarvis.', '')}</span>
              <p>{l.texto}</p>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  )
}


/* ---------- conexões ---------- */

type ConnId = 'gmail' | 'agendas' | 'radar' | 'clima' | 'alexa' | 'atalhos' | 'lembretes' | 'cameras' | 'mercado' | 'computador' | 'musica'
type Conn = { id: ConnId | string; nome: string; desc: string; cat: string; icon: typeof Bot; soon?: boolean }

const CONNS: Conn[] = [
  { id: 'gmail', nome: 'Gmail', desc: 'E-mails que pedem ação no briefing', cat: 'Comunicação', icon: Mail },
  { id: 'agendas', nome: 'Google Agenda', desc: 'Compromissos de hoje e da semana', cat: 'Produtividade', icon: CalendarDays },
  { id: 'lembretes', nome: 'Lembretes da Apple', desc: 'Lembretes que chegam no iPhone', cat: 'Produtividade', icon: BellRing },
  { id: 'radar', nome: 'Notícias / radar', desc: 'Temas, fontes e cidade', cat: 'Informação', icon: Newspaper },
  { id: 'clima', nome: 'Clima', desc: 'Open-Meteo, sem conta', cat: 'Informação', icon: Sun },
  { id: 'mercado', nome: 'Cotações da bolsa', desc: 'Bolsa, câmbio e cripto', cat: 'Finanças', icon: LineChart },
  { id: 'alexa', nome: 'Alexa', desc: 'Luzes e aparelhos pelo Voice Monkey', cat: 'Casa e dispositivos', icon: Home },
  { id: 'atalhos', nome: 'Atalhos da Apple', desc: 'iPhone, HomeKit e automações', cat: 'Casa e dispositivos', icon: Smartphone },
  { id: 'cameras', nome: 'Câmeras', desc: 'RTSP ou foto HTTP', cat: 'Casa e dispositivos', icon: Camera },
  { id: 'computador', nome: 'Este Mac', desc: 'Apps, arquivos, volume, brilho', cat: 'Casa e dispositivos', icon: Laptop },
  { id: 'musica', nome: 'Spotify / Música', desc: 'Tocar, pausar, próxima', cat: 'Casa e dispositivos', icon: Music },
  { id: 'saude', nome: 'Apple Saúde / WHOOP', desc: 'Sono, treino e recuperação', cat: 'Saúde', icon: HeartPulse, soon: true },
  { id: 'notion', nome: 'Notion / Obsidian', desc: 'Notas e bancos de dados', cat: 'Produtividade', icon: NotebookPen, soon: true },
  { id: 'whatsapp', nome: 'WhatsApp / iMessage', desc: 'Mensagens novas e leitura', cat: 'Comunicação', icon: MessageCircle, soon: true },
]
const CATS = ['Todas', 'Produtividade', 'Comunicação', 'Informação', 'Finanças', 'Casa e dispositivos', 'Saúde']

function ConexoesPage() {
  const [cat, setCat] = useState('Todas')
  const [open, setOpen] = useState<string | null>(null)
  const [st, setSt] = useState<Record<string, boolean>>({})
  const load = useCallback(async () => {
    const [b, alexa, atalhos, cams] = await Promise.all([
      api('/api/ajustes/briefing'),
      api('/api/ajustes/alexa'),
      api<string[]>('/api/ajustes/atalhos'),
      api<any[]>('/api/ajustes/cameras'),
    ])
    setSt({
      gmail: (b.gmail ?? []).length > 0,
      agendas: (b.agendas ?? []).length > 0,
      radar: true,
      clima: !!b.clima,
      alexa: !!alexa.token && (alexa.dispositivos ?? []).length > 0,
      atalhos: atalhos.length > 0,
      cameras: cams.length > 0,
      lembretes: true,
      mercado: true,
      computador: true,
      musica: true,
    })
  }, [])
  useEffect(() => {
    load()
  }, [load])
  const list = CONNS.filter((c) => cat === 'Todas' || c.cat === cat)
  const conn = CONNS.find((c) => c.id === open)
  return (
    <div className="stack wide-stack">
      <p className="lead">O Jarvis lê as suas fontes para entender a sua rotina. Você escolhe o que conectar e controla cada conexão. Tudo fica neste Mac.</p>
      <div className="seg cats">
        {CATS.map((c) => (
          <button key={c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>
            {c}
          </button>
        ))}
      </div>
      <div className="conn-grid">
        {list.map((c) => {
          const on = st[c.id]
          return (
            <button key={c.id} className={`conn ${c.soon ? 'soon' : ''}`} onClick={() => !c.soon && setOpen(c.id)} disabled={c.soon}>
              <span className="conn-ico">
                <c.icon size={16} strokeWidth={1.6} />
              </span>
              <span className="conn-txt">
                <b>{c.nome}</b>
                <small className={on ? 'ok' : ''}>{c.soon ? c.desc : on ? 'Conectada · operacional' : c.desc}</small>
              </span>
              <em className={on ? 'ok' : ''}>{c.soon ? 'Em breve' : on ? '✓ Conectado' : '+ Adicionar'}</em>
            </button>
          )
        })}
      </div>
      {conn && (
        <aside className="drawer-a" role="dialog" aria-label={conn.nome}>
          <header>
            <h2>{conn.nome}</h2>
            <button
              className="icon"
              onClick={() => {
                setOpen(null)
                load()
              }}
              aria-label="Fechar"
            >
              <X size={16} />
            </button>
          </header>
          <div className="drawer-body">
            {(conn.id === 'gmail' || conn.id === 'agendas' || conn.id === 'radar') && <FontesPage only={conn.id} />}
            {conn.id === 'clima' && <FontesPage only="radar" />}
            {(conn.id === 'atalhos' || conn.id === 'cameras' || conn.id === 'computador') && <IntegracoesPage only={conn.id} />}
            {conn.id === 'alexa' && <AlexaForm />}
            {conn.id === 'mercado' && <MercadoForm />}
            {conn.id === 'lembretes' && (
              <Panel title="Lembretes da Apple" desc="Diga “me lembra amanhã às 9h de ligar para o banco”. O lembrete vai para o app Lembretes e aparece no iPhone pelo iCloud. Na primeira vez, o macOS pede permissão para o Terminal controlar o Lembretes.">
                <span />
              </Panel>
            )}
            {conn.id === 'musica' && (
              <Panel title="Spotify / Música" desc="Diga “pausa a música”, “próxima” ou “volta”. Funciona com o app que estiver aberto: Spotify ou Música.">
                <span />
              </Panel>
            )}
          </div>
        </aside>
      )}
    </div>
  )
}

function AlexaForm() {
  const [cfg, setCfg] = useState<{ token: string; dispositivos: { nome: string; ligar: string; desligar: string }[] } | null>(null)
  const [toast, toastNode] = useToast()
  useEffect(() => {
    api('/api/ajustes/alexa').then(setCfg)
  }, [])
  if (!cfg) return <p className="muted">Carregando…</p>
  const devs = cfg.dispositivos ?? []
  const upd = (i: number, k: string, v: string) => setCfg({ ...cfg, dispositivos: devs.map((d, j) => (j === i ? { ...d, [k]: v } : d)) })
  const save = async () => {
    setCfg(await api('/api/ajustes/alexa', { method: 'PUT', json: { ...cfg, dispositivos: devs.filter((d) => d.nome.trim()) } }))
    toast('Alexa salva')
  }
  return (
    <div className="stack">
      <Panel title="Como ligar a Alexa" desc="1. Crie uma conta grátis em voicemonkey.io e ative a skill Voice Monkey no app Alexa. 2. No painel do Voice Monkey, crie um “dispositivo” para cada ação (ex.: luz-sala-on, luz-sala-off) e uma rotina na Alexa para cada um. 3. Cole o token abaixo e cadastre os aparelhos com os IDs.">
        <label className="field-a">
          <span>Token do Voice Monkey</span>
          <input type="password" value={cfg.token} onChange={(e) => setCfg({ ...cfg, token: e.target.value })} placeholder="Cole o token da API" autoComplete="off" />
        </label>
      </Panel>
      <Panel
        title="Aparelhos"
        desc="O nome é como você fala (“luz da sala”). Os IDs são os do Voice Monkey."
        actions={
          <button className="btn" onClick={() => setCfg({ ...cfg, dispositivos: [...devs, { nome: '', ligar: '', desligar: '' }] })}>
            <Plus size={14} /> Adicionar aparelho
          </button>
        }
      >
        {devs.length === 0 && <p className="muted">Nenhum aparelho.</p>}
        {devs.map((d, i) => (
          <div className="form-row" key={i}>
            <label className="field-a narrow">
              <span>Nome</span>
              <input value={d.nome} onChange={(e) => upd(i, 'nome', e.target.value)} placeholder="luz da sala" />
            </label>
            <label className="field-a narrow">
              <span>ID para ligar</span>
              <input value={d.ligar} onChange={(e) => upd(i, 'ligar', e.target.value)} placeholder="luz-sala-on" />
            </label>
            <label className="field-a narrow">
              <span>ID para desligar</span>
              <input value={d.desligar} onChange={(e) => upd(i, 'desligar', e.target.value)} placeholder="luz-sala-off" />
            </label>
            <button className="icon" onClick={() => setCfg({ ...cfg, dispositivos: devs.filter((_, j) => j !== i) })} aria-label="Remover aparelho">
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        <div className="row end">
          <button className="btn primary" onClick={save}>
            Salvar Alexa
          </button>
        </div>
      </Panel>
      {toastNode}
    </div>
  )
}

function MercadoForm() {
  const [ativos, setAtivos] = useState<string>('')
  const [toast, toastNode] = useToast()
  useEffect(() => {
    api('/api/ajustes/mercado').then((m) => setAtivos((m.ativos ?? []).join(', ')))
  }, [])
  const save = async () => {
    await api('/api/ajustes/mercado', { method: 'PUT', json: { ativos: ativos.split(',').map((a) => a.trim().toUpperCase()).filter(Boolean) } })
    toast('Carteira salva')
  }
  return (
    <div className="stack">
      <Panel title="Carteira acompanhada" desc="Símbolos do Yahoo Finance separados por vírgula. Ações brasileiras terminam em .SA (PETR4.SA), dólar é BRL=X, Ibovespa é ^BVSP, Bitcoin é BTC-USD.">
        <label className="field-a">
          <span>Ativos</span>
          <input value={ativos} onChange={(e) => setAtivos(e.target.value)} />
        </label>
        <div className="row end">
          <button className="btn primary" onClick={save}>
            Salvar carteira
          </button>
        </div>
      </Panel>
      {toastNode}
    </div>
  )
}

/* ---------- financeiro ---------- */

const PERIODOS = [
  { id: '1d', nome: 'Hoje' },
  { id: '5d', nome: '5 dias' },
  { id: '1mo', nome: '1 mês' },
  { id: '6mo', nome: '6 meses' },
  { id: '1y', nome: '1 ano' },
]

function FinanceiroPage() {
  const [periodo, setPeriodo] = useState('1mo')
  const [dados, setDados] = useState<any[] | null>(null)
  useEffect(() => {
    setDados(null)
    api<any[]>(`/api/mercado?periodo=${periodo}`).then(setDados).catch(() => setDados([]))
  }, [periodo])
  return (
    <div className="stack wide-stack">
      <div className="row between">
        <p className="lead">Cotações da sua carteira. Cada número vem do Yahoo Finance; o Jarvis organiza, não inventa.</p>
        <div className="seg">
          {PERIODOS.map((p) => (
            <button key={p.id} className={periodo === p.id ? 'on' : ''} onClick={() => setPeriodo(p.id)}>
              {p.nome}
            </button>
          ))}
        </div>
      </div>
      {dados === null ? (
        <p className="muted">Buscando cotações…</p>
      ) : dados.length === 0 ? (
        <Panel title="Sem cotações agora" desc="O Yahoo Finance não respondeu. Tente de novo em instantes ou revise a carteira em Conexões.">
          <span />
        </Panel>
      ) : (
        <div className="fin-grid">
          {dados.map((a) => (
            <section className="panel-a fin" key={a.simbolo}>
              <header>
                <div>
                  <h2>{a.nome}</h2>
                  <p>{a.simbolo}</p>
                </div>
                <em className={`tag ${(a.variacao ?? 0) >= 0 ? 'pos' : 'neg'}`}>
                  {a.variacao == null ? '—' : `${a.variacao > 0 ? '+' : ''}${a.variacao.toLocaleString('pt-BR')}% no dia`}
                </em>
              </header>
              <b className="fin-price">
                {a.preco.toLocaleString('pt-BR', { minimumFractionDigits: a.preco < 100 ? 2 : 0, maximumFractionDigits: a.preco < 100 ? 2 : 0 })}
                <small> {a.moeda}</small>
              </b>
              <LineMini serie={a.serie} />
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function LineMini({ serie }: { serie: number[] }) {
  if (!serie || serie.length < 2) return null
  const min = Math.min(...serie)
  const max = Math.max(...serie)
  const w = 300
  const h = 90
  const pts = serie.map((v, i) => [(i / (serie.length - 1)) * w, h - 6 - ((v - min) / (max - min || 1)) * (h - 12)])
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const up = serie.at(-1)! >= serie[0]
  return (
    <svg className={`line-mini ${up ? 'up' : 'down'}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${d} L${w},${h} L0,${h} Z`} className="area" />
      <path d={d} className="stroke" />
    </svg>
  )
}

/* ---------- presença ---------- */

function PresencaPage() {
  const [info, setInfo] = useState<{ nome: string; amostras: number } | null>(null)
  const [cfg, setCfg] = useState<{ briefing_auto: boolean } | null>(null)
  const [cam, setCam] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const load = useCallback(() => {
    api('/api/rosto').then(setInfo)
    api('/api/ajustes/presenca').then(setCfg)
  }, [])
  useEffect(() => {
    load()
    return () => stream.current?.getTracks().forEach((t) => t.stop())
  }, [load])

  const startCam = async () => {
    try {
      setStatus('Carregando o modelo de rosto…')
      await loadFace()
      stream.current = await openCamera(640)
      video.current!.srcObject = stream.current
      await video.current!.play()
      setCam(true)
      setStatus('Olhe para a câmera, com o rosto bem iluminado.')
    } catch {
      setStatus('Não consegui abrir a câmera. Libere o acesso no navegador.')
    }
  }

  const enroll = async () => {
    if (!video.current) return
    setBusy(true)
    const got: number[][] = []
    for (let i = 0; i < 12 && got.length < 6; i++) {
      setStatus(`Capturando amostra ${got.length + 1} de 6… mexa a cabeça devagar.`)
      const f = await readFace(video.current)
      if (f && f.score > 0.7) got.push(f.descriptor)
      await new Promise((r) => setTimeout(r, 450))
    }
    if (got.length < 3) {
      setStatus('Não vi seu rosto com clareza. Chegue mais perto da luz e tente de novo.')
    } else {
      await api('/api/rosto', { method: 'PUT', json: { descritores: got } })
      setStatus(`Pronto: ${got.length} amostras salvas. Ligue a Presença no HUD (ícone de rosto).`)
      load()
    }
    setBusy(false)
  }

  const test = async () => {
    if (!video.current) return
    const r = await api<{ descritores: number[][] }>('/api/rosto')
    const f = await readFace(video.current)
    if (!f) return setStatus('Nenhum rosto na imagem.')
    const { distance, MATCH } = await import('../lib/face')
    const d = distance(f.descriptor, r.descritores)
    setStatus(d < MATCH ? `Reconhecido (distância ${d.toFixed(2)}).` : `Não reconhecido (distância ${d.toFixed(2)}; precisa ser menor que ${MATCH}).`)
  }

  return (
    <div className="stack">
      <Panel title="Reconhecimento facial" desc="O HUD procura um rosto pela câmera. Se for você, desbloqueia as telas e, de manhã, abre o briefing sozinho. Roda no navegador; só os números do rosto ficam salvos neste Mac.">
        <div className="face-enroll">
          <video ref={video} muted playsInline className={cam ? 'on' : ''} />
          {!cam && <div className="face-ph">Câmera desligada</div>}
        </div>
        <p className="muted">{status || (info?.amostras ? `${info.amostras} amostras cadastradas para ${info.nome}.` : 'Nenhum rosto cadastrado ainda.')}</p>
        <div className="row">
          {!cam ? (
            <button className="btn primary" onClick={startCam}>
              <Camera size={14} /> Ligar câmera
            </button>
          ) : (
            <>
              <button className="btn primary" onClick={enroll} disabled={busy}>
                <ScanFace size={14} /> {info?.amostras ? 'Cadastrar de novo' : 'Cadastrar meu rosto'}
              </button>
              {!!info?.amostras && (
                <button className="btn" onClick={test} disabled={busy}>
                  Testar reconhecimento
                </button>
              )}
            </>
          )}
          {!!info?.amostras && (
            <button
              className="btn"
              onClick={async () => {
                await api('/api/rosto', { method: 'DELETE' })
                load()
                setStatus('Rosto apagado.')
              }}
            >
              <Trash2 size={14} /> Apagar rosto
            </button>
          )}
        </div>
      </Panel>
      {cfg && (
        <Panel title="Ao reconhecer você">
          <Switch
            on={!!cfg.briefing_auto}
            onChange={async (v) => setCfg(await api('/api/ajustes/presenca', { method: 'PUT', json: { ...cfg, briefing_auto: v } }))}
            label="Abrir o briefing de bom dia sozinho (uma vez por dia, entre 5h e 12h)"
          />
        </Panel>
      )}
    </div>
  )
}
