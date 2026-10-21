import { Ear, EarOff, LayoutDashboard, Mic, MicOff, Play, SendHorizontal, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { CardChip, CardView } from './Cards'
import { Orb } from './Orb'
import { useJarvis, type Phase } from './useJarvis'

const PHASE_LABEL: Record<Phase, string> = {
  espera: 'Em espera',
  ouvindo: 'Ouvindo',
  pensando: 'Pensando',
  falando: 'Falando',
}

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return <time>{now.toLocaleTimeString('pt-BR')}</time>
}

export function Hud() {
  const j = useJarvis('hud')
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [text, setText] = useState('')
  const voiceOn = j.status.voice === 'live' || j.status.voice === 'connecting'
  const focus = j.cards.find((c) => c.id === j.focusId) ?? null
  const strip = j.cards.length > 1 || (j.cards.length === 1 && !focus) ? j.cards : []

  useEffect(() => {
    fetch('/api/status')
      .then((r) => r.json())
      .then((s) => setHasKey(!!s.has_key))
      .catch(() => setHasKey(null))
  }, [j.online])

  // Barra de espaço liga e desliga o microfone (fora de campos de texto).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (e.target as HTMLElement).closest('input, textarea, button')) return
      e.preventDefault()
      if (voiceOn) j.stopVoice()
      else j.startVoice()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [voiceOn, j])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    j.sendText(text.trim())
    setText('')
  }

  const error = j.micError ?? j.wakeError ?? (j.status.voice === 'error' ? j.status.error : null)
  const showNote = !j.caption && j.phase !== 'falando' && (error || (hasKey === false && j.status.voice !== 'demo'))

  return (
    <main className={`hud phase-${j.phase} ${focus ? 'has-card' : ''}`}>
      <div className="hud-grid" aria-hidden="true" />

      <header className="hud-bar">
        <span className="hud-brand">J.A.R.V.I.S.</span>
        <span className={`hud-dot ${j.online ? 'on' : ''}`} />
        <span>{j.online ? 'Sistema online' : 'Reconectando'}</span>
        <span className="hud-sep" />
        <span>{voiceOn ? `Voz · ${j.status.model ?? ''}` : j.status.voice === 'demo' ? 'Demonstração' : 'Voz desligada'}</span>
        <span className="hud-spacer" />
        <a className="hud-link" href="/admin">
          <LayoutDashboard size={13} /> Painel
        </a>
        <Clock />
      </header>

      <div className="hud-state" aria-live="polite">
        <span>{PHASE_LABEL[j.phase]}</span>
        <i />
      </div>

      <section className="hud-stage">
        <div className="orb-wrap">
          <Orb live={j.live} phase={j.phase} />
        </div>
        {focus && (
          <div className="focus" key={focus.id}>
            <CardView card={focus} onClose={() => j.closeCard(focus.id)} />
          </div>
        )}
      </section>

      {strip.length > 0 && (
        <nav className="strip" aria-label="Cartões anteriores">
          {strip.map((c) => (
            <CardChip key={c.id} card={c} active={c.id === j.focusId} onClick={() => j.setFocusId(c.id === j.focusId ? null : c.id)} />
          ))}
        </nav>
      )}

      <div className="hud-caption" aria-live="polite">
        {j.phase === 'pensando' || j.phase === 'ouvindo' ? (
          j.userLine && <p className="you">{j.userLine}</p>
        ) : (
          j.caption && <p key={j.caption}>{j.caption}</p>
        )}
      </div>

      <footer className="hud-controls">
        <form className="ask" onSubmit={submit}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={voiceOn ? 'Escreva para o Jarvis…' : 'Ligue a voz para conversar'}
            disabled={!voiceOn}
            aria-label="Mensagem para o Jarvis"
          />
          <button type="submit" disabled={!voiceOn || !text.trim()} aria-label="Enviar">
            <SendHorizontal size={15} />
          </button>
        </form>

        <button
          className={`mic ${voiceOn ? 'is-on' : ''}`}
          onClick={voiceOn ? j.stopVoice : j.startVoice}
          aria-label={voiceOn ? 'Desligar voz' : 'Ligar voz'}
          title="Espaço liga e desliga"
        >
          {voiceOn ? <Mic size={20} /> : <MicOff size={20} />}
        </button>

        <div className="side">
          <button className={`ghost ${j.wake ? 'is-on' : ''}`} onClick={j.toggleWake} title="Diga 'Jarvis' para abrir a conversa">
            {j.wake ? <Ear size={14} /> : <EarOff size={14} />}
            {j.wake ? 'Ativar com "Jarvis": sim' : 'Ativar com "Jarvis": não'}
          </button>
          <button className="ghost" onClick={j.toggleBarge} title="Com fone de ouvido você pode interromper o Jarvis falando">
            {j.bargeIn ? <Volume2 size={14} /> : <VolumeX size={14} />}
            {j.bargeIn ? 'Interromper falando: sim' : 'Interromper falando: não'}
          </button>
          {hasKey === false && (
            <button className="ghost" onClick={() => fetch('/api/demo', { method: 'POST' })}>
              <Play size={14} /> Ver demonstração
            </button>
          )}
        </div>
      </footer>

      {showNote && (
        <p className="hud-note" role={error ? 'alert' : undefined}>
          {error ?? 'Voz desligada: falta a chave GEMINI_API_KEY no arquivo .env. A demonstração funciona sem ela.'}
        </p>
      )}
    </main>
  )
}
