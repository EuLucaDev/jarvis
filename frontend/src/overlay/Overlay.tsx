// Camada transparente por cima da tela (uma por monitor), aberta pelo app Jarvis instalado.
//
// - HUD minimizado: a esfera fica pequena no canto do monitor principal, com o espectro da voz. Clicar volta o HUD.
// - Quando o Jarvis olha ou mexe em algo ("olhar"), a esfera sai de onde está e VOA até lá numa curva com
//   aceleração e freada suaves, destaca a área (cantos + varredura) e mostra a etiqueta ("Estou vendo, Senhor").
//   Ao terminar, volta para casa do mesmo jeito. Nunca pula de um ponto a outro.
//
// Coordenadas: o servidor manda pontos globais (topo à esquerda do monitor principal), iguais aos do Electron.
// Cada camada sabe a área do seu monitor pela URL e só desenha o que cai nela.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Orb } from '../hud/Orb'
import type { Live, Phase } from '../hud/useJarvis'
import { JarvisSocket } from '../lib/socket'
import './overlay.css'

type Rect = { x: number; y: number; w: number; h: number }
type Look = Rect & { label: string; modo: string }
type AppBridge = {
  setIgnore: (ignore: boolean) => void
  showHud: () => void
  onHud: (cb: (s: { visible: boolean; bounds: Rect | null }) => void) => void
}

const app = (window as unknown as { jarvisApp?: AppBridge }).jarvisApp
const MINI = 112 // tamanho da esfera no canto
const FLY = 150 // tamanho da esfera voando/olhando

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

