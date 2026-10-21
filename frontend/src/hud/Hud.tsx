import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Camera,
  CameraOff,
  Cloud,
  Ear,
  EarOff,
  Bell,
  Hand,
  Headphones,
  LayoutDashboard,
  Mic,
  MicOff,
  MonitorUp,
  Play,
  ScanFace,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { startGestures, type GestureAction } from '../lib/gestures'
import { CardChip, CardView } from './Cards'
import { Orb } from './Orb'
import { Channel, PANELS, Services, SignalIn, Spectrum, VoiceRead, Weather, type PanelId } from './Panels'
import { Presence } from './Presence'
import { useJarvis, type Phase } from './useJarvis'

const PHASE_LABEL: Record<Phase, string> = { espera: 'Em espera', ouvindo: 'Ouvindo', pensando: 'Pensando', falando: 'Falando' }

type Layout = { left: PanelId[]; right: PanelId[]; hidden: PanelId[] }
const LAYOUT_KEY = 'jarvis.hudLayout'
const DEFAULT_LAYOUT: Layout = { left: ['entrada', 'espectro', 'leitura', 'servicos'], right: ['clima', 'canal'], hidden: [] }

function loadLayout(): Layout {
  try {
    const l = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null')
    if (l?.left && l?.right) return { hidden: [], ...l }
  } catch {
    /* padrão */
  }
  return DEFAULT_LAYOUT
}

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

