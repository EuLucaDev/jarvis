// Site do Jarvis (jarvis.agcunae.com/site), servido pela portaria na VPS.
//   /site                          entrar; depois: baixar o launcher, Telegram, senha (e, para o admin, as contas)
//   /site/primeiro-acesso/<token>  a pessoa convidada cria a senha
// Só entra quem tem conta; quem cria as contas é o administrador.

import { Apple, Check, Copy, Download, KeyRound, Monitor, Pause, Play, Send, Trash2, UserPlus, X } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import './site.css'

type Disp = { id: string; sistema: string; nome: string; jarvis?: string; launcher?: string; visto?: string }
type Conta = {
  id: string
  nome: string
  email: string
  admin: boolean
  ativa: boolean
  criado?: string
  ultimo_uso?: string
  senha_definida?: boolean
  dispositivos: Disp[]
  telegram_ligado?: boolean
  nuvem_no_ar?: boolean
}
type Eu = Conta & { robo?: string; versoes: Record<string, { versao: string; data: string } | null>; launcher: Record<string, boolean> }

async function chamar<T = any>(url: string, metodo = 'GET', corpo?: unknown): Promise<T> {
  const r = await fetch(url, { method: metodo, credentials: 'same-origin', headers: corpo ? { 'content-type': 'application/json' } : {}, body: corpo ? JSON.stringify(corpo) : undefined })
  const dados = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(dados.detail || `Erro ${r.status}`)
  return dados as T
}

const SISTEMAS = [
  { id: 'mac', nome: 'Mac', icone: Apple, dica: 'Apple Silicon (M1 ou mais novo)' },
  { id: 'windows', nome: 'Windows', icone: Monitor, dica: 'Windows 10 ou 11' },
  { id: 'linux', nome: 'Linux', icone: Monitor, dica: 'AppImage (X11)' },
]
const nomeSistema = (s: string) => SISTEMAS.find((x) => x.id === s)?.nome ?? s

