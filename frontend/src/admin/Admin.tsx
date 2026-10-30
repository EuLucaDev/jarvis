import {
  Bot,
  Brain,
  BrainCircuit,
  FolderOpen,
  Hand,
  CalendarDays,
  Cpu,
  LineChart,
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
  Wallet,
  Workflow,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../lib/api'
import { app, isApp } from '../lib/app'
import type { Telemetry } from '../lib/socket'
import { useJarvis } from '../hud/useJarvis'
import './admin.css'

type Page = 'chat' | 'briefing' | 'conexoes' | 'operacoes' | 'gestos' | 'memorias' | 'financeiro' | 'saude' | 'conversas' | 'sistema'

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
      { id: 'operacoes', label: 'Operações', desc: 'Rotinas, horários e tarefas para outras IAs', icon: Workflow },
      { id: 'gestos', label: 'Gestos', desc: 'O que cada gesto da mão faz', icon: Hand },
      { id: 'memorias', label: 'Memórias', desc: 'O que ele sabe sobre você', icon: BrainCircuit },
      { id: 'financeiro', label: 'Mercado', desc: 'Bolsa, câmbio e cripto', icon: LineChart },
      { id: 'saude', label: 'Saúde', desc: 'Passos, sono e treinos', icon: HeartPulse },
    ],
  },
  {
    group: 'Sistema',
    items: [
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
        <a
          className="hud-open"
          href="/financeiro/"
          onClick={(e) => {
            if (isApp) {
              e.preventDefault()
              app.openFinance()
            }
          }}
        >
          <Wallet size={16} strokeWidth={1.75} />
          <span>
            Abrir o financeiro
            <small>Contas, cartões, metas e relatórios</small>
          </span>
        </a>
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
          {page === 'operacoes' && <OperacoesPage tasks={j.tasks} />}
          {page === 'gestos' && <GestosPage />}
          {page === 'financeiro' && <FinanceiroPage />}
          {page === 'saude' && <SaudePage />}
          {page === 'memorias' && <MemoriasPage />}
          {page === 'conversas' && <ConversasPage />}
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
      <Panel title="Radar e contexto" desc="Temas das notícias, fontes preferidas e ritmo de atualização. A cidade é a da configuração inicial (ícone → Configuração inicial); o fuso é o do computador.">
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
  const [zerar, setZerar] = useState('')
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
      <Panel
        title="Mapa da memória"
        desc="Você no centro, os temas em volta e cada memória ligada aos temas e às parecidas. Ao buscar, ele segue as ligações. Também abre por voz: “Jarvis, mostre minha memória”."
        actions={
          <div className="seg">
            <button onClick={() => (isApp ? app.openMemory() : window.open('/memoria', '_blank'))}>
              <Brain size={13} /> Abrir o mapa
            </button>
            <button onClick={() => api('/api/memoria/pasta', { method: 'POST' })}>
              <FolderOpen size={13} /> Abrir como notas (Obsidian)
            </button>
          </div>
        }
      >
        {null}
      </Panel>
      <Panel title="Como ele aprende" desc="Ao fim de cada conversa, ele relê o que foi dito e guarda fatos, preferências, correções e lições, já ligados aos temas. As mais importantes entram em toda conversa nova. Tudo fica neste computador.">
        <form className="form-row" onSubmit={add}>
          <label className="field-a">
            <span>Ensinar algo</span>
            <input value={novo} onChange={(e) => setNovo(e.target.value)} placeholder="Ex.: Prefiro reuniões depois das 10h." />
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
      <Panel title="Começar do zero" desc="Apaga todas as memórias, temas e conversas guardadas. Não dá para desfazer.">
        <form
          className="form-row"
          onSubmit={async (e) => {
            e.preventDefault()
            if (zerar !== 'APAGAR') return
            await api('/api/memoria/zerar', { method: 'POST', json: { confirmar: 'APAGAR' } })
            setZerar('')
            load()
          }}
        >
          <label className="field-a">
            <span>Digite APAGAR para confirmar</span>
            <input value={zerar} onChange={(e) => setZerar(e.target.value)} placeholder="APAGAR" />
          </label>
          <button className="btn danger" disabled={zerar !== 'APAGAR'}>
            <Trash2 size={14} /> Apagar toda a memória
          </button>
        </form>
      </Panel>
    </div>
  )
}

/* ---------- sistemas conectados (MCP) ---------- */