export function Hud() {
  const j = useJarvis('hud')
  const now = useClock()
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [layout, setLayout] = useState<Layout>(loadLayout)
  const [managing, setManaging] = useState(false)
  const [screensOpen, setScreensOpen] = useState(false)
  const [screens, setScreens] = useState<{ id: string; nome: string }[]>([])
  const [presenceOn, setPresenceOn] = useState(() => {
    try {
      return localStorage.getItem('jarvis.presence') === '1'
    } catch {
      return false
    }
  })
  const [presenceError, setPresenceError] = useState<string | null>(null)
  const [gestures, setGestures] = useState(false)
  const [gestureToast, setGestureToast] = useState<string | null>(null)

  const voiceOn = j.status.voice === 'live' || j.status.voice === 'connecting'
  const focus = j.cards.find((c) => c.id === j.focusId) ?? null
  const strip = j.cards.length > 1 || (j.cards.length === 1 && !focus) ? j.cards : []

  useEffect(() => {
    api('/api/status')
      .then((s) => setHasKey(!!s.has_key))
      .catch(() => setHasKey(null))
  }, [j.online])
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
    } catch {
      /* sem armazenamento */
    }
  }, [layout])
  useEffect(() => {
    try {
      localStorage.setItem('jarvis.presence', presenceOn ? '1' : '0')
    } catch {
      /* sem armazenamento */
    }
    if (!presenceOn) setPresenceError(null)
  }, [presenceOn])

  // Espaço liga e desliga o microfone (fora de campos de texto).
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

  // Gestos: a ação usa a versão mais recente do estado pelo ref
  const gestureRef = useRef<(a: GestureAction) => void>(() => {})
  gestureRef.current = (a: GestureAction) => {
    if (a === 'ouvir') {
      if (voiceOn) j.stopVoice()
      else j.startVoice()
    } else if (a === 'fechar') j.clearCards()
    else if (a === 'proximo' && j.cards.length) {
      const i = j.cards.findIndex((c) => c.id === j.focusId)
      j.setFocusId(j.cards[(i + 1) % j.cards.length].id)
    } else if (a === 'sim') j.ask('Sim')
    else if (a === 'nao') j.ask('Não')
  }
  useEffect(() => {
    if (!gestures) return
    let stop: (() => void) | null = null
    let cancelled = false
    startGestures(
      (a, label) => {
        gestureRef.current(a)
        setGestureToast(label)
        setTimeout(() => setGestureToast(null), 1800)
      },
      (m) => setPresenceError(m),
    )
      .then((s) => {
        if (cancelled) s()
        else stop = s
      })
      .catch(() => setPresenceError('Não consegui carregar o reconhecimento de gestos.'))
    return () => {
      cancelled = true
      stop?.()
    }
  }, [gestures])

  const { send, ask } = j
  const onPresenceStep = useCallback((etapa: string) => send({ type: 'presenca', etapa }), [send])
  const onRecognized = useCallback(async () => {
    const p = await api<{ briefing: boolean }>('/api/presenca').catch(() => ({ briefing: false }))
    if (!p.briefing) return false
    await api('/api/presenca/briefing', { method: 'POST' })
    await ask('Bom dia')
    return true
  }, [ask])

  const services = useMemo(
    () => [
      { nome: 'Núcleo', estado: j.online ? 'online' : 'offline', ok: j.online },
      { nome: 'Reconhec. de voz', estado: j.wake ? 'ativo' : voiceOn ? 'sessão' : 'em espera', ok: j.wake || voiceOn ? true : null },
      {
        nome: 'Motor NLP',
        estado: j.status.voice === 'live' ? 'online' : j.status.voice === 'error' ? 'erro' : 'pronto',
        ok: j.status.voice === 'error' ? false : j.status.voice === 'live' ? true : null,
      },
      { nome: 'Microfone', estado: j.micError ? 'bloqueado' : voiceOn ? 'ativo' : 'desligado', ok: j.micError ? false : voiceOn ? true : null },
      { nome: 'Síntese de voz', estado: 'gemini', ok: hasKey === false ? false : true },
      { nome: 'Visão', estado: j.vision === 'off' ? 'desligada' : j.vision, ok: j.vision === 'off' ? null : true },
    ],
    [j.online, j.wake, j.status.voice, j.micError, j.vision, voiceOn, hasKey],
  )

  const renderPanel = (id: PanelId) => {
    if (layout.hidden.includes(id)) return null
    switch (id) {
      case 'entrada':
        return <SignalIn key={id} scope={j.scope} live={j.live} />
      case 'espectro':
        return <Spectrum key={id} scope={j.scope} />
      case 'leitura':
        return <VoiceRead key={id} live={j.live} />
      case 'servicos':
        return <Services key={id} items={services} />
      case 'clima':
        return <Weather key={id} />
      case 'canal':
        return <Channel key={id} log={j.log} ready={j.status.voice === 'live'} onSend={(t) => j.ask(t)} />
    }
  }

  const openScreens = async () => {
    setScreensOpen((v) => !v)
    if (!screens.length) setScreens(await api('/api/ajustes/telas'))
  }

  const error = j.micError ?? j.wakeError ?? presenceError ?? (j.status.voice === 'error' ? j.status.error : null)
  const showNote = !j.caption && j.phase !== 'falando' && (error || (hasKey === false && j.status.voice !== 'demo'))
  const link = j.status.voice === 'live' ? 'ativo' : j.status.voice === 'connecting' ? 'conectando' : j.wake ? 'armado' : 'desligado'

  return (
    <main className={`hud phase-${j.phase} ${focus ? 'has-card' : ''}`}>
      <div className="hud-grid" aria-hidden="true" />

      <header className="hud-top">
        <div className="brand-l">
          <b>JARVIS</b>
          <span>· Assistente de IA</span>
        </div>
        <div className="top-pill">
          <span>Personalizado · Sincronizado</span>
          <i />
          <button onClick={() => setManaging(true)}>Gerenciar HUD</button>
        </div>
        <div className="top-r">
          <span className={`hud-dot ${j.online ? 'on' : ''}`} />
          <span>{j.online ? 'Sistema online' : 'Reconectando'}</span>
          <span className="link-state">Voice link {link}</span>
          <a className="hud-link" href="/admin" aria-label="Abrir o painel" title="Painel">
            <LayoutDashboard size={13} />
          </a>
          <time>{now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</time>
        </div>
      </header>

      <div className="hud-body">
        <aside className="hud-col left">{layout.left.map(renderPanel)}</aside>

        <section className="hud-center">
          <div className="hud-state" aria-live="polite">
            <span>{PHASE_LABEL[j.phase]}</span>
            <i />
          </div>
          <div className="hud-stage">
            <div className="orb-wrap">
              <Orb live={j.live} phase={j.phase} />
            </div>
            {focus && (
              <div className="focus" key={focus.id}>
                <CardView card={focus} onClose={() => j.closeCard(focus.id)} />
              </div>
            )}
            {j.vision !== 'off' && <VisionPreview stream={j.visionStream.current} kind={j.vision} onStop={j.stopVision} />}
          </div>
          {strip.length > 0 && (
            <nav className="strip" aria-label="Cartões anteriores">
              {strip.map((c) => (
                <CardChip key={c.id} card={c} active={c.id === j.focusId} onClick={() => j.setFocusId(c.id === j.focusId ? null : c.id)} />
              ))}
            </nav>
          )}
          <div className="hud-caption" aria-live="polite">
            {j.phase === 'pensando' || j.phase === 'ouvindo' ? j.userLine && <p className="you">{j.userLine}</p> : j.caption && <p key={j.caption}>{j.caption}</p>}
          </div>
        </section>

        <aside className="hud-col right">{layout.right.map(renderPanel)}</aside>
      </div>

      <footer className="hud-bottom">
        <div className="bottom-l">
          <button className="chip-btn" onClick={openScreens} aria-expanded={screensOpen}>
            Telas
          </button>
          {screensOpen && (
            <div className="pop" role="menu">
              <span className="pop-title">Telas extras</span>
              {screens.map((s) => (
                <a key={s.id} href={`/tela/${s.id}`} target="_blank" rel="noreferrer" role="menuitem">
                  {s.nome}
                </a>
              ))}
              <div className="pop-row">
                <button onClick={() => j.setScreensState('ativas')}>Ativar todas</button>
                <button onClick={() => j.setScreensState('bloqueadas')}>Bloquear</button>
              </div>
            </div>
          )}
          {hasKey === false && (
            <button className="chip-btn" onClick={() => fetch('/api/demo', { method: 'POST' })}>
              <Play size={12} /> Demonstração
            </button>
          )}
        </div>

        <button className={`mic ${voiceOn ? 'is-on' : ''}`} onClick={voiceOn ? j.stopVoice : j.startVoice} aria-label={voiceOn ? 'Desligar voz' : 'Ligar voz'} title="Espaço liga e desliga">
          {voiceOn ? <Mic size={20} /> : <MicOff size={20} />}
        </button>

        <div className="bottom-r">
          <IconToggle on={j.vision === 'camera'} onClick={() => (j.vision === 'camera' ? j.stopVision() : j.startVision('camera'))} label="Câmera: o Jarvis vê você" icon={j.vision === 'camera' ? Camera : CameraOff} />
          <IconToggle on={j.vision === 'tela'} onClick={() => (j.vision === 'tela' ? j.stopVision() : j.startVision('tela'))} label="Compartilhar a tela com o Jarvis" icon={MonitorUp} />
          <IconToggle on={gestures} onClick={() => setGestures((v) => !v)} label="Gestos: mão aberta liga a voz, punho fecha cartões, dois dedos passa, polegar sim/não" icon={Hand} />
          <IconToggle on={presenceOn} onClick={() => setPresenceOn((v) => !v)} label="Presença: reconhece seu rosto e abre o dia" icon={ScanFace} />
          <IconToggle on={j.wake} onClick={j.toggleWake} label='Ativar dizendo "Jarvis"' icon={j.wake ? Ear : EarOff} />
          <IconToggle on={j.bargeIn} onClick={j.toggleBarge} label="Interromper falando (use com fone)" icon={Headphones} />
          <span className="cloud">
            <Cloud size={12} /> Nuvem · {j.status.model ?? 'gemini-3.8-live'}
          </span>
        </div>
      </footer>

      {(j.alerts.length > 0 || gestureToast) && (
        <div className="alerts" aria-live="assertive">
          {gestureToast && <div className="alert gesture">{gestureToast}</div>}
          {j.alerts.map((a) => (
            <button key={a.id} className={`alert lv-${a.nivel}`} onClick={() => j.dismissAlert(a.id)}>
              <Bell size={14} />
              <span>
                <b>{a.titulo}</b>
                {a.texto}
              </span>
              <time>{a.at}</time>
            </button>
          ))}
        </div>
      )}

      {showNote && (
        <p className="hud-note" role={error ? 'alert' : undefined}>
          {error ?? 'Voz desligada: falta a chave GEMINI_API_KEY no arquivo .env. A demonstração funciona sem ela.'}
        </p>
      )}

      <Presence enabled={presenceOn} onStep={onPresenceStep} onRecognized={onRecognized} onError={setPresenceError} />

      {managing && <ManageHud layout={layout} onChange={setLayout} onClose={() => setManaging(false)} />}
    </main>
  )
}