export function Overlay() {
  const q = useMemo(() => new URLSearchParams(location.search), [])
  const area: Rect = { x: Number(q.get('x') || 0), y: Number(q.get('y') || 0), w: Number(q.get('w') || innerWidth), h: Number(q.get('h') || innerHeight) }
  const principal = q.get('main') === '1'

  const live = useRef<Live>({ phase: 'espera', level: 0, lastUser: 0, lastModel: 0, tool: false, turnDone: true })
  const [phase, setPhase] = useState<Phase>('espera')
  // modo: visivel (HUD na tela) · minimizado (esfera no canto) · oculto (só o ícone na barra de menus)
  const [hud, setHud] = useState<{ visible: boolean; mini: boolean; bounds: Rect | null }>({ visible: true, mini: false, bounds: null })
  const [look, setLook] = useState<Look | null>(null) // área destacada (em coordenadas locais)
  const [label, setLabel] = useState('')
  const [shown, setShown] = useState(false)
  const orbEl = useRef<HTMLDivElement>(null)
  const pos = useRef({ x: 0, y: 0, s: MINI, o: 0 }) // centro, tamanho e opacidade atuais (locais)
  const anim = useRef(0)
  const idle = useRef(0)
  // os timeouts chamam funções antigas: o estado que elas leem fica em refs
  const hudRef = useRef(hud)
  hudRef.current = hud

  const home = () => ({ x: area.w - MINI / 2 - 28, y: area.h - MINI / 2 - 90 }) // canto inferior direito, acima do Dock
  const hudCenter = () => {
    const b = hudRef.current.bounds
    return b ? { x: b.x - area.x + b.w / 2, y: b.y - area.y + b.h / 2 } : { x: area.w / 2, y: area.h / 2 }
  }

  const paint = () => {
    if (![pos.current.x, pos.current.y, pos.current.s, pos.current.o].every(Number.isFinite)) pos.current = { ...home(), s: MINI, o: 1 } // nunca some por conta inválida
    const p = pos.current
    const el = orbEl.current
    if (!el) return
    el.style.transform = `translate(${p.x - p.s / 2}px, ${p.y - p.s / 2}px)`
    el.style.width = el.style.height = `${p.s}px`
    el.style.opacity = String(p.o)
  }

  /** Voo em curva: sai, faz um arco (ponto de controle deslocado para o lado) e freia ao chegar. */
  const fly = (to: { x: number; y: number }, size: number, opacity: number, then?: () => void) => {
    cancelAnimationFrame(anim.current)
    const from = { ...pos.current }
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dist = Math.hypot(dx, dy)
    const dur = Math.min(1500, Math.max(650, dist * 0.9))
    // arco: ponto de controle perpendicular ao trajeto, 18% da distância
    const cx = (from.x + to.x) / 2 - dy * 0.18
    const cy = (from.y + to.y) / 2 + dx * 0.18
    const t0 = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / dur)
      const e = easeInOut(t)
      const u = 1 - e
      pos.current = {
        x: u * u * from.x + 2 * u * e * cx + e * e * to.x,
        y: u * u * from.y + 2 * u * e * cy + e * e * to.y,
        // encolhe um pouco no meio do voo, como quem acelera
        s: from.s + (size - from.s) * e - Math.sin(e * Math.PI) * 18,
        o: from.o + (opacity - from.o) * Math.min(1, e * 1.6),
      }
      paint()
      if (t < 1) anim.current = requestAnimationFrame(step)
      else then?.()
    }
    anim.current = requestAnimationFrame(step)
  }

  const goHome = () => {
    setLook(null)
    setLabel('')
    if (principal && hudRef.current.mini) {
      setShown(true)
      fly(home(), MINI, 1)
    } else if (principal) {
      // volta para dentro do HUD e some
      fly(hudCenter(), MINI, 0, () => setShown(false))
    } else {
      fly({ x: pos.current.x, y: pos.current.y }, MINI * 0.6, 0, () => setShown(false))
    }
  }

  // estado do HUD (minimizado ou não) vem do app
  useEffect(() => {
    // o Electron manda {x, y, width, height}; aqui o resto usa {x, y, w, h}
    app?.onHud((s: any) => {
      const b = s.bounds
      setHud({ visible: !!s.visible, mini: s.modo === 'minimizado', bounds: b ? { x: b.x, y: b.y, w: b.w ?? b.width, h: b.h ?? b.height } : null })
    })
  }, [])

  // esfera mini aparece/some com o HUD
  useEffect(() => {
    if (!principal || look) return
    if (hud.mini) {
      if (!shown) {
        // nasce de dentro do HUD (ou do centro) e vai para o canto
        pos.current = { ...hudCenter(), s: MINI * 1.4, o: 0 }
        paint()
        setShown(true)
      }
      fly(home(), MINI, 1)
    } else if (shown) {
      fly(hudCenter(), MINI * 1.6, 0, () => setShown(false))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hud.mini, principal])

  // voz: nível e fase chegam do HUD pelo canal do navegador (mesma origem)
  useEffect(() => {
    const ch = new BroadcastChannel('jarvis-live')
    ch.onmessage = (e) => {
      live.current.level = e.data.level
      if (e.data.phase !== live.current.phase) {
        live.current.phase = e.data.phase
        setPhase(e.data.phase)
      }
    }
    return () => ch.close()
  }, [])

  // janela que a mão mira ou segura (borda azul, como os cartões do HUD)
  const [win, setWin] = useState<(Rect & { estado: string; app: string; titulo: string; escala?: number }) | null>(null)
  const winTimer = useRef(0)

  // eventos do servidor: olhar, trocar etiqueta, terminar, janela realçada
  const onLook = useRef<(e: any) => void>(() => {})
  onLook.current = (e: any) => {
    if (e.type === 'janela.realce') {
      clearTimeout(winTimer.current)
      const j = e.janela
      const mine = j && j.x + j.w / 2 >= area.x && j.x + j.w / 2 < area.x + area.w && j.y + j.h / 2 >= area.y && j.y + j.h / 2 < area.y + area.h
      if (!j || !mine) {
        setWin(null)
        return
      }
      setWin({ x: j.x - area.x, y: j.y - area.y, w: j.w, h: j.h, estado: e.estado, app: j.app, titulo: j.titulo, escala: e.escala })
      // mira some sozinha se a mão sair; soltar e cancelar mostram um instante e somem
      winTimer.current = window.setTimeout(() => setWin(null), e.estado === 'mira' ? 900 : e.estado === 'solta' || e.estado === 'cancelou' ? 700 : 4000)
      return
    }
    if (e.type === 'olhar') {
      const cxg = e.x + (e.w || 0) / 2
      const cyg = e.y + (e.h || 0) / 2
      const mine = cxg >= area.x && cxg < area.x + area.w && cyg >= area.y && cyg < area.y + area.h
      clearTimeout(idle.current)
      idle.current = window.setTimeout(goHome, 7000)
      if (!mine) {
        // a esfera está aqui e o alvo é em outro monitor: sai pela borda na direção dele
        if (shown) {
          const ex = cxg < area.x ? -FLY : cxg >= area.x + area.w ? area.w + FLY : pos.current.x
          const ey = cyg < area.y ? -FLY : cyg >= area.y + area.h ? area.h + FLY : pos.current.y
          setLook(null)
          fly({ x: ex, y: ey }, FLY, 0, () => setShown(false))
        }
        return
      }
      const local: Look = { x: e.x - area.x, y: e.y - area.y, w: e.w || 0, h: e.h || 0, label: e.label || '', modo: e.modo || 'agir' }
      // ponto de chegada: ao lado da área (sem tapar o que ele vai mexer), dentro da tela
      const right = local.x + local.w + FLY * 0.7
      const tx = right + FLY / 2 < area.w ? right : Math.max(FLY / 2, local.x - FLY * 0.7)
      const ty = Math.min(area.h - FLY / 2, Math.max(FLY / 2, local.y + Math.min(local.h, 260) / 2))
      if (!shown) {
        // entra: do HUD (se estiver neste monitor) ou da borda mais próxima de onde ele estava
        const start = principal ? (hud.mini ? home() : hud.visible ? hudCenter() : { x: area.w / 2, y: -FLY }) : { x: e.x < area.x + area.w / 2 ? -FLY : area.w + FLY, y: ty }
        pos.current = { ...start, s: MINI, o: 0 }
        paint()
        setShown(true)
      }
      setLook(null)
      setLabel('')
      fly({ x: tx, y: ty }, FLY, 1, () => {
        setLook(local)
        setLabel(local.label || (local.modo === 'olhar' ? 'Estou vendo' : ''))
      })
    } else if (e.type === 'olhar.rotulo') {
      setLabel(e.label)
      clearTimeout(idle.current)
      idle.current = window.setTimeout(goHome, 7000)
    } else if (e.type === 'olhar.fim') {
      clearTimeout(idle.current)
      idle.current = window.setTimeout(goHome, 900)
    }
  }
  useEffect(() => {
    const s = new JarvisSocket('overlay', { onEvent: (e) => onLook.current(e), onAudio: () => {}, onOpen: () => {} })
    return () => s.close()
  }, [])

  // a camada deixa o clique passar, menos em cima da esfera mini (clicar traz o HUD de volta)
  useEffect(() => {
    let over = false
    const onMove = (ev: MouseEvent) => {
      const p = pos.current
      const inside = shown && !look && hud.mini && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < p.s / 2
      if (inside !== over) {
        over = inside
        app?.setIgnore(!inside)
        orbEl.current?.classList.toggle('hover', inside)
      }
    }
    addEventListener('mousemove', onMove)
    return () => removeEventListener('mousemove', onMove)
  }, [shown, look, hud.mini])

  return (
    <main className={`overlay phase-${phase}`}>
      {win && (
        <div className={`ov-win st-${win.estado}`} style={{ left: win.x, top: win.y, width: win.w, height: win.h }}>
          <i className="c tl" />
          <i className="c tr" />
          <i className="c bl" />
          <i className="c br" />
          <span className="ov-win-tag">
            {win.estado === 'ajuste' && win.escala ? `${Number(win.escala).toFixed(1).replace('.', ',')}× · ` : ''}
            {win.app}
            {win.titulo ? ` · ${win.titulo.slice(0, 48)}` : ''}
          </span>
        </div>
      )}
      {principal && <DeskHands />}
      {look && (
        <div className={`ov-area modo-${look.modo}`} style={{ left: look.x, top: look.y, width: Math.max(look.w, 40), height: Math.max(look.h, 30) }}>
          <i className="c tl" />
          <i className="c tr" />
          <i className="c bl" />
          <i className="c br" />
          <span className="scan" />
        </div>
      )}
      <div ref={orbEl} className={`ov-orb ${shown ? '' : 'gone'} ${hud.mini && !look ? 'mini' : ''}`} onClick={() => app?.showHud()} role="button" aria-label="Mostrar o Jarvis">
        <Orb live={live} phase={phase} />
        {!look && hud.mini && <Bars live={live} />}
        {label && (
          <span className="ov-label">
            <b>Jarvis</b> {label}
          </span>
        )}
      </div>
    </main>
  )
}

