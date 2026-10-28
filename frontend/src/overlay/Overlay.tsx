// Camada transparente por cima da tela (uma por monitor), sempre aberta pelo app Jarvis.
//
// No monitor principal:
// - Cartões do Jarvis flutuando na área de trabalho: arrasta, ajusta e fecha com a mão ou o mouse.
// - HUD minimizado: a esfera fica no canto com o espectro e, com a câmera ligada, um quadradinho com o
//   mapeamento da mão ao vivo. Clicar na esfera traz o HUD de volta.
// - Cursor da mão, anel de segurar e borda azul na janela que a mão mira ou segura.
// Em todos os monitores:
// - Quando o Jarvis olha ou mexe em algo, a esfera VOA até lá numa curva com aceleração e freada suaves,
//   destaca a área e mostra a etiqueta ("Estou vendo, Senhor"). Nunca pula de um ponto a outro.
//
// O clique só é capturado em cima dos elementos com data-hit (cartões, esfera); o resto passa para os apps.

import { Brain, Camera, CameraOff, Inbox, Wallet, Maximize2, Mic, MicOff, MonitorOff, MonitorUp, Pin, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { app, type HudState } from '../lib/app'
import { useHands, voiceStore, type Hand } from '../lib/live'
import { play } from '../lib/sfx'
import { CardView, cardText } from '../hud/Cards'
import { useJarvis } from '../hud/useJarvis'
import { Aura } from '../ui/Aura'
import { CameraView } from '../ui/CameraView'
import { useHandControl } from './handControl'
import './overlay.css'

type Rect = { x: number; y: number; w: number; h: number }
type Look = Rect & { label: string; modo: string }
type Pos = { x: number; y: number; z: number; fixo?: boolean }

const MINI = 104
const FLY = 150
const CARD_W = 420
const GUARDAR_MS = 10_000 // tempo na tela antes de ir para a caixa
const HOLD = (() => {
  try {
    return Number(localStorage.getItem('jarvis.holdMs')) || 1500
  } catch {
    return 1500
  }
})()

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

export function Overlay() {
  const q = useMemo(() => new URLSearchParams(location.search), [])
  const area: Rect = { x: Number(q.get('x') || 0), y: Number(q.get('y') || 0), w: Number(q.get('w') || innerWidth), h: Number(q.get('h') || innerHeight) }
  const principal = q.get('main') !== '0'

  const j = useJarvis('overlay')
  const [hud, setHud] = useState<HudState>({ modo: 'visivel', focused: true, bounds: null })
  const mini = principal && hud.modo === 'minimizado'

  useEffect(() => app.onHud(setHud), [])

  // ---------- cartões na área de trabalho ----------
  const [pos, setPos] = useState<Record<string, Pos>>({})
  const dragBase = useRef<Record<string, Pos>>({})
  const todos = principal ? j.cards.filter((c) => c.kind !== 'carregando') : []

  // cartão fica ~10 s na tela e vai sozinho para a caixa (canto de cima); fixado ou com a mão/mouse em cima, fica
  const [guardados, setGuardados] = useState<Set<string>>(new Set())
  const [caixaAberta, setCaixaAberta] = useState(false)
  const toque = useRef<Record<string, number>>({}) // última vez que apareceu, foi tocado ou arrastado
  const [mouseEm, setMouseEm] = useState<string | null>(null)
  const tocar = (id: string) => (toque.current[id] = Date.now())
  const visiveis = todos.filter((c) => !guardados.has(c.id)).slice(-5)
  const naCaixa = todos.filter((c) => guardados.has(c.id))
  // cartão novo entra na coluna da direita, empilhado
  useEffect(() => {
    setPos((p) => {
      const n = { ...p }
      let i = 0
      for (const c of visiveis) {
        if (!n[c.id]) n[c.id] = { x: area.w - CARD_W - 28, y: 70 + (i % 3) * 36, z: 1 }
        i++
      }
      return n
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiveis.map((c) => c.id).join()])

  useEffect(() => {
    const t = setInterval(() => {
      const agora = Date.now()
      const sair = visiveis.filter((c) => {
        toque.current[c.id] ??= agora
        return !pos[c.id]?.fixo && c.id !== mouseEm && c.id !== hcHover.current && agora - toque.current[c.id] > GUARDAR_MS
      })
      if (sair.length) {
        setGuardados((g) => new Set([...g, ...sair.map((c) => c.id)]))
        play('close', 0.8)
      }
    }, 1000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiveis.map((c) => c.id).join(), pos, mouseEm])
  // cartão fechado ou limpo sai também da caixa
  useEffect(() => {
    setGuardados((g) => new Set([...g].filter((id) => todos.some((c) => c.id === id))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todos.map((c) => c.id).join()])
  const tirarDaCaixa = (id: string) => {
    tocar(id)
    setGuardados((g) => new Set([...g].filter((x) => x !== id)))
  }

  const moveCard = useCallback((id: string, dx: number, dy: number, done: boolean) => {
    tocar(id)
    setPos((p) => {
      const base = dragBase.current[id] ?? p[id]
      if (!dragBase.current[id]) dragBase.current[id] = base
      const next = { ...base, x: Math.min(area.w - 120, Math.max(-200, base.x + dx)), y: Math.min(area.h - 80, Math.max(0, base.y + dy)) }
      if (done) delete dragBase.current[id]
      return { ...p, [id]: next }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const scaleBase = useRef<Record<string, number>>({})
  const scaleCard = useCallback((id: string, z: number | null) => {
    setPos((p) => {
      if (scaleBase.current[id] === undefined) scaleBase.current[id] = p[id]?.z ?? 1
      const nz = z ?? scaleBase.current[id]
      if (z === null) delete scaleBase.current[id]
      return { ...p, [id]: { ...p[id], z: Math.min(1.8, Math.max(0.5, nz)) } }
    })
  }, [])

  // mouse: arrastar pelo cartão, ajustar pela alça do canto
  const mouseDrag = useRef<{ id: string; sx: number; sy: number; kind: 'mover' | 'tamanho'; z0: number } | null>(null)
  const onPointerDown = (id: string, kind: 'mover' | 'tamanho') => (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a') && kind === 'mover') return
    e.currentTarget.setPointerCapture(e.pointerId)
    mouseDrag.current = { id, sx: e.clientX, sy: e.clientY, kind, z0: pos[id]?.z ?? 1 }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = mouseDrag.current
    if (!d) return
    if (d.kind === 'mover') moveCard(d.id, e.clientX - d.sx, e.clientY - d.sy, false)
    else setPos((p) => ({ ...p, [d.id]: { ...p[d.id], z: Math.min(1.8, Math.max(0.5, d.z0 + (e.clientX - d.sx) / CARD_W)) } }))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = mouseDrag.current
    mouseDrag.current = null
    if (d?.kind === 'mover') moveCard(d.id, e.clientX - d.sx, e.clientY - d.sy, true)
  }

  // ---------- mãos ----------
  const cardAt = useCallback((x: number, y: number) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    return (el?.closest('[data-card]') as HTMLElement | null)?.dataset.card ?? null
  }, [])
  const clickAt = useCallback((x: number, y: number) => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('button, a, [role="button"]') as HTMLElement | null
    if (!el) return false
    el.click()
    return true
  }, [])
  // várias telas: cada camada cuida da mão que está no monitor dela (posição global gx/gy vinda do núcleo)
  const paraLocal = useCallback(
    (h: Hand): Hand => {
      if (h.gx == null || h.gy == null) return h // núcleo antigo: só o monitor principal
      return {
        ...h,
        x: (h.gx - area.x) / area.w,
        y: (h.gy - area.y) / area.h,
        ax: h.gax != null ? (h.gax - area.x) / area.w : h.ax,
        ay: h.gay != null ? (h.gay - area.y) / area.h : h.ay,
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [area.x, area.y, area.w, area.h],
  )
  const hcHover = useRef<string | null>(null)
  const minha = useCallback(
    (h: Hand) => {
      if (h.gx == null) return principal
      const l = paraLocal(h)
      return l.x >= 0 && l.x < 1 && l.y >= 0 && l.y < 1
    },
    [paraLocal, principal],
  )
  // o que sai daqui com x/y (clique, janelas) leva também o ponto global, para valer em qualquer monitor
  const sendGlobal = useCallback(
    (msg: object) => {
      const m = msg as Record<string, unknown>
      j.send(typeof m.x === 'number' && typeof m.y === 'number' ? { ...m, gx: area.x + m.x * area.w, gy: area.y + m.y * area.h } : m)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [j.send, area.x, area.y, area.w, area.h],
  )
  const hc = useHandControl(
    {
      send: sendGlobal,
      hold: HOLD,
      cardAt,
      cardScale: (id) => pos[id]?.z ?? 1,
      moveCard,
      scaleCard,
      clickAt,
      local: (hs, ocupada) => (ocupada ? hs.map(paraLocal) : hs.filter(minha).map(paraLocal)),
    },
    j.camera.ligada,
  )

  hcHover.current = hc.hoverCard
  useEffect(() => {
    if (hc.hoverCard) tocar(hc.hoverCard) // mão em cima: o tempo recomeça
  }, [hc.hoverCard])

  // "isso aqui": o cartão apontado pela mão vai para o núcleo
  useEffect(() => {
    const c = hc.hoverCard ? j.cards.find((x) => x.id === hc.hoverCard) : null
    j.send({ type: 'apontado', alvo: c ? { tipo: 'cartão do Jarvis', categoria: c.kind, titulo: c.data.titulo ?? c.data.cidade ?? '', conteudo: cardText(c).slice(0, 2000) } : null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hc.hoverCard])

  // gestos de atalho (poses paradas e deslizes): o núcleo já fez a ação escolhida no painel; aqui só o aviso
  const [gesto, setGesto] = useState<string | null>(null)
  useEffect(() => {
    const e = j.last
    if (!principal || !e || e.type !== 'gesto') return
    setGesto(e.rotulo)
    play('step', 0.6)
    const t = setTimeout(() => setGesto(null), 1800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [j.last])

  // ---------- controles rápidos na esfera do canto (aparecem ao passar o mouse) ----------
  const [rapido, setRapido] = useState(false)
  const rapidoT = useRef(0)
  const abrirRapido = () => {
    clearTimeout(rapidoT.current)
    setRapido(true)
  }
  const fecharRapido = () => {
    clearTimeout(rapidoT.current)
    rapidoT.current = window.setTimeout(() => setRapido(false), 700)
  }
  const voz = j.status.voice === 'live'

  // ---------- janela realçada (borda azul) ----------
  const [win, setWin] = useState<(Rect & { estado: string; app: string; titulo: string; escala?: number }) | null>(null)
  const winTimer = useRef(0)
  useEffect(() => {
    const e = j.last
    if (!e || e.type !== 'janela.realce') return
    clearTimeout(winTimer.current)
    const w = e.janela
    const cx = w ? w.x + w.w / 2 : 0
    const cy = w ? w.y + w.h / 2 : 0
    if (!w || cx < area.x || cx >= area.x + area.w || cy < area.y || cy >= area.y + area.h) {
      setWin(null)
      return
    }
    setWin({ x: w.x - area.x, y: w.y - area.y, w: w.w, h: w.h, estado: e.estado ?? 'mira', app: w.app, titulo: w.titulo, escala: e.escala })
    winTimer.current = window.setTimeout(() => setWin(null), e.estado === 'mira' ? 900 : e.estado === 'solta' || e.estado === 'cancelou' ? 700 : 4000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [j.last])

  // ---------- esfera que voa (olhar / agir) e esfera do canto ----------
  const orbEl = useRef<HTMLDivElement>(null)
  const orb = useRef({ x: 0, y: 0, s: MINI, o: 0 })
  const anim = useRef(0)
  const idle = useRef(0)
  const [look, setLook] = useState<Look | null>(null)
  const [label, setLabel] = useState('')
  const [voando, setVoando] = useState(false)
  const hudRef = useRef(hud)
  hudRef.current = hud

  const home = () => ({ x: area.w - MINI / 2 - 28, y: area.h - MINI / 2 - 96 })
  const hudCenter = () => {
    const b = hudRef.current.bounds
    return b ? { x: b.x - area.x + b.w / 2, y: b.y - area.y + b.h / 2 } : { x: area.w / 2, y: area.h / 2 }
  }
  const paint = () => {
    const p = orb.current
    if (![p.x, p.y, p.s, p.o].every(Number.isFinite)) orb.current = { ...home(), s: MINI, o: 1 }
    const el = orbEl.current
    if (!el) return
    el.style.transform = `translate(${orb.current.x - orb.current.s / 2}px, ${orb.current.y - orb.current.s / 2}px)`
    el.style.width = el.style.height = `${orb.current.s}px`
    el.style.opacity = String(orb.current.o)
  }
  /** Voo em curva: arco (ponto de controle de lado), acelera e freia ao chegar. */
  const fly = (to: { x: number; y: number }, size: number, opacity: number, then?: () => void) => {
    cancelAnimationFrame(anim.current)
    const from = { ...orb.current }
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dur = Math.min(1500, Math.max(650, Math.hypot(dx, dy) * 0.9))
    const cx = (from.x + to.x) / 2 - dy * 0.18
    const cy = (from.y + to.y) / 2 + dx * 0.18
    const t0 = performance.now()
    const stepFly = (now: number) => {
      const t = Math.min(1, (now - t0) / dur)
      const e = easeInOut(t)
      const u = 1 - e
      orb.current = {
        x: u * u * from.x + 2 * u * e * cx + e * e * to.x,
        y: u * u * from.y + 2 * u * e * cy + e * e * to.y,
        s: from.s + (size - from.s) * e - Math.sin(e * Math.PI) * 18,
        o: from.o + (opacity - from.o) * Math.min(1, e * 1.6),
      }
      paint()
      if (t < 1) anim.current = requestAnimationFrame(stepFly)
      else then?.()
    }
    anim.current = requestAnimationFrame(stepFly)
  }
  const goHome = () => {
    setLook(null)
    setLabel('')
    if (principal && hudRef.current.modo === 'minimizado') fly(home(), MINI, 1, () => setVoando(false))
    else if (principal && hudRef.current.modo === 'visivel') fly(hudCenter(), MINI, 0, () => setVoando(false))
    else fly({ ...orb.current }, MINI * 0.6, 0, () => setVoando(false))
  }

  // esfera do canto aparece e some com o HUD
  useEffect(() => {
    if (!principal || look) return
    if (mini) {
      if (orb.current.o < 0.05) {
        orb.current = { ...hudCenter(), s: MINI * 1.4, o: 0 }
        paint()
      }
      fly(home(), MINI, 1)
    } else if (orb.current.o > 0.05) {
      fly(hud.modo === 'visivel' ? hudCenter() : home(), MINI * 1.3, 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mini, hud.modo])

  useEffect(() => {
    const e = j.last
    if (!e) return
    if (e.type === 'olhar') {
      const cxg = e.x + (e.w || 0) / 2
      const cyg = e.y + (e.h || 0) / 2
      const meu = cxg >= area.x && cxg < area.x + area.w && cyg >= area.y && cyg < area.y + area.h
      clearTimeout(idle.current)
      idle.current = window.setTimeout(goHome, 7000)
      if (!meu) {
        if (orb.current.o > 0.05) {
          // o alvo é em outro monitor: sai pela borda na direção dele
          const ex = cxg < area.x ? -FLY : cxg >= area.x + area.w ? area.w + FLY : orb.current.x
          const ey = cyg < area.y ? -FLY : cyg >= area.y + area.h ? area.h + FLY : orb.current.y
          setLook(null)
          fly({ x: ex, y: ey }, FLY, 0)
        }
        return
      }
      const local: Look = { x: e.x - area.x, y: e.y - area.y, w: e.w || 0, h: e.h || 0, label: e.label || '', modo: e.modo || 'agir' }
      const dir = local.x + local.w + FLY * 0.7
      const tx = dir + FLY / 2 < area.w ? dir : Math.max(FLY / 2, local.x - FLY * 0.7)
      const ty = Math.min(area.h - FLY / 2, Math.max(FLY / 2, local.y + Math.min(local.h, 260) / 2))
      if (orb.current.o < 0.05) {
        // entra do HUD (se estiver na tela), do canto, ou da borda do monitor
        const start = principal ? (hud.modo === 'visivel' ? hudCenter() : home()) : { x: e.x < area.x + area.w / 2 ? -FLY : area.w + FLY, y: ty }
        orb.current = { ...start, s: MINI, o: 0 }
        paint()
      }
      setVoando(true)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [j.last])

  // ---------- onde o mouse "pega" (o resto da camada deixa o clique passar) ----------
  useEffect(() => {
    let last = ''
    const t = setInterval(() => {
      const rects = Array.from(document.querySelectorAll<HTMLElement>('[data-hit]')).map((el) => {
        const r = el.getBoundingClientRect()
        return { x: area.x + r.left, y: area.y + r.top, w: r.width, h: r.height }
      })
      const key = JSON.stringify(rects.map((r) => [r.x, r.y, r.w, r.h].map(Math.round)))
      if (key !== last) {
        last = key
        app.setHitRegions(rects)
      }
    }, 200)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handsOn = j.camera.ligada
  return (
    <main className="overlay" onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
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

      {look && (
        <div className={`ov-area modo-${look.modo}`} style={{ left: look.x, top: look.y, width: Math.max(look.w, 40), height: Math.max(look.h, 30) }}>
          <i className="c tl" />
          <i className="c tr" />
          <i className="c bl" />
          <i className="c br" />
          <span className="scan" />
        </div>
      )}

      {visiveis.map((c) => {
        const p = pos[c.id]
        if (!p) return null
        return (
          <div
            key={c.id}
            className={`dcard ${hc.hoverCard === c.id ? 'hover' : ''}`}
            data-card={c.id}
            data-hit
            style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
            onPointerDown={(e) => {
              tocar(c.id)
              onPointerDown(c.id, 'mover')(e)
            }}
            onPointerEnter={() => setMouseEm(c.id)}
            onPointerLeave={() => {
              tocar(c.id)
              setMouseEm((m) => (m === c.id ? null : m))
            }}
          >
            {/* zoom (e não scale) muda o tamanho redesenhando o texto: o cartão fica nítido em qualquer tamanho */}
            <div className="dcard-body" style={{ width: CARD_W, zoom: p.z }}>
            <div className="dcard-bar">
              <span>{c.at}</span>
              <button onClick={() => setPos((x) => ({ ...x, [c.id]: { ...x[c.id], fixo: !x[c.id].fixo } }))} aria-label="Fixar" className={p.fixo ? 'on' : ''}>
                <Pin size={12} />
              </button>
              <button
                onClick={() => {
                  play('close')
                  j.closeCard(c.id)
                }}
                aria-label="Fechar cartão"
              >
                <X size={13} />
              </button>
            </div>
            <CardView card={c} onPeriod={c.kind === 'mercado' ? (per) => j.send({ type: 'mercado.periodo', id: c.id, periodo: per }) : undefined} />
            <span className="dcard-grip" onPointerDown={onPointerDown(c.id, 'tamanho')} aria-hidden="true" />
            </div>
          </div>
        )
      })}

      {naCaixa.length > 0 && (
        <div className={`ov-caixa ${caixaAberta ? 'aberta' : ''}`} data-hit>
          <button className="ov-caixa-botao" onClick={() => setCaixaAberta((v) => !v)} aria-expanded={caixaAberta}>
            <Inbox size={14} /> {naCaixa.length} {naCaixa.length === 1 ? 'cartão guardado' : 'cartões guardados'}
          </button>
          {caixaAberta && (
            <ul>
              {[...naCaixa].reverse().map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => {
                      tirarDaCaixa(c.id)
                      setCaixaAberta(false)
                    }}
                  >
                    <b>{c.data.titulo ?? c.data.cidade ?? c.kind}</b>
                    <small>{c.at}</small>
                  </button>
                </li>
              ))}
              <li>
                <button className="limpar" onClick={() => (j.clearCards(), setCaixaAberta(false))}>
                  Fechar todos
                </button>
              </li>
            </ul>
          )}
        </div>
      )}

      <div
        ref={orbEl}
        className={`ov-orb ${mini && !look && !voando ? 'mini' : ''}`}
        data-hit={mini ? '' : undefined}
        onClick={() => app.showHud()}
        onPointerEnter={() => mini && abrirRapido()}
        onPointerLeave={fecharRapido}
        role="button"
        aria-label="Mostrar o Jarvis"
      >
        <Aura maxRes={300} gain={1.8} />
        {mini && !look && <Bars />}
        {label && (
          <span className="ov-label">
            <b>Jarvis</b> {label}
          </span>
        )}
      </div>

      {mini && rapido && !look && !voando && (
        <div className="ov-quick" data-hit onPointerEnter={abrirRapido} onPointerLeave={fecharRapido}>
          {[
            { on: voz, rotulo: voz ? 'Parar de ouvir' : 'Falar com o Jarvis', icon: voz ? Mic : MicOff, f: () => (voz ? j.stopVoice() : j.startVoice()) },
            { on: j.camera.ligada, rotulo: j.camera.ligada ? 'Desligar a câmera' : 'Ligar a câmera (mãos)', icon: j.camera.ligada ? Camera : CameraOff, f: () => api(`/api/camera/${j.camera.ligada ? 'desligar' : 'ligar'}`, { method: 'POST' }) },
            { on: j.tela.ligada, rotulo: j.tela.ligada ? 'Parar de espelhar a tela' : 'Espelhar a tela', icon: j.tela.ligada ? MonitorUp : MonitorOff, f: () => api(`/api/tela/${j.tela.ligada ? 'desligar' : 'ligar'}`, { method: 'POST' }) },
            { on: false, rotulo: 'Financeiro', icon: Wallet, f: () => app.openFinance() },
            { on: false, rotulo: 'Mapa da memória', icon: Brain, f: () => app.openMemory() },
            { on: false, rotulo: 'Abrir o HUD', icon: Maximize2, f: () => app.showHud() },
          ].map(({ on, rotulo, icon: Icon, f }) => (
            <button key={rotulo} className={on ? 'on' : ''} onClick={f} aria-label={rotulo} title={rotulo}>
              <Icon size={15} />
            </button>
          ))}
        </div>
      )}
      {mini && principal && handsOn && <HandPreview />}
      {handsOn && <HandCursors ring={hc.ring} tip={hc.tip} minha={minha} paraLocal={paraLocal} />}
      {gesto && <div className="ov-gesto">{gesto}</div>}
    </main>
  )
}

/** Espectro pequeno embaixo da esfera do canto. */
function Bars() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const el = ref.current
      if (el) {
        const lvl = voiceStore.get().nivel
        Array.from(el.children).forEach((b, i) => {
          const wob = 0.35 + 0.65 * Math.abs(Math.sin(performance.now() / (140 + i * 37) + i))
          ;(b as HTMLElement).style.transform = `scaleY(${0.15 + lvl * 1.8 * wob})`
        })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div className="ov-bars" ref={ref} aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  )
}

/** Quadradinho ao lado da esfera do canto: a câmera e o mapeamento da mão ao vivo. */
function HandPreview() {
  return (
    <div className="ov-preview" aria-hidden="true">
      <CameraView on />
    </div>
  )
}

/** Cursores das mãos por cima de tudo, com o anel de segurar e a dica do gesto. */
function HandCursors({
  ring,
  tip,
  minha,
  paraLocal,
}: {
  ring: { x: number; y: number; p: number; kind: string } | null
  tip: string
  minha: (h: Hand) => boolean
  paraLocal: (h: Hand) => Hand
}) {
  const hands = useHands().hands.filter(minha).map(paraLocal)
  return (
    <>
      {ring && (
        <div className={`ov-ring ${ring.kind}`} style={{ transform: `translate(${ring.x * innerWidth}px, ${ring.y * innerHeight}px)`, ['--p' as string]: ring.p }}>
          <span>{ring.kind === 'armar' ? 'Ajustar' : 'Fixar'}</span>
        </div>
      )}
      {hands.map((h, i) => (
        <div key={h.key} className={`ov-hand ${h.pinch ? 'pinch' : ''} ${i ? 'second' : ''}`} style={{ transform: `translate(${h.x * innerWidth}px, ${h.y * innerHeight}px)` }}>
          {i === 0 && tip && <span>{tip}</span>}
        </div>
      ))}
    </>
  )
}