function IconToggle({ on, onClick, label, icon: Icon }: { on: boolean; onClick: () => void; label: string; icon: typeof Mic }) {
  return (
    <button className={`icon-tg ${on ? 'on' : ''}`} onClick={onClick} aria-pressed={on} aria-label={label} title={label}>
      <Icon size={14} />
    </button>
  )
}

function VisionPreview({ stream, kind, onStop }: { stream: MediaStream | null; kind: string; onStop: () => void }) {
  return (
    <div className="vision">
      <video
        ref={(el) => {
          if (el && stream && el.srcObject !== stream) {
            el.srcObject = stream
            el.play().catch(() => {})
          }
        }}
        muted
        playsInline
      />
      <span>{kind === 'camera' ? 'Câmera · o Jarvis está vendo' : 'Tela compartilhada'}</span>
      <button onClick={onStop} aria-label="Parar visão">
        <X size={12} />
      </button>
    </div>
  )
}

function ManageHud({ layout, onChange, onClose }: { layout: Layout; onChange: (l: Layout) => void; onClose: () => void }) {
  const move = (side: 'left' | 'right', id: PanelId, d: -1 | 1) => {
    const list = [...layout[side]]
    const i = list.indexOf(id)
    const k = i + d
    if (k < 0 || k >= list.length) return
    ;[list[i], list[k]] = [list[k], list[i]]
    onChange({ ...layout, [side]: list })
  }
  const swap = (side: 'left' | 'right', id: PanelId) => {
    const other = side === 'left' ? 'right' : 'left'
    onChange({ ...layout, [side]: layout[side].filter((x) => x !== id), [other]: [...layout[other], id] })
  }
  const toggle = (id: PanelId) =>
    onChange({ ...layout, hidden: layout.hidden.includes(id) ? layout.hidden.filter((x) => x !== id) : [...layout.hidden, id] })
  return (
    <aside className="drawer hud-drawer" role="dialog" aria-label="Gerenciar HUD">
      <header>
        <h2>Gerenciar HUD</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Fechar">
          <X size={15} />
        </button>
      </header>
      <p className="muted small">Mostre ou esconda painéis, mude a ordem e troque de lado. Fica salvo neste navegador.</p>
      {(['left', 'right'] as const).map((side) => (
        <section key={side} className="side-sec">
          <span className="w-label">{side === 'left' ? 'Coluna esquerda' : 'Coluna direita'}</span>
          <ul className="wlist">
            {layout[side].map((id) => {
              const on = !layout.hidden.includes(id)
              return (
                <li key={id} className={on ? 'on' : ''}>
                  <label>
                    <input type="checkbox" checked={on} onChange={() => toggle(id)} />
                    <span className="check" aria-hidden="true" />
                    <span>
                      <b>{PANELS[id].nome}</b>
                      <small>{PANELS[id].desc}</small>
                    </span>
                  </label>
                  <span className="order">
                    <button onClick={() => move(side, id, -1)} aria-label="Subir">
                      <ArrowUp size={13} />
                    </button>
                    <button onClick={() => move(side, id, 1)} aria-label="Descer">
                      <ArrowDown size={13} />
                    </button>
                    <button onClick={() => swap(side, id)} aria-label="Trocar de lado">
                      <ArrowLeftRight size={13} />
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
      <footer>
        <button className="ghost" onClick={() => onChange(DEFAULT_LAYOUT)}>
          Restaurar padrão
        </button>
        <button className="primary" onClick={onClose}>
          Pronto
        </button>
      </footer>
    </aside>
  )
}
