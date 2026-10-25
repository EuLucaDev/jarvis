// HUD do Jarvis: a esfera (Aura) no centro com o estado, a frase de etapa e a legenda; sinal, espectro e
// serviços à esquerda; clima, tarefas e o canal de conversa à direita. Os cartões flutuam na camada sobre a
// tela (overlay), onde você arruma com a mão ou o mouse.

import { ArrowDown, ArrowLeftRight, ArrowUp, Bell, Camera, CameraOff, Headphones, LayoutDashboard, LayoutGrid, Lightbulb, Mic, MicOff, Minus, Square, Timer, Volume2, VolumeX, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { app, isApp } from '../lib/app'
import { usePhase, type Phase } from '../lib/live'
import { play, setSoundsOn, soundsOn } from '../lib/sfx'
import { Aura } from '../ui/Aura'
import { Deck, Tasks } from './Deck'
import { Channel, PANELS, Services, SignalIn, Spectrum, VoiceRead, Weather, type PanelId } from './Panels'
import { useJarvis } from './useJarvis'
import { useWidgetData } from './Widgets'

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
  const fase = usePhase()
  const now = useClock()
  const data = useWidgetData(j)
  const [layout, setLayout] = useState<Layout>(loadLayout)
  const [managing, setManaging] = useState(false)
  const [sounds, setSounds] = useState(soundsOn)
  const [barge, setBarge] = useState(false)
  const [intro, setIntro] = useState<string | null>(null)
  const [stopToast, setStopToast] = useState(false)

  const voiceOn = j.status.voice === 'live' || j.status.voice === 'connecting'

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
    } catch {
      /* sem armazenamento */
    }
  }, [layout])
  useEffect(() => {
    api('/api/ajustes/voz')
      .then((v) => setBarge(!!v.interromper))
      .catch(() => {})
  }, [])

  // eventos que o HUD trata: chamado ("Jarvis" ou palmas), pedidos para a própria janela
  useEffect(() => {
    const e = j.last
    if (!e) return
    if (e.type === 'despertar') {
      app.showHud()
      const h = new Date().getHours()
      setIntro(h < 12 ? 'Bom dia, Senhor' : h < 18 ? 'Boa tarde, Senhor' : 'Boa noite, Senhor')
      const t = setTimeout(() => setIntro(null), 2600)
      return () => clearTimeout(t)
    }
    if (e.type === 'janela') {
      if (e.acao === 'minimizar') app.minimize()
      else if (e.acao === 'esconder') app.hide()
      else app.showHud()
    }
  }, [j.last])

  useEffect(() => {
    if (!j.stoppedAt) return
    setStopToast(true)
    const t = setTimeout(() => setStopToast(false), 2500)
    return () => clearTimeout(t)
  }, [j.stoppedAt])

  // Espaço liga e desliga a conversa (fora de campos de texto)
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

  const services = useMemo(
    () => [
      { nome: 'Núcleo', estado: j.online ? 'online' : 'offline', ok: j.online },
      { nome: 'Voz', estado: j.status.voice === 'live' ? 'ao vivo' : j.status.voice === 'error' ? 'erro' : 'em espera', ok: j.status.voice === 'error' ? false : j.status.voice === 'live' ? true : null },
      { nome: 'Câmera', estado: j.camera.erro ? 'erro' : j.camera.ligada ? 'ligada' : 'desligada', ok: j.camera.erro ? false : j.camera.ligada ? true : null },
      { nome: 'Mãos', estado: j.camera.ligada ? 'ativas' : 'paradas', ok: j.camera.ligada ? true : null },
    ],
    [j.online, j.status.voice, j.camera],
  )

  const renderPanel = (id: PanelId) => {
    if (layout.hidden.includes(id)) return null
    switch (id) {
      case 'entrada':
        return <SignalIn key={id} />
      case 'espectro':
        return <Spectrum key={id} />
      case 'leitura':
        return <VoiceRead key={id} />
      case 'servicos':
        return <Services key={id} items={services} />
      case 'clima':
        return <Weather key={id} />
      case 'canal':
        return <Channel key={id} log={j.log} ready={j.status.voice === 'live'} onSend={(t) => j.ask(t)} />
    }
  }

  const toggleCamera = useCallback(() => api(`/api/camera/${j.camera.ligada ? 'desligar' : 'ligar'}`, { method: 'POST' }), [j.camera.ligada])
  const toggleBarge = async () => {
    const v = !barge
    setBarge(v)
    await api('/api/ajustes/voz', { method: 'PUT', json: { interromper: v } })
  }
  const focoMin = j.focusUntil ? Math.max(0, Math.ceil((j.focusUntil - now.getTime()) / 60000)) : 0
  const error = j.status.voice === 'error' ? j.status.error : j.camera.erro
  const link = j.status.voice === 'live' ? 'ativa' : j.status.voice === 'connecting' ? 'conectando' : 'em espera'

  return (
    <main className={`hud phase-${fase}`}>
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
          <span className="link-state">Voz {link}</span>
          {focoMin > 0 && (
            <button className="foco-badge" onClick={() => j.ask('Encerre o modo foco.')} title="Avisos não urgentes esperam o fim do foco. Toque para encerrar.">
              <Timer size={12} /> Foco · {focoMin} min
            </button>
          )}
          {isApp && (
            <button className="hud-link" onClick={() => app.minimize()} aria-label="Ficar no canto" title="Ficar no canto (a esfera continua)">
              <Minus size={13} />
            </button>
          )}
          <a
            className="hud-link"
            href="/admin"
            onClick={(e) => {
              if (isApp) {
                e.preventDefault()
                app.openPanel()
              }
            }}
            aria-label="Abrir o painel"
            title="Painel"
          >
            <LayoutDashboard size={13} />
          </a>
          <time>{now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</time>
        </div>
      </header>

      <div className="hud-body">
        <aside className="hud-col left">{layout.left.map(renderPanel)}</aside>

        <section className="hud-center">
          <div className="hud-state" aria-live="polite">
            <span>{PHASE_LABEL[fase]}</span>
            <i />
            {j.step && fase !== 'falando' && (
              <small className="step" key={j.step}>
                {j.step}…
              </small>
            )}
            {j.step && (
              <button className="stop-btn" onClick={() => j.send({ type: 'parar' })} title="Para o que o Jarvis está fazendo no computador">
                <Square size={10} /> Parar
              </button>
            )}
            {stopToast && <small className="step stopped">Parado. Diga “continua” para seguir.</small>}
          </div>
          <div className="hud-stage">
            <button className="orb-wrap" onClick={() => (voiceOn ? j.stopVoice() : j.startVoice())} title={voiceOn ? 'Desligar a conversa' : 'Falar com o Jarvis'}>
              <Aura />
            </button>
          </div>
          <div className="hud-caption" aria-live="polite">
            {fase === 'pensando' || fase === 'ouvindo' ? j.userLine && <p className="you">{j.userLine}</p> : j.caption && <p key={j.caption}>{j.caption}</p>}
          </div>
        </section>

        <aside className="hud-col right">
          <Tasks tasks={j.tasks} />
          {layout.right.map(renderPanel)}
        </aside>

        {j.panel && <Deck j={j} data={data} view={j.panel} onView={j.setPanel} onClose={() => j.setPanel(null)} />}
      </div>

      <footer className="hud-bottom">
        <div className="bottom-l">
          <button className={`chip-btn ${j.panel ? 'on' : ''}`} onClick={() => j.setPanel(j.panel ? null : 'agenda')} aria-pressed={!!j.panel}>
            <LayoutGrid size={12} /> Painéis
          </button>
          {j.cards.length > 0 && (
            <button className="chip-btn" onClick={j.clearCards} title="Fecha os cartões da tela">
              <X size={12} /> Limpar cartões
            </button>
          )}
        </div>

        <button className={`mic ${voiceOn ? 'is-on' : ''}`} onClick={voiceOn ? j.stopVoice : j.startVoice} aria-label={voiceOn ? 'Desligar a conversa' : 'Falar com o Jarvis'} title="Espaço liga e desliga">
          {voiceOn ? <Mic size={20} /> : <MicOff size={20} />}
        </button>

        <div className="bottom-r">
          <IconToggle on={j.camera.ligada} onClick={toggleCamera} label={j.camera.ligada ? 'Câmera ligada: mãos e visão (desligar)' : 'Ligar a câmera (mãos e visão)'} icon={j.camera.ligada ? Camera : CameraOff} />
          <IconToggle on={barge} onClick={toggleBarge} label="Interromper falando (use com fone)" icon={Headphones} />
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
          <span className="cloud">{j.status.model ?? 'gemini'}</span>
        </div>
      </footer>

      {j.suggestions.length > 0 && (
        <div className="suggestions" aria-live="polite">
          {j.suggestions.map((s) => (
            <div className="suggestion" key={s.id}>
              <Lightbulb size={14} />
              <span>{s.texto}</span>
              <button
                className="chip-btn primary"
                onClick={() => {
                  j.dismissSuggestion(s.id)
                  j.ask(`[Sugestão aceita] ${s.pedido}`)
                }}
              >
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

      {error && !j.caption && (
        <p className="hud-note" role="alert">
          {error}
        </p>
      )}

      {intro && (
        <div className="boot-intro" aria-live="polite">
          <div className="bi-rings" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <b>{intro}</b>
          <small>Todos os sistemas operacionais</small>
        </div>
      )}

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
  const toggle = (id: PanelId) => onChange({ ...layout, hidden: layout.hidden.includes(id) ? layout.hidden.filter((x) => x !== id) : [...layout.hidden, id] })
  return (
    <aside className="drawer hud-drawer" role="dialog" aria-label="Gerenciar HUD">
      <header>
        <h2>Gerenciar HUD</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Fechar">
          <X size={15} />
        </button>
      </header>
      <p className="muted small">Mostre ou esconda painéis, mude a ordem e troque de lado. Fica salvo neste computador.</p>
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
