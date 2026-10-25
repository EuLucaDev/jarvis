// Configuração inicial: abre na primeira vez (e quando faltar a chave da IA). Quatro passos curtos:
// boas-vindas, chave da Gemini (com teste), quem é você e as permissões do sistema.

import { ArrowRight, Check, ExternalLink, KeyRound, Loader2, ShieldCheck, User } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { app } from '../lib/app'
import { Aura } from '../ui/Aura'
import './setup.css'

const VOZES = [
  ['Charon', 'grave e calma'],
  ['Orus', 'firme'],
  ['Fenrir', 'animada'],
  ['Puck', 'leve'],
  ['Kore', 'feminina, firme'],
  ['Aoede', 'feminina, suave'],
] as const

type Cfg = { tem_chave: boolean; user_name: string; tratamento: string; city: string; voice: string; camera_auto: boolean; sistema: string; configurado: boolean }

export function Setup() {
  const [passo, setPasso] = useState(0)
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [chave, setChave] = useState('')
  const [teste, setTeste] = useState<{ ok: boolean; erro?: string; aviso?: string } | null>(null)
  const [testando, setTestando] = useState(false)
  const [nome, setNome] = useState('')
  const [cidade, setCidade] = useState('')
  const [trato, setTrato] = useState('Senhor')
  const [voz, setVoz] = useState('Charon')
  const [camera, setCamera] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [perm, setPerm] = useState<Record<string, any>>({})

  useEffect(() => {
    api<Cfg>('/api/setup').then((c) => {
      setCfg(c)
      setNome(c.user_name || '')
      setTrato(c.tratamento ?? 'Senhor')
      setCidade(c.city || '')
      setVoz(c.voice || 'Charon')
      setCamera(c.camera_auto)
    })
  }, [])
  useEffect(() => {
    if (passo === 3) api('/api/permissoes').then(setPerm).catch(() => {})
  }, [passo])

  const testar = async () => {
    setTestando(true)
    setTeste(await api('/api/setup/testar', { method: 'POST', json: { chave } }).catch((e) => ({ ok: false, erro: String(e) })))
    setTestando(false)
  }
  const concluir = async () => {
    setSalvando(true)
    await api('/api/setup', {
      method: 'POST',
      json: { ...(chave.trim() ? { gemini_api_key: chave.trim() } : {}), user_name: nome.trim(), tratamento: trato, city: cidade.trim(), voice: voz, camera_auto: camera },
    })
    setSalvando(false)
    await app.setupDone()
    if (!(window as unknown as { __TAURI__?: unknown }).__TAURI__) location.href = '/'
  }

  if (!cfg) return <main className="setup" />
  const temChave = cfg.tem_chave || teste?.ok
  const mac = cfg.sistema === 'mac'

  return (
    <main className="setup">
      <div className="setup-orb" aria-hidden="true">
        <Aura maxRes={420} />
      </div>
      <section className="setup-card">
        <ol className="setup-steps" aria-label="Passos">
          {['Boas-vindas', 'Inteligência', 'Você', 'Permissões'].map((p, i) => (
            <li key={p} className={i === passo ? 'on' : i < passo ? 'done' : ''}>
              {i < passo ? <Check size={11} /> : i + 1} {p}
            </li>
          ))}
        </ol>

        {passo === 0 && (
          <div className="setup-body">
            <h1>J.A.R.V.I.S.</h1>
            <p>Seu assistente de voz. Ele ouve quando você diz “Jarvis” ou bate duas palmas, mostra o que encontra em cartões na tela e mexe no computador quando você pede, à vista. Com a câmera, as mãos viram o ponteiro.</p>
            <p className="muted">São quatro passos rápidos. Tudo fica guardado só neste computador.</p>
            <button className="primary" onClick={() => setPasso(1)}>
              Começar <ArrowRight size={15} />
            </button>
          </div>
        )}

        {passo === 1 && (
          <div className="setup-body">
            <h2>
              <KeyRound size={18} /> Chave da inteligência (Gemini)
            </h2>
            <p>
              O Jarvis conversa usando a Gemini, do Google. A chave é grátis: entre com sua conta Google, clique em <b>Create API key</b> e cole aqui.
            </p>
            <a className="link" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
              Abrir o Google AI Studio <ExternalLink size={13} />
            </a>
            {cfg.tem_chave && !chave && <p className="ok-line">Já existe uma chave salva. Pode seguir ou colar outra.</p>}
            <div className="row">
              <input
                type="password"
                value={chave}
                onChange={(e) => {
                  setChave(e.target.value)
                  setTeste(null)
                }}
                placeholder="Cole a chave aqui (começa com AIza…)"
                autoFocus
              />
              <button onClick={testar} disabled={!chave.trim() || testando}>
                {testando ? <Loader2 size={14} className="spin" /> : 'Testar'}
              </button>
            </div>
            {teste && <p className={teste.ok ? 'ok-line' : 'err-line'}>{teste.ok ? (teste.aviso ?? 'Chave funcionando.') : teste.erro}</p>}
            <div className="setup-nav">
              <button className="ghost" onClick={() => setPasso(0)}>
                Voltar
              </button>
              <button className="primary" disabled={!temChave} onClick={() => setPasso(2)}>
                Continuar <ArrowRight size={15} />
              </button>
            </div>
          </div>
        )}

        {passo === 2 && (
          <div className="setup-body">
            <h2>
              <User size={18} /> Quem é você
            </h2>
            <label>
              <span>Seu nome</span>
              <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Ana" />
            </label>
            <span className="label">Como o Jarvis te chama</span>
            <div className="voices" role="radiogroup">
              {[
                ['Senhor', '“Pois não, Senhor”'],
                ['Senhora', '“Pois não, Senhora”'],
                ['', nome.trim() ? `Pelo nome: “${nome.trim()}”` : 'Pelo nome'],
              ].map(([id, desc]) => (
                <button key={id || 'nome'} role="radio" aria-checked={trato === id} className={trato === id ? 'on' : ''} onClick={() => setTrato(id)}>
                  <b>{id || 'Nome'}</b>
                  <small>{desc}</small>
                </button>
              ))}
            </div>
            <label>
              <span>Sua cidade (para o clima)</span>
              <input value={cidade} onChange={(e) => setCidade(e.target.value)} placeholder="Ex.: Maceió" />
            </label>
            <span className="label">Voz do Jarvis</span>
            <div className="voices" role="radiogroup">
              {VOZES.map(([id, desc]) => (
                <button key={id} role="radio" aria-checked={voz === id} className={voz === id ? 'on' : ''} onClick={() => setVoz(id)}>
                  <b>{id}</b>
                  <small>{desc}</small>
                </button>
              ))}
            </div>
            <label className="check">
              <input type="checkbox" checked={camera} onChange={(e) => setCamera(e.target.checked)} />
              <span>Ligar a câmera junto com o Jarvis (as mãos viram o ponteiro; nada sai do computador)</span>
            </label>
            <div className="setup-nav">
              <button className="ghost" onClick={() => setPasso(1)}>
                Voltar
              </button>
              <button className="primary" disabled={!nome.trim()} onClick={() => setPasso(3)}>
                Continuar <ArrowRight size={15} />
              </button>
            </div>
          </div>
        )}

        {passo === 3 && (
          <div className="setup-body">
            <h2>
              <ShieldCheck size={18} /> Permissões
            </h2>
            {mac ? (
              <>
                <p>O macOS vai perguntar algumas vezes. Para tudo funcionar, permita para o <b>Jarvis</b>:</p>
                <ul className="perms">
                  <li className={perm.microfone ? 'ok' : ''}>Microfone: para ouvir você</li>
                  <li className={perm.camera ? 'ok' : ''}>Câmera: para as mãos e para ele ver</li>
                  <li className={perm.acessibilidade ? 'ok' : ''}>
                    Acessibilidade: para clicar, digitar e mexer nas janelas{' '}
                    {!perm.acessibilidade && (
                      <button className="mini" onClick={() => api('/api/permissoes/acessibilidade', { method: 'POST' })}>
                        Abrir ajustes
                      </button>
                    )}
                  </li>
                  <li>Gravação de Tela: para ele ver a área que você mostra</li>
                </ul>
                <p className="muted">Depois de ligar a Acessibilidade, feche e abra o Jarvis uma vez.</p>
              </>
            ) : cfg.sistema === 'windows' ? (
              <p>No Windows não há permissões a liberar. Se o Windows Defender perguntar sobre a rede, permita só “redes privadas”.</p>
            ) : (
              <p>
                No Linux, o controle de janelas funciona em sessões <b>X11</b> e precisa de <code>wmctrl</code>, <code>xdotool</code> e <code>xclip</code> (sudo apt install wmctrl xdotool xclip libportaudio2).
              </p>
            )}
            <div className="setup-nav">
              <button className="ghost" onClick={() => setPasso(2)}>
                Voltar
              </button>
              <button className="primary" onClick={concluir} disabled={salvando}>
                {salvando ? <Loader2 size={15} className="spin" /> : <Check size={15} />} Concluir
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  )
}
