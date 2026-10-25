import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Brush,
  Camera,
  CameraOff,
  Cloud,
  Ear,
  EarOff,
  Bell,
  Hand,
  Lightbulb,
  Square,
  Timer,
  Headphones,
  LayoutDashboard,
  LayoutGrid,
  Mic,
  MicOff,
  MonitorUp,
  Play,
  ScanFace,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { startGestures, type GestureAction } from '../lib/gestures'
import { play, setSoundsOn, soundsOn } from '../lib/sfx'
import { useWidgetData } from '../tela/Tela'
import { CardChip, cardText, CardView } from './Cards'
import { Orb } from './Orb'
import { airStore, loadHold, loadPinned, saveHold, savePinned, useAirControl, type Pinned } from './air'
import { Updater } from './Update'
import { Board, Deck, DropZones, GesturePanel, HandCursors, PinnedCards, Tasks } from './Overlays'
import { Channel, PANELS, Services, SignalIn, Spectrum, VoiceRead, Weather, type PanelId } from './Panels'
import { Presence } from './Presence'
import { useJarvis, type Phase } from './useJarvis'

const appBridge = (window as unknown as { jarvisApp?: { onHud?: (cb: (s: any) => void) => void; showHud: () => void; minimize: () => void } }).jarvisApp

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
  const [board, setBoard] = useState(false)
  const [pinned, setPinnedState] = useState<Pinned[]>(loadPinned)
  const [scales, setScales] = useState<Record<string, number>>({}) // tamanho fixado de cada cartão em foco
  const [hold, setHold] = useState(loadHold)
  const [mouse, setMouse] = useState(false) // a mão controla o mouse do Mac
  const [sounds, setSounds] = useState(soundsOn)
  const data = useWidgetData(j)

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

  const setPinned = useCallback((p: Pinned[]) => {
    setPinnedState(p)
    savePinned(p)
  }, [])
  const setPeriod = useCallback((id: string, periodo: string) => j.send({ type: 'mercado.periodo', id, periodo }), [j])
  // cartão fixo acompanha as atualizações do mesmo cartão (ex.: período do mercado trocado)
  useEffect(() => {
    setPinnedState((ps) => {
      let changed = false
      const next = ps.map((p) => {
        const c = j.cards.find((x) => x.id === p.card.id)
        if (c && c !== p.card && JSON.stringify(c.data) !== JSON.stringify(p.card.data)) {
          changed = true
          return { ...p, card: c }
        }
        return p
      })
      if (changed) savePinned(next)
      return changed ? next : ps
    })
  }, [j.cards])

  // Teste sem câmera: /?air=teste expõe window.jarvisAir(quadro) para simular as mãos.
  const airTest = useMemo(() => new URLSearchParams(location.search).get('air') === 'teste', [])
  useEffect(() => {
    if (airTest) Object.assign(window, { jarvisAir: (f: Parameters<typeof air.onFrame>[0]) => airFrame.current(f) })
  }, [airTest])

  const setScale = useCallback((id: string, z: number) => setScales((s) => ({ ...s, [id]: z })), [])
  const sendMouse = useCallback((m: object) => j.send({ type: 'mouse', ...m }), [j])
  const copyCard = useCallback(
    (c: (typeof j.cards)[number]) => {
      j.send({ type: 'copiar', texto: cardText(c) })
      play('ack')
    },
    [j],
  )
  // "isso aqui": o cartão apontado pela mão vai para o servidor (depois de 400 ms parado em cima)
  const pointTimer = useRef(0)
  const onPoint = useCallback(
    (id: string | null) => {
      clearTimeout(pointTimer.current)
      pointTimer.current = window.setTimeout(() => {
        const c = id ? (j.cards.find((x) => x.id === id) ?? pinned.find((p) => p.card.id === id)?.card) : null
        j.send({ type: 'apontado', alvo: c ? { tipo: 'cartão no HUD', categoria: c.kind, titulo: c.data.titulo ?? c.data.cidade ?? '', conteudo: cardText(c).slice(0, 2000) } : null })
      }, 400)
    },
    [j, pinned],
  )
  // app instalado: com o HUD minimizado, escondido ou atrás de outra janela, as mãos mexem nas janelas do Mac
  const [hudApp, setHudApp] = useState<{ visible: boolean; focused: boolean } | null>(null)
  useEffect(() => {
    appBridge?.onHud?.((s: { visible: boolean; focused: boolean }) => setHudApp({ visible: s.visible, focused: s.focused }))
  }, [])
  const desk = !!hudApp && (!hudApp.visible || !hudApp.focused)

  // "Jarvis" ou duas palmas com ele escondido: o HUD aparece com a abertura e ele já fala
  const [intro, setIntro] = useState<string | null>(null)
  useEffect(() => {
    const w = j.wakeCall
    if (!w) return
    appBridge?.showHud()
    const h = new Date().getHours()
    const saud = h < 12 ? 'Bom dia, Senhor' : h < 18 ? 'Boa tarde, Senhor' : 'Boa noite, Senhor'
    setIntro(w.comando ? 'Às ordens, Senhor' : saud)
    play('unlock')
    const t1 = setTimeout(() => {
      if (w.comando) j.ask(w.comando)
      else if (w.bomDia) j.ask('Bom dia')
      else j.ask('[Ativação] Ele acabou de te chamar. Cumprimente em uma frase curta, de acordo com o horário, e pergunte como pode ajudar.')
    }, 900)
    const t2 = setTimeout(() => setIntro(null), 2600)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [j.wakeCall])
  const sendWin = useCallback((m: object) => j.send(m), [j])
  const air = useAirControl({ board, mouse, hold, focus, pinned, scales, setScale, setPinned, setFocusId: j.setFocusId, closeCard: j.closeCard, setPeriod, sendMouse, desk, sendWin, copyCard, onPoint })

  // a esfera "olha" para a mão (só um pouco), sem re-renderizar o HUD
  useEffect(
    () =>
      airStore.subscribe(() => {
        const h = airStore.get().hands[0]
        const el = document.documentElement
        el.style.setProperty('--look-x', h ? String((h.x - 0.5) * 2) : '0')
        el.style.setProperty('--look-y', h ? String((h.y - 0.5) * 2) : '0')
      }),
    [],
  )
  // luz ambiente acompanha a fase (o servidor só age se estiver ligada no painel)
  useEffect(() => {
    j.send({ type: 'fase', fase: j.phase })
  }, [j.phase, j])
  const [stopToast, setStopToast] = useState(false)
  useEffect(() => {
    if (!j.stoppedAt) return
    setStopToast(true)
    const t = setTimeout(() => setStopToast(false), 2500)
    return () => clearTimeout(t)
  }, [j.stoppedAt])
  const focoMin = j.focusUntil ? Math.max(0, Math.ceil((j.focusUntil - now.getTime()) / 60000)) : 0
  const acceptSuggestion = (s: { id: string; pedido: string }) => {
    j.dismissSuggestion(s.id)
    j.ask(`[Sugestão aceita] ${s.pedido}`)
  }
  // "Jarvis, modo mouse": o servidor avisa o HUD; o modo mouse precisa dos gestos ligados
  useEffect(() => {
    if (!j.mouseMode) return
    setMouse(j.mouseMode.on)
    if (j.mouseMode.on) setGestures(true)
  }, [j.mouseMode])
  const airFrame = useRef(air.onFrame)
  airFrame.current = air.onFrame

  // Gestos discretos (poses e deslizes): a ação usa a versão mais recente do estado pelo ref
  const deckViews = ['agenda', 'comunicacoes', 'radar', 'nucleo', ...(data.cams.length ? ['cameras'] : [])]
  const gestureRef = useRef<(a: GestureAction) => void>(() => {})
  gestureRef.current = (a: GestureAction) => {
    if (mouse) {
      // no modo mouse só o punho vale: sai do modo
      if (a === 'fechar') setMouse(false)
      return
    }
    const step = (d: 1 | -1) => {
      if (j.panel) {
        const i = deckViews.indexOf(j.panel)
        j.setPanel(deckViews[(i + d + deckViews.length) % deckViews.length])
      } else if (j.cards.length) {
        const i = j.cards.findIndex((c) => c.id === j.focusId)
        j.setFocusId(j.cards[(i + d + j.cards.length) % j.cards.length].id)
      }
    }
    if (a === 'ouvir') {
      if (voiceOn) j.stopVoice()
      else j.startVoice()
    } else if (a === 'fechar') j.clearCards()
    else if (a === 'proximo' || a === 'esquerda') step(1)
    else if (a === 'direita') step(-1)
    else if (a === 'cima') {
      if (!j.panel && !board) j.setPanel('agenda')
    } else if (a === 'baixo') {
      if (board) setBoard(false)
      else if (j.panel) j.setPanel(null)
      else if (j.focusId) j.setFocusId(null)
    } else if (a === 'sim') {
      // polegar para cima com sugestão na tela aceita a sugestão
      if (j.suggestions[0]) acceptSuggestion(j.suggestions[0])
      else j.ask('Sim')
    }
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
        play('step')
        setTimeout(() => setGestureToast(null), 1800)
      },
      (m) => setPresenceError(m),
      (f) => airFrame.current(f),
    )
      .then((s) => {
        if (cancelled) s()
        else stop = s
      })
      .catch(() => setPresenceError('Não consegui carregar o reconhecimento de gestos.'))
    return () => {
      cancelled = true
      stop?.()
      airStore.set({ hands: [], t: 0 })
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
          {focoMin > 0 && (
            <button className="foco-badge" onClick={() => j.ask('Encerre o modo foco.')} title="Avisos não urgentes esperam o fim do foco. Toque para encerrar.">
              <Timer size={12} /> Foco · {focoMin} min
            </button>
          )}
          <time>{now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</time>
        </div>
      </header>

      <div className="hud-body">
        <aside className="hud-col left">{layout.left.map(renderPanel)}</aside>

        <section className="hud-center">
          <div className="hud-state" aria-live="polite">
            <span>{PHASE_LABEL[j.phase]}</span>
            <i />
            {j.step && j.phase !== 'falando' && <small className="step" key={j.step}>{j.step}…</small>}
            {(j.step || focus?.kind === 'plano') && (
              <button className="stop-btn" onClick={() => j.send({ type: 'parar' })} title="Para o que o Jarvis está fazendo no Mac (ou aperte Esc)">
                <Square size={10} /> Parar · Esc
              </button>
            )}
            {stopToast && <small className="step stopped">Parado. Diga “continua” para seguir.</small>}
          </div>
          <div className="hud-stage">
            <div className="orb-wrap">
              <Orb live={j.live} phase={j.phase} />
            </div>
            {focus && (
              <div
                className={`focus ${air.drag ? 'dragging' : ''} ${air.zone ? `to-${air.zone}` : ''} ${air.live?.id === focus.id ? 'resizing' : ''}`}
                key={focus.id}
                data-id={focus.id}
                style={{
                  transform: `${air.drag ? `translate(${air.drag.x}px, ${air.drag.y}px) rotate(${air.drag.x / 60}deg) ` : ''}scale(${air.live?.id === focus.id ? air.live.z : (scales[focus.id] ?? 1)})`,
                }}
              >
                <CardView card={focus} onClose={() => j.closeCard(focus.id)} onPeriod={(p) => setPeriod(focus.id, p)} preview={air.periodPreview} />
              </div>
            )}
            {j.vision !== 'off' && <VisionPreview stream={j.visionStream.current} kind={j.vision} onStop={j.stopVision} />}
          </div>
          {strip.length > 0 && (
            <nav className="strip" aria-label="Cartões anteriores">
              {strip.map((c) => (
                <CardChip
                  key={c.id}
                  card={c}
                  active={c.id === j.focusId}
                  onClick={() => j.setFocusId(c.id === j.focusId ? null : c.id)}
                  style={air.chipDrag?.id === c.id ? { transform: `translate(${air.chipDrag.x}px, ${air.chipDrag.y}px)` } : undefined}
                />
              ))}
            </nav>
          )}
          <div className="hud-caption" aria-live="polite">
            {j.phase === 'pensando' || j.phase === 'ouvindo' ? j.userLine && <p className="you">{j.userLine}</p> : j.caption && <p key={j.caption}>{j.caption}</p>}
          </div>
        </section>

        <aside className="hud-col right">
          <Tasks tasks={j.tasks} />
          {layout.right.map(renderPanel)}
        </aside>

        {j.panel && <Deck j={j} data={data} view={j.panel} onView={j.setPanel} onClose={() => j.setPanel(null)} />}
        {board && (
          <Board
            onClose={() => setBoard(false)}
            onSend={(jpeg, pedido) => {
              j.ask(pedido || 'Acabei de desenhar isto no quadro. Diga o que entendeu e me ajude com ele.', jpeg)
              setBoard(false)
            }}
          />
        )}
      </div>

      <footer className="hud-bottom">
        <div className="bottom-l">
          <button className={`chip-btn ${j.panel ? 'on' : ''}`} onClick={() => j.setPanel(j.panel ? null : 'agenda')} aria-pressed={!!j.panel}>
            <LayoutGrid size={12} /> Painéis
          </button>
          <button className={`chip-btn ${board ? 'on' : ''}`} onClick={() => setBoard((v) => !v)} aria-pressed={board}>
            <Brush size={12} /> Quadro
          </button>
          <button className="chip-btn" onClick={openScreens} aria-expanded={screensOpen}>
            Telas
          </button>
          {screensOpen && (
            <div className="pop" role="menu">
              <span className="pop-title">Telas extras · para um segundo monitor</span>
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
          <IconToggle
            on={sounds}
            onClick={() => {
              setSoundsOn(!sounds)
              setSounds(!sounds)
              if (!sounds) setTimeout(() => play('ack'), 50)
            }}
            label="Efeitos sonoros"
            icon={sounds ? Volume2 : VolumeX}
          />
          <span className="cloud">
            <Cloud size={12} /> Nuvem · {j.status.model ?? 'gemini-3.8-live'}
          </span>
        </div>
      </footer>

      {j.suggestions.length > 0 && (
        <div className="suggestions" aria-live="polite">
          {j.suggestions.map((s) => (
            <div className="suggestion" key={s.id}>
              <Lightbulb size={14} />
              <span>{s.texto}</span>
              <button className="chip-btn primary" onClick={() => acceptSuggestion(s)}>
                Fazer
              </button>
              <button className="icon-btn" onClick={() => j.dismissSuggestion(s.id)} aria-label="Dispensar sugestão">
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {j.alerts.length > 0 && (
        <div className="alerts" aria-live="assertive">
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

      <Updater event={j.update} />
      <PinnedCards pinned={pinned} onChange={setPinned} onPeriod={setPeriod} live={air.live} preview={air.periodPreview} />
      {air.drag && <DropZones zone={air.zone} />}
      {(gestures || airTest) && (
        <GesturePanel
          status={air.status}
          toast={gestureToast}
          hold={hold}
          onHold={(ms) => {
            setHold(ms)
            saveHold(ms)
          }}
          mouse={mouse}
          onMouse={setMouse}
        />
      )}
      {(gestures || airTest) && !desk && <HandCursors />}
      {intro && <BootIntro texto={intro} />}

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

/** Abertura ao ser chamado: anéis que se montam e a saudação, por cima do HUD. */
function BootIntro({ texto }: { texto: string }) {
  return (
    <div className="boot-intro" aria-live="polite">
      <div className="bi-rings" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <b>{texto}</b>
      <small>Todos os sistemas operacionais</small>
    </div>
  )
}