export function Site() {
  const caminho = location.pathname
  const link = caminho.match(/^\/site\/primeiro-acesso\/([^/]+)/)
  const [eu, setEu] = useState<Eu | null | undefined>(undefined)
  const carregar = () =>
    chamar<Eu>('/api/site/eu')
      .then(setEu)
      .catch(() => setEu(null))
  useEffect(() => {
    document.title = 'Jarvis'
    if (!link) carregar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (link) return <PrimeiroAcesso token={link[1]} />
  if (eu === undefined) return <main className="site" />
  if (!eu) return <Entrar aoEntrar={carregar} />
  return <Painel eu={eu} recarregar={carregar} />
}

function Moldura({ children, largo }: { children: React.ReactNode; largo?: boolean }) {
  return (
    <main className="site">
      <div className="site-esfera" aria-hidden="true" />
      <div className={`site-conteudo ${largo ? 'largo' : ''}`}>
        <header className="site-marca">
          <span className="site-ponto" aria-hidden="true" />
          J.A.R.V.I.S.
        </header>
        {children}
      </div>
    </main>
  )
}

function Entrar({ aoEntrar }: { aoEntrar: () => void }) {
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState('')
  const [indo, setIndo] = useState(false)
  const enviar = async (e: FormEvent) => {
    e.preventDefault()
    setIndo(true)
    setErro('')
    try {
      await chamar('/api/site/entrar', 'POST', { email, senha })
      aoEntrar()
    } catch (x) {
      setErro((x as Error).message)
    } finally {
      setIndo(false)
    }
  }
  return (
    <Moldura>
      <form className="site-cartao site-form" onSubmit={enviar}>
        <h1>Entrar</h1>
        <p className="apagado">O Jarvis é particular: só entra quem tem conta. Quem cria as contas é o administrador.</p>
        <label>
          E-mail
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Senha
          <input type="password" autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} required />
        </label>
        {erro && <p className="erro" role="alert">{erro}</p>}
        <button className="primario" disabled={indo}>
          {indo ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </Moldura>
  )
}

function PrimeiroAcesso({ token }: { token: string }) {
  const [quem, setQuem] = useState<{ nome: string; email: string } | null>(null)
  const [erro, setErro] = useState('')
  const [senha, setSenha] = useState('')
  const [senha2, setSenha2] = useState('')
  useEffect(() => {
    chamar(`/api/site/primeiro-acesso/${token}`)
      .then(setQuem)
      .catch((e) => setErro(e.message))
  }, [token])
  const enviar = async (e: FormEvent) => {
    e.preventDefault()
    if (senha !== senha2) return setErro('As duas senhas não são iguais.')
    try {
      await chamar(`/api/site/primeiro-acesso/${token}`, 'POST', { senha })
      location.href = '/site'
    } catch (x) {
      setErro((x as Error).message)
    }
  }
  return (
    <Moldura>
      <form className="site-cartao site-form" onSubmit={enviar}>
        <h1>{quem ? `Olá, ${quem.nome.split(' ')[0]}` : 'Primeiro acesso'}</h1>
        {quem && <p className="apagado">Crie a senha da sua conta ({quem.email}). Ela vale no site e no Jarvis Launcher.</p>}
        {quem && (
          <>
            <label>
              Senha (pelo menos 8 caracteres)
              <input type="password" autoComplete="new-password" minLength={8} value={senha} onChange={(e) => setSenha(e.target.value)} required />
            </label>
            <label>
              Repita a senha
              <input type="password" autoComplete="new-password" minLength={8} value={senha2} onChange={(e) => setSenha2(e.target.value)} required />
            </label>
          </>
        )}
        {erro && <p className="erro" role="alert">{erro}</p>}
        {quem && <button className="primario">Criar senha e entrar</button>}
      </form>
    </Moldura>
  )
}

function Painel({ eu, recarregar }: { eu: Eu; recarregar: () => void }) {
  const [aviso, setAviso] = useState('')
  const avisar = (m: string) => {
    setAviso(m)
    setTimeout(() => setAviso((a) => (a === m ? '' : a)), 4000)
  }
  const sair = async () => {
    await chamar('/api/site/sair', 'POST')
    location.reload()
  }
  return (
    <Moldura largo>
      <div className="site-topo">
        <div>
          <small className="rotulo">Sua conta</small>
          <h1>Olá, {eu.nome.split(' ')[0]}</h1>
        </div>
        <button className="fantasma" onClick={sair}>
          Sair
        </button>
      </div>

      <section className="site-cartao">
        <h2>
          <Download size={18} /> Jarvis Launcher
        </h2>
        <p className="apagado">Instale o launcher, entre com esta conta e ele instala o Jarvis. As atualizações aparecem lá, com um clique.</p>
        <div className="site-baixar">
          {SISTEMAS.map((s) => (
            <a key={s.id} className={`site-sistema ${eu.launcher[s.id] ? '' : 'off'}`} href={eu.launcher[s.id] ? `/api/site/baixar/${s.id}` : undefined}>
              <s.icone size={20} />
              <b>{s.nome}</b>
              <small>{eu.launcher[s.id] ? s.dica : 'em breve'}</small>
            </a>
          ))}
        </div>
        <p className="apagado pequeno">
          No Mac, na primeira vez: Ajustes do Sistema → Privacidade e Segurança → “Abrir Mesmo Assim”. No Windows: “Mais informações” → “Executar assim mesmo”.
        </p>
      </section>

      <Telegram eu={eu} />
      <Senha avisar={avisar} />
      {eu.admin && <Admin eu={eu} avisar={avisar} recarregar={recarregar} />}
      {aviso && (
        <div className="site-aviso" role="status">
          <Check size={14} /> {aviso}
        </div>
      )}
    </Moldura>
  )
}

function Telegram({ eu }: { eu: Eu }) {
  const [link, setLink] = useState<string | null>(null)
  const abrir = async () => {
    const r = await chamar<{ link: string | null }>('/api/site/telegram', 'POST')
    if (r.link) {
      setLink(r.link)
      window.open(r.link, '_blank')
    }
  }
  return (
    <section className="site-cartao">
      <h2>
        <Send size={18} /> Telegram
      </h2>
      {!eu.robo ? (
        <p className="apagado">O robô ainda não foi configurado pelo administrador.</p>
      ) : eu.telegram_ligado ? (
        <p className="apagado">Ligado: fale com @{eu.robo} quando quiser. É o seu Jarvis, com o seu financeiro.</p>
      ) : (
        <>
          <p className="apagado">Abra @{eu.robo} com o seu código: a conversa fica ligada à sua conta (vale 7 dias).</p>
          <button className="primario" onClick={abrir}>
            Abrir no Telegram
          </button>
          {link && <p className="pequeno apagado">Se não abriu: {link}</p>}
        </>
      )}
    </section>
  )
}

function Senha({ avisar }: { avisar: (m: string) => void }) {
  const [aberto, setAberto] = useState(false)
  const [atual, setAtual] = useState('')
  const [nova, setNova] = useState('')
  const [erro, setErro] = useState('')
  const enviar = async (e: FormEvent) => {
    e.preventDefault()
    setErro('')
    try {
      await chamar('/api/site/senha', 'POST', { atual, nova })
      setAtual('')
      setNova('')
      setAberto(false)
      avisar('Senha trocada')
    } catch (x) {
      setErro((x as Error).message)
    }
  }
  return (
    <section className="site-cartao">
      <h2>
        <KeyRound size={18} /> Senha
      </h2>
      {!aberto ? (
        <button className="fantasma" onClick={() => setAberto(true)}>
          Trocar a senha
        </button>
      ) : (
        <form className="site-linha" onSubmit={enviar}>
          <input type="password" placeholder="Senha atual" autoComplete="current-password" value={atual} onChange={(e) => setAtual(e.target.value)} required />
          <input type="password" placeholder="Nova senha (8+)" autoComplete="new-password" minLength={8} value={nova} onChange={(e) => setNova(e.target.value)} required />
          <button className="primario">Trocar</button>
          {erro && <p className="erro">{erro}</p>}
        </form>
      )}
    </section>
  )
}

function Admin({ eu, avisar, recarregar }: { eu: Eu; avisar: (m: string) => void; recarregar: () => void }) {
  const [contas, setContas] = useState<Conta[]>([])
  const [nome, setNome] = useState('')
  const [email, setEmail] = useState('')
  const [link, setLink] = useState<{ para: string; link: string } | null>(null)
  const [robo, setRobo] = useState('')
  const [erro, setErro] = useState('')
  const [versoes, setVersoes] = useState<Record<string, Record<string, { versao: string; data: string; notas?: string }[]>>>({})
  const carregar = () => {
    chamar<Conta[]>('/api/site/admin/contas').then(setContas)
    chamar('/api/site/admin/versoes').then(setVersoes)
  }
  useEffect(carregar, [])
  const tentar = async (fn: () => Promise<unknown>, ok: string) => {
    setErro('')
    try {
      await fn()
      avisar(ok)
      carregar()
    } catch (x) {
      setErro((x as Error).message)
    }
  }
  const criar = (e: FormEvent) => {
    e.preventDefault()
    tentar(async () => {
      const r = await chamar<{ link: string }>('/api/site/admin/contas', 'POST', { nome, email })
      setLink({ para: nome, link: r.link })
      setNome('')
      setEmail('')
    }, 'Conta criada')
  }
  const copiar = (t: string) => navigator.clipboard.writeText(t).then(() => avisar('Copiado'))
  return (
    <>
      <section className="site-cartao">
        <h2>
          <UserPlus size={18} /> Contas
        </h2>
        <p className="apagado">Cada conta tem o próprio Jarvis na nuvem (financeiro, memória e Telegram). Você vê só quem usa e onde, nunca os dados de ninguém.</p>
        <div className="site-tabela" role="table">
          {contas.map((c) => (
            <div key={c.id} className={`site-conta ${c.ativa ? '' : 'pausada'}`} role="row">
              <div>
                <b>
                  {c.nome} {c.admin && <span className="selo">admin</span>} {!c.ativa && <span className="selo ruim">pausada</span>}
                  {!c.senha_definida && <span className="selo">sem senha ainda</span>}
                </b>
                <small>
                  {c.email} · desde {c.criado} {c.ultimo_uso ? `· último uso ${c.ultimo_uso}` : ''} {c.telegram_ligado ? '· Telegram ligado' : ''}
                </small>
                {c.dispositivos.map((d) => (
                  <small key={d.id} className="site-disp">
                    <Monitor size={12} /> {d.nome || nomeSistema(d.sistema)} · {nomeSistema(d.sistema)} · Jarvis {d.jarvis ?? '—'} · launcher {d.launcher ?? '—'} · visto {d.visto ?? '—'}
                  </small>
                ))}
              </div>
              {c.id !== eu.id && (
                <div className="site-acoes">
                  {!c.senha_definida && (
                    <button
                      className="fantasma"
                      onClick={() =>
                        tentar(async () => {
                          const r = await chamar<{ link: string }>(`/api/site/admin/contas/${c.id}/link`, 'POST')
                          setLink({ para: c.nome, link: r.link })
                        }, 'Link novo gerado')
                      }
                    >
                      Novo link
                    </button>
                  )}
                  <button className="fantasma" onClick={() => tentar(() => chamar(`/api/site/admin/contas/${c.id}/${c.ativa ? 'pausar' : 'ativar'}`, 'POST'), c.ativa ? 'Conta pausada' : 'Conta ativada')}>
                    {c.ativa ? <Pause size={14} /> : <Play size={14} />} {c.ativa ? 'Pausar' : 'Ativar'}
                  </button>
                  <button
                    className="fantasma perigo"
                    onClick={() => {
                      const conf = prompt(`Apagar a conta de ${c.nome} e os dados dela na nuvem (financeiro, memória)? Ficam 30 dias na lixeira do servidor.\\n\\nDigite o e-mail da conta para confirmar:`)
                      if (conf) tentar(() => chamar(`/api/site/admin/contas/${c.id}`, 'DELETE', { confirmar_email: conf }), 'Conta apagada')
                    }}
                  >
                    <Trash2 size={14} /> Apagar
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <form className="site-linha" onSubmit={criar}>
          <input placeholder="Nome" value={nome} onChange={(e) => setNome(e.target.value)} required />
          <input type="email" placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <button className="primario">Criar conta</button>
        </form>
        {link && (
          <div className="site-link">
            <span>
              Mande para {link.para} (vale 7 dias): <code>{link.link}</code>
            </span>
            <button className="fantasma" onClick={() => copiar(link.link)}>
              <Copy size={14} /> Copiar
            </button>
            <button className="icone" aria-label="Fechar" onClick={() => setLink(null)}>
              <X size={14} />
            </button>
          </div>
        )}
        {erro && <p className="erro">{erro}</p>}
      </section>

      <section className="site-cartao">
        <h2>
          <Send size={18} /> Robô do Telegram
        </h2>
        <p className="apagado">{eu.robo ? `@${eu.robo} no ar, para todas as contas.` : 'Um robô para todos: crie no @BotFather (/newbot) e cole o token aqui.'}</p>
        <form
          className="site-linha"
          onSubmit={(e) => {
            e.preventDefault()
            tentar(async () => {
              const r = await chamar<{ ok: boolean; erro?: string }>('/api/site/admin/telegram', 'PUT', { token: robo })
              if (!r.ok) throw new Error(r.erro || 'Não deu certo')
              setRobo('')
              recarregar()
            }, 'Robô configurado')
          }}
        >
          <input type="password" placeholder="Token do @BotFather" value={robo} onChange={(e) => setRobo(e.target.value)} required />
          <button className="primario">{eu.robo ? 'Trocar' : 'Salvar'}</button>
        </form>
      </section>

      <section className="site-cartao">
        <h2>Versões publicadas</h2>
        <div className="site-versoes">
          {SISTEMAS.map((s) => (
            <div key={s.id}>
              <b>{s.nome}</b>
              {(versoes.jarvis?.[s.id] ?? []).slice(0, 3).map((v) => (
                <small key={v.versao}>
                  Jarvis {v.versao} · {v.data}
                </small>
              ))}
              {(versoes.launcher?.[s.id] ?? []).slice(0, 1).map((v) => (
                <small key={v.versao}>
                  Launcher {v.versao} · {v.data}
                </small>
              ))}
              {!(versoes.jarvis?.[s.id] ?? []).length && <small className="apagado">nada publicado ainda</small>}
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
