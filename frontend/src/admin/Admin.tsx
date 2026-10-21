import {
  Bot,
  BrainCircuit,
  CalendarDays,
  Cpu,
  Database,
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
import type { ScreenConfig, Telemetry } from '../lib/socket'
import { useJarvis } from '../hud/useJarvis'
import './admin.css'

type Page = 'chat' | 'briefing' | 'fontes' | 'memorias' | 'conversas' | 'telas' | 'integracoes' | 'sistema'

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
      { id: 'fontes', label: 'Fontes de dados', desc: 'Contas, agendas e radar', icon: Database },
      { id: 'memorias', label: 'Memórias', desc: 'O que ele sabe sobre você', icon: BrainCircuit },
      { id: 'integracoes', label: 'Integrações', desc: 'Atalhos, casa e câmeras', icon: Plug },
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
  const p = location.pathname.split('/')[2] as Page
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
          {page === 'fontes' && <FontesPage />}
          {page === 'memorias' && <MemoriasPage />}
          {page === 'conversas' && <ConversasPage />}
          {page === 'telas' && <TelasPage screensLive={j.screens} />}
          {page === 'integracoes' && <IntegracoesPage />}
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

function FontesPage() {
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

function IntegracoesPage() {
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
      <Panel title="Computador" desc="Por voz ele abre apps e sites, controla a música (Spotify ou Música) e ajusta o volume. Não executa comandos livres.">
        <div className="chips">
          {['Abrir app', 'Abrir site', 'Tocar / pausar', 'Próxima faixa', 'Volume'].map((c) => (
            <em className="tag" key={c}>
              {c}
            </em>
          ))}
        </div>
      </Panel>

      <Panel
        title="Atalhos: celular, casa e Alexa"
        desc="O Jarvis roda Atalhos do macOS que você liberar aqui. Com eles você alcança o iPhone (mensagens, lembretes, localização), a Casa (HomeKit) e a Alexa (pelo app Alexa ou por um serviço como o Voice Monkey). Crie o atalho no app Atalhos com um nome claro, como “Apagar luzes da sala”."
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