/** Espectro pequeno embaixo da esfera mini. */
function Bars({ live }: { live: React.MutableRefObject<Live> }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const el = ref.current
      if (el) {
        const lvl = Number.isFinite(live.current.level) ? live.current.level : 0
        Array.from(el.children).forEach((b, i) => {
          const wob = 0.35 + 0.65 * Math.abs(Math.sin(performance.now() / (140 + i * 37) + i))
          ;(b as HTMLElement).style.transform = `scaleY(${0.15 + lvl * 1.8 * wob})`
        })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [live])
  return (
    <div className="ov-bars" ref={ref} aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  )
}

/** Cursor da mão por cima de tudo (modo janelas): vem do HUD pelo canal do navegador, com o anel de segurar. */
function DeskHands() {
  const [st, setSt] = useState<{ hands: { x: number; y: number; pinch: boolean }[]; ring: { x: number; y: number; p: number; kind: string } | null; tip: string }>({ hands: [], ring: null, tip: '' })
  useEffect(() => {
    const ch = new BroadcastChannel('jarvis-hand')
    ch.onmessage = (e) => setSt(e.data)
    return () => ch.close()
  }, [])
  return (
    <>
      {st.ring && (
        <div className={`ov-ring ${st.ring.kind}`} style={{ transform: `translate(${st.ring.x * innerWidth}px, ${st.ring.y * innerHeight}px)`, ['--p' as string]: st.ring.p }}>
          <span>{st.ring.kind === 'armar' ? 'Ajustar' : 'Fixar'}</span>
        </div>
      )}
      {st.hands.map((h, i) => (
        <div key={i} className={`ov-hand ${h.pinch ? 'pinch' : ''}`} style={{ transform: `translate(${h.x * innerWidth}px, ${h.y * innerHeight}px)` }}>
          {i === 0 && st.tip && <span>{st.tip}</span>}
        </div>
      ))}
    </>
  )
}