function SistemasForm() {
  const [lista, setLista] = useState<any[] | null>(null)
  const [novo, setNovo] = useState({ nome: '', url: '', token: '' })
  const [aberto, setAberto] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, toastNode] = useToast()
  useEffect(() => {
    api('/api/sistemas').then(setLista).catch(() => setLista([]))
  }, [])
  const salvar = async (dados: Record<string, unknown>, aviso?: string) => {
    setBusy(true)
    try {
      const r = await api('/api/sistemas', { method: 'POST', json: dados })
      setLista(r.sistemas)
      toast(r.ok ? (aviso ?? `Conectado: ${r.acoes} ações${r.servidor ? ` do ${r.servidor}` : ''}`) : `Não conectou: ${r.erro}`)
      return r.ok
    } catch (e) {
      toast(String((e as Error).message).slice(0, 160))
      return false
    } finally {
      setBusy(false)
    }
  }
  if (!lista) return <p className="muted">Carregando…</p>
  return (
    <div className="stack">
      <p className="muted">
        Conecte sistemas seus que falam MCP (como o WorkFlow): o Jarvis passa a criar, ler e mexer neles por voz, com as permissões do token.
        No WorkFlow, o endereço e o token ficam em Configurações → Conta → Tokens de acesso. O token fica só neste computador.
      </p>
      {lista.map((s) => (
        <section className="panel-a" key={s.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              <b>{s.nome}</b>
              <small className="muted" style={{ display: 'block' }}>
                {s.erro ? `Erro: ${s.erro}` : `${s.acoes.length - (s.desligadas?.length ?? 0)} de ${s.acoes.length} ações ligadas`} · {s.url}
              </small>
            </span>
            <span className="row">
              <Switch on={s.ativo} onChange={(v) => salvar({ id: s.id, ativo: v }, v ? 'Ligado' : 'Desligado')} label="Ativo" />
              <button className="btn" onClick={() => setAberto(aberto === s.id ? null : s.id)}>
                {aberto === s.id ? 'Fechar' : 'Ações'}
              </button>
              <button className="btn" disabled={busy} onClick={() => salvar({ id: s.id }, 'Conexão testada')}>
                <RefreshCw size={14} /> Testar
              </button>
              <button className="icon" onClick={async () => setLista(await api(`/api/sistemas/${s.id}`, { method: 'DELETE' }))} aria-label={`Remover ${s.nome}`}>
                <Trash2 size={15} />
              </button>
            </span>
          </div>
          {aberto === s.id && (
            <ul className="rows">
              {s.acoes.map((a: any) => {
                const ligada = !(s.desligadas ?? []).includes(a.nome)
                return (
                  <li key={a.nome}>
                    <span>
                      <b>
                        {a.titulo} {a.destrutiva && <em className="tag t-correcao">pede confirmação</em>}
                      </b>
                      <small>{a.descricao}</small>
                    </span>
                    <Switch
                      on={ligada}
                      onChange={(v) =>
                        salvar({ id: s.id, desligadas: v ? s.desligadas.filter((n: string) => n !== a.nome) : [...(s.desligadas ?? []), a.nome] }, v ? 'Ação ligada' : 'Ação desligada')
                      }
                      label={a.titulo}
                    />
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      ))}
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault()
          if (await salvar(novo)) setNovo({ nome: '', url: '', token: '' })
        }}
      >
        <label className="field-a">
          <span>Nome</span>
          <input value={novo.nome} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} placeholder="WorkFlow" />
        </label>
        <label className="field-a">
          <span>Endereço do MCP</span>
          <input value={novo.url} onChange={(e) => setNovo({ ...novo, url: e.target.value })} placeholder="https://workflow.agcunae.com/api/mcp" />
        </label>
        <label className="field-a span2">
          <span>Token de acesso</span>
          <input type="password" value={novo.token} onChange={(e) => setNovo({ ...novo, token: e.target.value })} placeholder="cw_…" autoComplete="off" />
        </label>
        <div className="row end span2">
          <button className="btn primary" disabled={busy || !novo.nome.trim() || !novo.url.trim()}>
            <Plug size={14} /> Conectar
          </button>
        </div>
      </form>
      {toastNode}
    </div>
  )
}

/* ---------- gestos ---------- */

function GestosPage() {
  const [d, setD] = useState<{ gestos: Record<string, string>; acoes: Record<string, string>; mapa: Record<string, string>; padrao: Record<string, string> } | null>(null)
  const [toast, toastNode] = useToast()
  useEffect(() => {
    api('/api/gestos').then(setD)
  }, [])
  if (!d) return <p className="muted">Carregando…</p>
  const salvar = async (mapa: Record<string, string>) => {
    setD(await api('/api/gestos', { method: 'PUT', json: mapa }))
    toast('Gestos salvos')
  }
  return (
    <div className="stack">
      <Panel title="Ponteiro (modelo da Meta)" desc="Com a câmera ligada, a mão é o mouse da tela inteira, como no Quest. O anel do cursor fecha conforme o polegar se aproxima do indicador.">
        <ul className="rows">
          {[
            ['Pinça e solta', 'Seleciona: clica onde a pinça começou (em qualquer app ou nos cartões do Jarvis)'],
            ['Pinça e arrasta', 'No conteúdo, rola a página (com inércia ao soltar); na barra de título, move a janela (segurar na borda manda para o outro monitor); num cartão, move o cartão'],
            ['Pinça parada e gira o punho', 'Muda o volume, como o "pinçar e girar" da pulseira da Meta'],
            ['Palma virada para você + pinça', 'Abre o menu rápido em volta da mão: aponte e solte para escolher; segure no meio para recentrar o ponteiro'],
            ['Duas mãos em pinça', 'Afastar ou juntar muda o tamanho do cartão ou da janela embaixo; soltar fixa'],
            ['Mão fechada', 'Polegar no lado do indicador: toque, toque duplo e deslizes (os atalhos abaixo)'],
          ].map(([g, a]) => (
            <li key={g}>
              <span>
                <b>{g}</b>
                <small>{a}</small>
              </span>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel
        title="Gestos de atalho"
        desc="Poses paradas por um instante e deslizes da mão. Escolha o que cada um faz; as ações do navegador só valem com o navegador na frente."
        actions={
          <button className="btn" onClick={() => salvar(d.padrao)}>
            Voltar ao padrão
          </button>
        }
      >
        <div className="form-grid">
          {Object.entries(d.gestos).map(([g, nome]) => (
            <label className="field-a" key={g}>
              <span>{nome}</span>
              <select value={d.mapa[g] ?? 'nada'} onChange={(e) => salvar({ ...d.mapa, [g]: e.target.value })}>
                {Object.entries(d.acoes).map(([id, rotulo]) => (
                  <option key={id} value={id}>
                    {rotulo}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </Panel>
      {toastNode}
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

const RACIOCINIO = [
  { id: 'rapido', nome: 'Rápido', desc: 'Responde na hora; só pensa a fundo quando você pedir ("pensa melhor").' },
  { id: 'equilibrado', nome: 'Equilibrado', desc: 'Pensa a fundo nos pedidos difíceis: análise, planos, contas, textos (padrão).' },
  { id: 'profundo', nome: 'Profundo', desc: 'Pensa a fundo em quase tudo que não for um comando simples; respostas mais lentas e cuidadosas.' },
]

function RaciocinioPanel() {
  const [voz, setVoz] = useState<Record<string, any> | null>(null)
  useEffect(() => {
    api('/api/ajustes/voz').then(setVoz)
  }, [])
  if (!voz) return null
  const atual = voz.raciocinio ?? 'equilibrado'
  return (
    <Panel
      title="Raciocínio da voz"
      desc="Quanto o Jarvis pensa antes de responder. Pedidos difíceis (análise, plano, contas, texto caprichado) ele passa para um modelo mais forte, que leva alguns segundos. Vale a partir da próxima conversa. Com faturamento ativo na chave da Gemini (Google AI Studio), ele usa a Gemini Pro e a pesquisa do Google; no plano grátis, a Pro fica sem cota."
    >
      <div className="seg" role="radiogroup" aria-label="Raciocínio da voz">
        {RACIOCINIO.map((r) => (
          <button
            key={r.id}
            role="radio"
            aria-checked={atual === r.id}
            className={atual === r.id ? 'on' : ''}
            title={r.desc}
            onClick={async () => setVoz(await api('/api/ajustes/voz', { method: 'PUT', json: { ...voz, raciocinio: r.id } }))}
          >
            {r.nome}
          </button>
        ))}
      </div>
      <p className="muted">{RACIOCINIO.find((r) => r.id === atual)?.desc}</p>
    </Panel>
  )
}

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
        <Kpi icon={Monitor} label="Câmera" value={s.camera ? 'Ligada' : 'Desligada'} sub={s.camera_erro ?? 'mãos e visão'} />
      </div>
      <RaciocinioPanel />
      <Panel title="Configuração" desc="Definida na configuração inicial (ícone → Configuração inicial).">
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
  { id: 'sistemas', nome: 'Seus sistemas (MCP)', desc: 'WorkFlow e outros apps seus, por voz', cat: 'Produtividade', icon: Plug },
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
  { id: 'imessage', nome: 'iMessage / SMS', desc: 'Ler e enviar pelo app Mensagens', cat: 'Comunicação', icon: MessageCircle },
  { id: 'notas', nome: 'Obsidian / Notion', desc: 'Buscar, ler e criar notas', cat: 'Produtividade', icon: NotebookPen },
  { id: 'alertas', nome: 'Alertas proativos', desc: 'Agenda, e-mails e mercado', cat: 'Produtividade', icon: BellRing },
  { id: 'saude', nome: 'Apple Saúde', desc: 'Exportação do app Saúde do iPhone', cat: 'Saúde', icon: HeartPulse },
  { id: 'whatsapp', nome: 'WhatsApp', desc: 'Sem API gratuita confiável', cat: 'Comunicação', icon: MessageCircle, soon: true },
]
const CATS = ['Todas', 'Produtividade', 'Comunicação', 'Informação', 'Finanças', 'Casa e dispositivos', 'Saúde']

function ConexoesPage() {
  const [cat, setCat] = useState('Todas')
  const [open, setOpen] = useState<string | null>(null)
  const [st, setSt] = useState<Record<string, boolean>>({})
  const load = useCallback(async () => {
    const [b, alexa, atalhos, cams, perm, notas, saude, alertas, sis] = await Promise.all([
      api('/api/ajustes/briefing'),
      api('/api/ajustes/alexa'),
      api<string[]>('/api/ajustes/atalhos'),
      api<any[]>('/api/ajustes/cameras'),
      api('/api/permissoes'),
      api('/api/notas/cofres'),
      api('/api/saude'),
      api('/api/ajustes/alertas'),
      api<any[]>('/api/sistemas').catch(() => []),
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
      imessage: !!perm.mensagens,
      notas: (notas.obsidian ?? []).length > 0,
      saude: !!saude?.serie,
      alertas: !!alertas.ativo,
      mercado: true,
      computador: true,
      musica: true,
      sistemas: sis.some((x: any) => x.ativo && x.acoes.length > 0),
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
            {conn.id === 'sistemas' && <SistemasForm />}
            {conn.id === 'imessage' && <IMessageForm />}
            {conn.id === 'notas' && <NotasForm />}
            {conn.id === 'alertas' && <AlertasForm />}
            {conn.id === 'saude' && <SaudePage />}
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


/* ---------- operações: protocolos e tarefas ---------- */

type Passo = { tipo: string; valor: string }
type Protocolo = { id: string; nome: string; frases: string[]; fala: string; passos: Passo[]; quando?: { hora: string; dias: number[] } }
const DIAS_CURTOS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']

const AGENTES = [
  { id: 'chatgpt', nome: 'ChatGPT', desc: 'Pergunta e resposta, pela sua assinatura (Codex)' },
  { id: 'claude', nome: 'Claude Code', desc: 'Cria arquivos e usa seus MCPs (ElevenLabs, Drive…)' },
  { id: 'codex', nome: 'Codex', desc: 'Cria arquivos e código com o ChatGPT' },
]

function OperacoesPage({ tasks }: { tasks: { id: string; agente: string; titulo: string; estado: string; resumo?: string; pasta?: string; inicio: string }[] }) {
  const [lista, setLista] = useState<Protocolo[] | null>(null)
  const [tipos, setTipos] = useState<Record<string, string>>({})
  const [info, setInfo] = useState<{ disponiveis: Record<string, boolean>; pasta: string } | null>(null)
  const [nova, setNova] = useState({ agente: 'chatgpt', titulo: '', tarefa: '' })
  const [toast, toastNode] = useToast()
  useEffect(() => {
    api('/api/ajustes/protocolos').then(setLista)
    api('/api/protocolos/tipos').then(setTipos)
    api('/api/tarefas').then(setInfo)
  }, [])
  if (!lista) return <p className="muted">Carregando…</p>
  const edit = (i: number, p: Partial<Protocolo>) => setLista(lista.map((x, k) => (k === i ? { ...x, ...p } : x)))
  const save = async () => {
    setLista(await api('/api/ajustes/protocolos', { method: 'PUT', json: lista }))
    toast('Rotinas salvas')
  }
  const enviar = async (e: FormEvent) => {
    e.preventDefault()
    const r = await api<{ erro?: string }>('/api/tarefas', { method: 'POST', json: nova })
    toast(r.erro ?? 'Tarefa enviada; o Jarvis avisa quando terminar')
    if (!r.erro) setNova({ ...nova, titulo: '', tarefa: '' })
  }
  return (
    <div className="stack">
      <Panel title="Rotinas" desc="Automações com nome. Diga “Jarvis, modo foco”, ou dê um horário para rodarem sozinhas. Também dá para criar por voz: “Jarvis, toda segunda às 9 abre o e-mail e a agenda”.">
        <div className="stack">
          {lista.map((p, i) => (
            <section className="panel-a proto" key={p.id}>
              <div className="form-grid">
                <label className="field-a">
                  <span>Nome</span>
                  <input value={p.nome} onChange={(e) => edit(i, { nome: e.target.value })} />
                </label>
                <label className="field-a">
                  <span>Outras frases que ativam (separe por vírgula)</span>
                  <input value={p.frases.join(', ')} onChange={(e) => edit(i, { frases: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
                </label>
                <label className="field-a">
                  <span>O que ele diz ao terminar (opcional)</span>
                  <input value={p.fala} onChange={(e) => edit(i, { fala: e.target.value })} />
                </label>
                <div className="field-a">
                  <span>Rodar sozinha no horário (opcional)</span>
                  <div className="row">
                    <input
                      type="time"
                      value={p.quando?.hora ?? ''}
                      onChange={(e) => edit(i, { quando: e.target.value ? { hora: e.target.value, dias: p.quando?.dias ?? [0, 1, 2, 3, 4, 5, 6] } : undefined })}
                      aria-label="Horário"
                    />
                    <div className="seg" role="group" aria-label="Dias">
                      {DIAS_CURTOS.map((d, n) => {
                        const on = !!p.quando?.dias.includes(n)
                        return (
                          <button
                            key={d}
                            type="button"
                            className={on ? 'on' : ''}
                            disabled={!p.quando}
                            aria-pressed={on}
                            onClick={() => p.quando && edit(i, { quando: { ...p.quando, dias: on ? p.quando.dias.filter((x) => x !== n) : [...p.quando.dias, n].sort() } })}
                          >
                            {d}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </div>
              <ol className="steps">
                {p.passos.map((st, k) => (
                  <li key={k}>
                    <select value={st.tipo} onChange={(e) => edit(i, { passos: p.passos.map((x, n) => (n === k ? { ...x, tipo: e.target.value } : x)) })}>
                      {Object.entries(tipos).map(([id, nome]) => (
                        <option key={id} value={id}>
                          {nome}
                        </option>
                      ))}
                    </select>
                    <input value={st.valor} disabled={st.tipo === 'limpar'} onChange={(e) => edit(i, { passos: p.passos.map((x, n) => (n === k ? { ...x, valor: e.target.value } : x)) })} />
                    <button className="icon" onClick={() => edit(i, { passos: p.passos.filter((_, n) => n !== k) })} aria-label="Remover passo">
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ol>
              <div className="row">
                <button className="btn" onClick={() => edit(i, { passos: [...p.passos, { tipo: 'app', valor: '' }] })}>
                  <Plus size={14} /> Passo
                </button>
                <button className="btn" onClick={() => api('/api/protocolos/executar', { method: 'POST', json: { nome: p.nome } }).then((r) => toast(r.erro ?? `Executado: ${r.feitos.length} passos`))}>
                  <Play size={14} /> Testar
                </button>
                <button className="btn" onClick={() => setLista(lista.filter((_, k) => k !== i))}>
                  <Trash2 size={14} /> Remover
                </button>
              </div>
            </section>
          ))}
          <div className="row end">
            <button className="btn" onClick={() => setLista([...lista, { id: Math.random().toString(36).slice(2, 8), nome: 'Novo protocolo', frases: [], fala: '', passos: [] }])}>
              <Plus size={14} /> Nova rotina
            </button>
            <button className="btn primary" onClick={save}>
              Salvar rotinas
            </button>
          </div>
        </div>
      </Panel>

      <ControleMac />
      <TrabalhoJunto />

      <Panel title="Tarefas para outras IAs" desc={`Por voz: “Jarvis, pede pro Claude criar…”, “pergunta pro ChatGPT…”. Rodam em segundo plano com as suas assinaturas; os arquivos ficam em ${info?.pasta ?? '~/Jarvis/Tarefas'}.`}>
        <form className="stack" onSubmit={enviar}>
          <div className="seg">
            {AGENTES.map((a) => (
              <button type="button" key={a.id} className={nova.agente === a.id ? 'on' : ''} disabled={info ? !info.disponiveis[a.id] : false} onClick={() => setNova({ ...nova, agente: a.id })} title={a.desc}>
                {a.nome}
              </button>
            ))}
          </div>
          <small className="muted">{AGENTES.find((a) => a.id === nova.agente)?.desc}</small>
          <label className="field-a">
            <span>Título</span>
            <input value={nova.titulo} onChange={(e) => setNova({ ...nova, titulo: e.target.value })} placeholder="Ex.: Locução do vídeo da Nova Foods" />
          </label>
          <label className="field-a">
            <span>Pedido</span>
            <textarea rows={4} value={nova.tarefa} onChange={(e) => setNova({ ...nova, tarefa: e.target.value })} placeholder="Descreva o que ele deve fazer, com todos os detalhes." />
          </label>
          <div className="row end">
            <button className="btn primary" disabled={!nova.tarefa.trim()}>
              <Send size={14} /> Enviar tarefa
            </button>
          </div>
        </form>
        <ul className="rows">
          {tasks.map((t) => (
            <li key={t.id}>
              <span>
                <b>{t.titulo}</b>
                <small>
                  {AGENTES.find((a) => a.id === t.agente)?.nome ?? t.agente} · {t.inicio} · {t.estado}
                  {t.resumo ? ` · ${t.resumo}` : ''}
                </small>
              </span>
              {t.estado === 'rodando' && (
                <button className="btn" onClick={() => api(`/api/tarefas/${t.id}/cancelar`, { method: 'POST' })}>
                  Cancelar
                </button>
              )}
            </li>
          ))}
          {tasks.length === 0 && <li className="muted">Nenhuma tarefa nesta sessão.</li>}
        </ul>
      </Panel>
      {toastNode}
    </div>
  )
}

function TrabalhoJunto() {
  const [at, setAt] = useState<Record<string, any> | null>(null)
  const [amb, setAmb] = useState<Record<string, any> | null>(null)
  const [dsp, setDsp] = useState<Record<string, any> | null>(null)
  const [toast, toastNode] = useToast()
  useEffect(() => {
    api('/api/despertar').then(setDsp)
    api('/api/ajustes/atividade').then(setAt)
    api('/api/ajustes/ambiente').then(setAmb)
  }, [])
  if (!at || !amb) return null
  const saveAt = async (v: Record<string, any>) => setAt(await api('/api/ajustes/atividade', { method: 'PUT', json: v }))
  const fases: [string, string][] = [['espera', 'Em espera'], ['ouvindo', 'Ouvindo'], ['pensando', 'Pensando'], ['falando', 'Falando']]
  return (
    <Panel title="Trabalhando junto" desc="Memória do que você fez no Mac (para “onde eu parei?”), sugestões discretas no HUD e luz ambiente que acompanha o Jarvis.">
      {dsp && (
        <div className="stack">
          <div className="row">
            <Switch on={!!dsp.palavra} onChange={async (v) => setDsp({ ...dsp, ...(await api('/api/ajustes/despertar', { method: 'PUT', json: { ...dsp, palavra: v } })) })} label="Acordar dizendo “Jarvis”" />
            <Switch on={!!dsp.palmas} onChange={async (v) => setDsp({ ...dsp, ...(await api('/api/ajustes/despertar', { method: 'PUT', json: { ...dsp, palmas: v } })) })} label="Acordar com duas palmas" />
            <Switch on={!!dsp.bom_dia} onChange={async (v) => setDsp({ ...dsp, ...(await api('/api/ajustes/despertar', { method: 'PUT', json: { ...dsp, bom_dia: v } })) })} label="Primeira chamada da manhã abre com o bom dia" />
          </div>
          <small className="muted">
            {dsp.ativo ? 'Ouvido em segundo plano ligado (reconhecimento no próprio Mac).' : dsp.erro ? `Ouvido desligado: ${dsp.erro}.` : 'O ouvido em segundo plano funciona no app Jarvis instalado.'}
          </small>
        </div>
      )}
      <div className="row">
        <Switch on={!!at.registrar} onChange={(v) => saveAt({ ...at, registrar: v })} label="Lembrar apps e janelas (7 dias, só neste Mac)" />
        <Switch on={!!at.sugestoes} onChange={(v) => saveAt({ ...at, sugestoes: v })} label="Sugestões no canto do HUD" />
      </div>
      <div className="form-grid">
        <div className="span2">
          <Switch on={!!amb.ativo} onChange={(v) => setAmb({ ...amb, ativo: v })} label="Luz ambiente pela Alexa (Voice Monkey)" />
        </div>
        {fases.map(([id, nome]) => (
          <label className="field-a" key={id}>
            <span>{nome} → dispositivo da Alexa</span>
            <input value={amb[id] ?? ''} placeholder="Ex.: luz azul" onChange={(e) => setAmb({ ...amb, [id]: e.target.value })} />
          </label>
        ))}
      </div>
      <div className="row end">
        <button
          className="btn primary"
          onClick={async () => {
            setAmb(await api('/api/ajustes/ambiente', { method: 'PUT', json: amb }))
            toast('Luz ambiente salva')
          }}
        >
          Salvar luz ambiente
        </button>
      </div>
      <small className="muted">Os nomes são os dispositivos cadastrados em Conexões → Alexa (cada um com a rotina “ligar” no Voice Monkey).</small>
      {toastNode}
    </Panel>
  )
}

function ControleMac() {
  const [perm, setPerm] = useState<boolean | null>(null)
  const [msg, setMsg] = useState('')
  const load = useCallback(() => api('/api/permissoes').then((p) => setPerm(!!p.acessibilidade)), [])
  useEffect(() => {
    load()
  }, [load])
  return (
    <Panel
      title="Controle do Mac"
      desc="Para o Jarvis digitar, usar atalhos e para a sua mão virar o mouse (modo mouse), o macOS precisa liberar a Acessibilidade para o Python do serviço."
      actions={
        <div className="row">
          {!perm && (
            <button
              className="btn primary"
              onClick={async () => {
                await api('/api/permissoes/acessibilidade', { method: 'POST' })
                setMsg('Na tela que abriu, ligue o “Python” e depois clique em Reiniciar serviço.')
              }}
            >
              Liberar acesso
            </button>
          )}
          <button
            className="btn"
            onClick={async () => {
              await api('/api/reiniciar', { method: 'POST' })
              setMsg('Reiniciando…')
              setTimeout(load, 6000)
            }}
          >
            Reiniciar serviço
          </button>
        </div>
      }
    >
      <p className={perm ? 'ok-line' : 'muted'}>
        {perm === null ? 'Conferindo…' : perm ? 'Liberado: ele pode digitar, usar atalhos e mover o mouse.' : 'Ainda não liberado.'}
      </p>
      <p className="muted small">Por voz: “Jarvis, abre o Notas e escreve…”, “abre uma aba com…”, “aperta cmd+s”, “liga o modo mouse”.</p>
      {msg && <p className="muted">{msg}</p>}
    </Panel>
  )
}

/* ---------- monitores ---------- */



/* ---------- iMessage, notas, alertas ---------- */

function IMessageForm() {
  const [p, setP] = useState<{ mensagens: boolean; python: string } | null>(null)
  const load = () => api('/api/permissoes').then(setP)
  useEffect(() => {
    load()
  }, [])
  if (!p) return <p className="muted">Verificando…</p>
  return (
    <div className="stack">
      <Panel
        title={p.mensagens ? 'Mensagens conectadas' : 'Falta uma permissão do macOS'}
        desc={
          p.mensagens
            ? 'Diga “tenho mensagens novas?” ou “manda uma mensagem para a Clara dizendo que chego às 19h”. Antes de enviar ele sempre lê e pede o seu sim.'
            : 'O macOS protege as mensagens. Abra Ajustes do Sistema → Privacidade e Segurança → Acesso Total ao Disco, clique em +, aperte Cmd+Shift+G, cole o caminho abaixo e ative. Depois reinicie o Jarvis (botão abaixo).'
        }
      >
        {!p.mensagens && <code className="path">{p.python}</code>}
        <div className="row">
          {!p.mensagens && (
            <a className="btn" href="x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles">
              Abrir Acesso Total ao Disco
            </a>
          )}
          <button className="btn" onClick={() => api('/api/reiniciar', { method: 'POST' }).catch(() => {}).then(() => setTimeout(load, 6000))}>
            Reiniciar o Jarvis
          </button>
          <button className="btn primary" onClick={load}>
            Verificar de novo
          </button>
        </div>
      </Panel>
    </div>
  )
}

function NotasForm() {
  const [cfg, setCfg] = useState<{ obsidian: string; notion_token: string } | null>(null)
  const [cofres, setCofres] = useState<string[]>([])
  const [toast, toastNode] = useToast()
  useEffect(() => {
    api('/api/ajustes/notas').then(setCfg)
    api('/api/notas/cofres').then((r) => setCofres(r.obsidian ?? []))
  }, [])
  if (!cfg) return <p className="muted">Carregando…</p>
  const save = async () => {
    setCfg(await api('/api/ajustes/notas', { method: 'PUT', json: cfg }))
    toast('Notas salvas')
  }
  return (
    <div className="stack">
      <Panel title="Obsidian" desc="Ele busca e lê as notas do seu cofre e cria notas novas na pasta Jarvis. Em branco, usa o primeiro cofre encontrado.">
        <label className="field-a">
          <span>Pasta do cofre</span>
          <input value={cfg.obsidian} onChange={(e) => setCfg({ ...cfg, obsidian: e.target.value })} placeholder={cofres[0] ?? '/Users/…/Meu cofre'} />
          {cofres.length > 0 && <small>Encontrado: {cofres.join(' · ')}</small>}
        </label>
      </Panel>
      <Panel title="Notion" desc="Crie uma integração interna grátis em notion.so/my-integrations, copie o token e compartilhe com ela as páginas que o Jarvis pode ler (menu ••• → Conexões).">
        <label className="field-a">
          <span>Token da integração</span>
          <input type="password" value={cfg.notion_token} onChange={(e) => setCfg({ ...cfg, notion_token: e.target.value })} placeholder="ntn_…" autoComplete="off" />
        </label>
      </Panel>
      <div className="row end">
        <button className="btn primary" onClick={save}>
          Salvar notas
        </button>
      </div>
      {toastNode}
    </div>
  )
}

function AlertasForm() {
  const [cfg, setCfg] = useState<Record<string, any> | null>(null)
  const [toast, toastNode] = useToast()
  useEffect(() => {
    api('/api/ajustes/alertas').then(setCfg)
  }, [])
  if (!cfg) return <p className="muted">Carregando…</p>
  const set = (k: string, v: unknown) => setCfg({ ...cfg, [k]: v })
  const save = async () => {
    setCfg(await api('/api/ajustes/alertas', { method: 'PUT', json: cfg }))
    toast('Alertas salvos')
  }
  return (
    <div className="stack">
      <Panel title="O que avisar" desc="Ele confere a cada minuto. O aviso aparece no HUD, vira notificação do Mac e, com a voz ligada, ele fala.">
        <div className="form-grid">
          <div className="span2">
            <Switch on={!!cfg.ativo} onChange={(v) => set('ativo', v)} label="Alertas ligados" />
          </div>
          <label className="field-a">
            <span>Avisar compromisso com antecedência de (min)</span>
            <input inputMode="numeric" value={cfg.agenda_min} onChange={(e) => set('agenda_min', Number(e.target.value.replace(/\D/g, '')) || 10)} />
          </label>
          <label className="field-a">
            <span>Mercado: avisar variação a partir de (%)</span>
            <input inputMode="decimal" value={cfg.mercado_pct} onChange={(e) => set('mercado_pct', Number(e.target.value.replace(',', '.')) || 0)} />
            <small>0 desliga os avisos de mercado.</small>
          </label>
          <label className="field-a">
            <span>Silêncio a partir de</span>
            <input value={cfg.silencio?.[0] ?? '22:00'} onChange={(e) => set('silencio', [e.target.value, cfg.silencio?.[1] ?? '07:00'])} />
          </label>
          <label className="field-a">
            <span>Até</span>
            <input value={cfg.silencio?.[1] ?? '07:00'} onChange={(e) => set('silencio', [cfg.silencio?.[0] ?? '22:00', e.target.value])} />
          </label>
          <div className="span2 row">
            <Switch on={!!cfg.emails} onChange={(v) => set('emails', v)} label="E-mail urgente novo" />
            <Switch on={!!cfg.falar} onChange={(v) => set('falar', v)} label="Falar o aviso" />
            <Switch on={!!cfg.notificacao_mac} onChange={(v) => set('notificacao_mac', v)} label="Notificação do Mac" />
          </div>
        </div>
      </Panel>
      <div className="row end">
        <button className="btn" onClick={() => api('/api/alertas/teste', { method: 'POST' }).then(() => toast('Aviso de teste enviado ao HUD'))}>
          Enviar aviso de teste
        </button>
        <button className="btn primary" onClick={save}>
          Salvar alertas
        </button>
      </div>
      {toastNode}
    </div>
  )
}

/* ---------- saúde ---------- */

function SaudePage() {
  const [d, setD] = useState<Record<string, any> | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const load = () => api('/api/saude').then(setD)
  useEffect(() => {
    load()
  }, [])
  const upload = async (file: File) => {
    setBusy(true)
    setMsg(`Lendo ${(file.size / 1e6).toFixed(0)} MB… pode levar um minuto.`)
    const fd = new FormData()
    fd.append('arquivo', file)
    try {
      const r = await fetch('/api/saude/importar', { method: 'POST', body: fd })
      if (!r.ok) throw new Error((await r.json()).detail)
      setMsg('Importado.')
      load()
    } catch (e) {
      setMsg(`Não deu certo: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
    }
  }
  const r = d?.resumo ?? {}
  const serie: any[] = (d?.serie ?? []).slice(-30)
  return (
    <div className="stack wide-stack">
      {d?.serie && (
        <div className="kpis">
          <Kpi icon={HeartPulse} label="Passos" value={r.passos ? Math.round(r.passos).toLocaleString('pt-BR') : '—'} sub={`média 7 dias: ${r.media7_passos ? Math.round(r.media7_passos).toLocaleString('pt-BR') : '—'}`} accent />
          <Kpi icon={HeartPulse} label="Sono" value={r.sono_h ? `${String(r.sono_h).replace('.', ',')} h` : '—'} sub={`média 7 dias: ${r.media7_sono ? String(r.media7_sono).replace('.', ',') + ' h' : '—'}`} />
          <Kpi icon={HeartPulse} label="FC em repouso" value={r.fc_repouso ? `${Math.round(r.fc_repouso)} bpm` : '—'} sub="janela noturna" />
          <Kpi icon={HeartPulse} label="VFC" value={r.vfc ? `${String(r.vfc).replace('.', ',')} ms` : '—'} sub="SDNN" />
        </div>
      )}
      {d?.serie && (
        <div className="fin-grid">
          <Bars title="Passos por dia" serie={serie} k="passos" />
          <Bars title="Sono por noite (h)" serie={serie} k="sono_h" />
          <Bars title="FC em repouso" serie={serie} k="fc_repouso" />
        </div>
      )}
      {(d?.treinos?.length ?? 0) > 0 && (
        <Panel title="Treinos recentes">
          <ul className="rows">
            {(d?.treinos ?? []).slice(0, 8).map((t: any, i: number) => (
              <li key={i}>
                <time>{t.data.slice(5).split('-').reverse().join('/')}</time>
                <span>
                  <b>{t.tipo.replace(/([a-z])([A-Z])/g, '$1 $2')}</b>
                  <small>
                    {t.min} min{t.kcal ? ` · ${t.kcal} kcal` : ''}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <Panel
        title={d?.serie ? `Dados de ${d.atualizado}` : 'Importar do app Saúde'}
        desc="No iPhone: app Saúde → sua foto no canto → Exportar Todos os Dados de Saúde. Mande o arquivo para o Mac (AirDrop) e escolha abaixo. Só o resumo dos últimos 60 dias fica guardado, neste Mac. Repita quando quiser atualizar."
      >
        <label className="btn primary upload">
          {busy ? 'Importando…' : 'Escolher exportação (.zip)'}
          <input type="file" accept=".zip,.xml" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
        {msg && <p className="muted">{msg}</p>}
        <p className="muted small">Os números vêm do seu app Saúde; o Jarvis organiza, não estima. Não substitui avaliação médica.</p>
      </Panel>
    </div>
  )
}

function Bars({ title, serie, k }: { title: string; serie: any[]; k: string }) {
  const vals = serie.map((r) => r[k] as number | null)
  const max = Math.max(...vals.map((v) => v ?? 0), 1)
  return (
    <section className="panel-a">
      <header>
        <h2>{title}</h2>
      </header>
      <div className="bars30" aria-label={title}>
        {vals.map((v, i) => (
          <span key={i} title={`${serie[i].data}: ${v ?? '—'}`} style={{ height: v ? `${Math.max(4, (v / max) * 100)}%` : '2px' }} className={v ? '' : 'none'} />
        ))}
      </div>
      <small className="muted">Últimos 30 dias</small>
    </section>
  )
}
