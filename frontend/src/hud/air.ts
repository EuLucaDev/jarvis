// Controle no ar: transforma os quadros da mão (lib/gestures) em ações.
//
// Pinça = polegar + indicador encostados.
//   pinça e solta rápido          → clica no que está embaixo
//   pinça e mexe                  → arrasta (cartão para as zonas, chip para cima, cartão fixo, lista rola)
//   pinça PARADA no cartão (anel) → entra no AJUSTE de tamanho
//     no ajuste, polegar e indicador em L: abrir aumenta, fechar diminui (o cartão segue a abertura)
//     parado de novo (anel)       → fixa o tamanho
//     mão aberta, soltar a mão ou tirar a mão da câmera → cancela e volta ao tamanho de antes
//   duas pinças PARADAS            → o mesmo ajuste, pela distância entre as mãos; soltar uma cancela
// No cartão de mercado, o ajuste troca o período do gráfico em vez do tamanho.
//
// Modo mouse: a mão vira o mouse do Mac (pinça clica, pinça e mexe arrasta, dois dedos rolam).
//
// O quadro da mão (e o anel de progresso) fica num store fora do React: cursor e prévia redesenham a
// cada quadro sem re-renderizar o HUD inteiro.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { gestureOptions, type Hand, type HandFrame } from '../lib/gestures'
import { play } from '../lib/sfx'
import type { Card } from '../lib/socket'

/* ---------- store do quadro atual ---------- */

export type Ring = { x: number; y: number; p: number; kind: 'armar' | 'fixar' }
type AirState = HandFrame & { ring: Ring | null }

let current: AirState = { hands: [], t: 0, ring: null }
const subs = new Set<() => void>()
export const airStore = {
  set(f: HandFrame, ring: Ring | null = null) {
    current = { ...f, ring }
    subs.forEach((s) => s())
  },
  get: () => current,
  subscribe(cb: () => void) {
    subs.add(cb)
    return () => {
      subs.delete(cb)
    }
  },
}
export const useHandFrame = () => useSyncExternalStore(airStore.subscribe, airStore.get)

/* ---------- preferências ---------- */

const HOLD_KEY = 'jarvis.holdMs'
export const HOLD_OPTIONS = [1000, 1500, 2000, 3000]
export function loadHold() {
  try {
    return Number(localStorage.getItem(HOLD_KEY)) || 2000
  } catch {
    return 2000
  }
}
export function saveHold(ms: number) {
  try {
    localStorage.setItem(HOLD_KEY, String(ms))
  } catch {
    /* só nesta aba */
  }
}

/* ---------- cartões fixos ---------- */

export type Pinned = { card: Card; x: number; y: number; scale?: number } // posição 0..1 da janela
const PIN_KEY = 'jarvis.pinned'

export function loadPinned(): Pinned[] {
  try {
    return JSON.parse(localStorage.getItem(PIN_KEY) || '[]')
  } catch {
    return []
  }
}
export function savePinned(p: Pinned[]) {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(p))
  } catch {
    /* só nesta aba */
  }
}

/* ---------- mercado: ajuste vira período ---------- */

export const PERIODS = ['1d', '5d', '1mo', '6mo', '1y'] as const
export const PERIOD_LABEL: Record<string, string> = { '1d': '1 dia', '5d': '5 dias', '1mo': '1 mês', '6mo': '6 meses', '1y': '1 ano' }
// escala 0,6 (fechado) mostra o ano; 2,2 (aberto) mostra o dia: abrir os dedos = aproximar
const periodForScale = (z: number) => PERIODS[Math.max(0, Math.min(4, Math.round(((2.2 - z) / 1.6) * 4)))]

/* ---------- interação ---------- */

export type Zone = 'fixar' | 'fechar' | 'guardar' | 'copiar' | null
const MIN_Z = 0.6
const MAX_Z = 2.2
// abertura em L: 0,25 (pinça) → menor; 1,25 (bem aberto) → maior
const scaleForSpread = (s: number) => MIN_Z + ((Math.min(1.25, Math.max(0.25, s)) - 0.25) / 1.0) * (MAX_Z - MIN_Z)

type Target = { kind: 'focus'; id: string } | { kind: 'pin'; id: string }

type Mode =
  | { m: 'idle' }
  | { m: 'press'; el: HTMLElement | null; x: number; y: number; t: number; target: Target | null; scroll: HTMLElement | null; chip: string | null; pin: string | null }
  | { m: 'drag-card'; x: number; y: number }
  | { m: 'drag-chip'; id: string; x: number; y: number }
  | { m: 'drag-pin'; id: string; x: number; y: number; ox: number; oy: number }
  | { m: 'scroll'; el: HTMLElement; y: number; x: number; top: number; left: number }
  | { m: 'resize'; target: Target; z0: number; z: number; started: boolean; still: number; two: boolean; d0: number; palmT: number }
  | { m: 'mouse-press'; x: number; y: number; t: number; down: boolean }

type Ctx = {
  board: boolean
  mouse: boolean
  hold: number
  focus: Card | null
  pinned: Pinned[]
  scales: Record<string, number>
  setScale: (id: string, z: number) => void
  setPinned: (p: Pinned[]) => void
  setFocusId: (id: string | null) => void
  closeCard: (id: string) => void
  setPeriod: (cardId: string, periodo: string) => void
  sendMouse: (m: object) => void
  desk: boolean // HUD fora de foco/minimizado: a mão mexe nas janelas do Mac
  sendWin: (m: object) => void
  copyCard: (card: Card) => void
  onPoint: (cardId: string | null) => void // o cartão que a mão está apontando ("isso aqui")
}

const CLICKABLE = 'button, a, [role="button"], [role="radio"], input, .chip'

// janelas: escala 0,5 (dedos fechados) a 1,6 (L bem aberto) do tamanho de quando foi pega
const winScaleForSpread = (s: number) => 0.5 + ((Math.min(1.25, Math.max(0.25, s)) - 0.25) / 1.0) * 1.1

type Desk =
  | { m: 'idle' }
  | { m: 'press'; x: number; y: number; t: number }
  | { m: 'drag'; edge: number; jogou: boolean }
  | { m: 'resize'; started: boolean; z: number; still: number; open: number }

const handCh = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('jarvis-hand') : null

function scrollableAncestor(el: Element | null): HTMLElement | null {
  for (let n = el as HTMLElement | null; n && n !== document.body; n = n.parentElement) {
    const st = getComputedStyle(n)
    if (/(auto|scroll)/.test(st.overflowY + st.overflowX) && (n.scrollHeight > n.clientHeight + 4 || n.scrollWidth > n.clientWidth + 4)) return n
  }
  return null
}

export function useAirControl(ctx: Ctx) {
  const c = useRef(ctx)
  c.current = ctx
  const mode = useRef<Mode>({ m: 'idle' })
  const hover = useRef<Element | null>(null)
  const pointed = useRef<string | null>(null)
  const openSince = useRef(0)
  const lastMouse = useRef(0)
  const scrollY = useRef<number | null>(null)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const [chipDrag, setChipDrag] = useState<{ id: string; x: number; y: number } | null>(null)
  const [zone, setZone] = useState<Zone>(null)
  const [live, setLive] = useState<{ id: string; z: number } | null>(null) // tamanho durante o ajuste
  const [periodPreview, setPeriodPreview] = useState<string | null>(null)
  const [status, setStatus] = useState('')

  // no modo mouse, deslizes desligados (mexer a mão rápido é mover o mouse); o punho continua valendo para sair
  useEffect(() => {
    gestureOptions.poses = true
    gestureOptions.swipes = !ctx.mouse
  }, [ctx.mouse])

  const setHover = (el: Element | null) => {
    if (hover.current === el) return
    hover.current?.classList.remove('air-hover')
    el?.classList.add('air-hover')
    hover.current = el
  }

  const reset = (msg = '') => {
    mode.current = { m: 'idle' }
    gestureOptions.poses = true
    gestureOptions.swipes = !c.current.mouse
    setDrag(null)
    setChipDrag(null)
    setZone(null)
    setLive(null)
    setPeriodPreview(null)
    setStatus(msg)
    if (msg) setTimeout(() => setStatus((s) => (s === msg ? '' : s)), 1600)
  }

  const scaleOf = (t: Target) => (t.kind === 'focus' ? (c.current.scales[t.id] ?? 1) : (c.current.pinned.find((p) => p.card.id === t.id)?.scale ?? 1))
  const cardOf = (t: Target) => (t.kind === 'focus' ? c.current.focus : (c.current.pinned.find((p) => p.card.id === t.id)?.card ?? null))

  const commitResize = (r: Extract<Mode, { m: 'resize' }>) => {
    const k = c.current
    const card = cardOf(r.target)
    if (card?.kind === 'mercado') {
      const p = periodForScale(r.z)
      if (p !== (card.data.periodo ?? '1mo')) k.setPeriod(card.id, p)
      reset(`Período fixado · ${PERIOD_LABEL[p]}`)
    } else {
      if (r.target.kind === 'focus') k.setScale(r.target.id, r.z)
      else k.setPinned(k.pinned.map((p) => (p.card.id === r.target.id ? { ...p, scale: r.z } : p)))
      reset(`Tamanho fixado · ${r.z.toFixed(1).replace('.', ',')}×`)
    }
    play('ack')
  }

  const enterResize = (target: Target, two: boolean, d0: number, now: number) => {
    const z0 = scaleOf(target)
    mode.current = { m: 'resize', target, z0, z: z0, started: false, still: now, two, d0, palmT: 0 }
    gestureOptions.poses = gestureOptions.swipes = false
    setLive({ id: target.id, z: z0 })
    setStatus(two ? 'Ajuste · afaste ou aproxime as mãos' : 'Ajuste · abra ou feche polegar e indicador')
    play('start')
  }

  // ---------- mãos nas janelas do Mac ----------
  const desk = useRef<Desk>({ m: 'idle' })
  const deskAim = useRef({ t: 0, x: -1, y: -1 })
  const deskSend = useRef(0)

  const onDeskFrame = (f: HandFrame) => {
    const k = c.current
    const h = f.hands[0]
    const now = performance.now()
    const md = desk.current
    let ring: { x: number; y: number; p: number; kind: string } | null = null
    let tip = ''
    const post = () => handCh?.postMessage({ hands: f.hands.map((x) => ({ x: x.x, y: x.y, pinch: x.pinch })), ring, tip })

    if (!h) {
      if (md.m === 'drag' || md.m === 'resize') k.sendWin({ type: 'janela.soltar', cancelar: md.m === 'resize' })
      desk.current = { m: 'idle' }
      post()
      return
    }

    if (md.m === 'resize') {
      // mão aberta (300 ms) ou soltar antes de fixar: cancela e a janela volta ao tamanho de antes
      if (h.pose === 'Open_Palm') {
        if (!md.open) md.open = now
        if (now - md.open > 300) {
          k.sendWin({ type: 'janela.soltar', cancelar: true })
          desk.current = { m: 'idle' }
          play('close')
          setStatus('Ajuste cancelado')
          post()
          return
        }
      } else md.open = 0
      if (!md.started && h.spread > 0.4) md.started = true
      if (md.started) {
        const alvo = winScaleForSpread(h.spread)
        if (Math.abs(alvo - md.z) > 0.03) md.still = now
        md.z += (alvo - md.z) * 0.35
        if (now - deskSend.current > 50) {
          deskSend.current = now
          k.sendWin({ type: 'janela.ajustar', escala: Number(md.z.toFixed(3)) })
        }
        const p = Math.min(1, (now - md.still) / k.hold)
        if (p > 0.08) ring = { x: h.x, y: h.y, p, kind: 'fixar' }
        tip = `Tamanho ${md.z.toFixed(1).replace('.', ',')}× · parado fixa · mão aberta cancela`
        if (p >= 1) {
          k.sendWin({ type: 'janela.soltar' })
          desk.current = { m: 'idle' }
          play('ack')
          setStatus('Tamanho fixado')
        }
      } else tip = 'Abra polegar e indicador em L'
      post()
      return
    }

    if (!h.pinch) {
      if (md.m === 'press') {
        // pinça rápida e parada: clique de verdade no que está embaixo
        if (now - md.t < 420) k.sendMouse({ acao: 'click_em', x: h.x, y: h.y })
      } else if (md.m === 'drag') {
        k.sendWin({ type: 'janela.soltar' })
        play('close', h.x * 2 - 1)
      }
      desk.current = { m: 'idle' }
      // mira: a borda acompanha a janela embaixo da mão (8 vezes por segundo)
      if (now - deskAim.current.t > 120 && Math.hypot(h.x - deskAim.current.x, h.y - deskAim.current.y) > 0.004) {
        deskAim.current = { t: now, x: h.x, y: h.y }
        k.sendWin({ type: 'janela.mira', x: h.x, y: h.y })
      }
      post()
      return
    }

    if (md.m === 'idle') {
      desk.current = { m: 'press', x: h.x, y: h.y, t: now }
    } else if (md.m === 'press') {
      const moved = Math.hypot(h.x - md.x, h.y - md.y) > 0.02
      if (moved) {
        // mexeu: pega e arrasta (a partir do ponto onde a pinça fechou)
        k.sendWin({ type: 'janela.pegar', x: md.x, y: md.y })
        desk.current = { m: 'drag', edge: 0, jogou: false }
        play('step', h.x * 2 - 1)
      } else {
        const p = Math.min(1, (now - md.t) / k.hold)
        if (p > 0.12) ring = { x: h.x, y: h.y, p, kind: 'armar' }
        if (p >= 1) {
          k.sendWin({ type: 'janela.pegar', x: md.x, y: md.y, modo: 'ajuste' })
          desk.current = { m: 'resize', started: false, z: 1, still: now, open: 0 }
          play('start')
        }
      }
    } else if (md.m === 'drag') {
      if (now - deskSend.current > 33) {
        deskSend.current = now
        k.sendWin({ type: 'janela.mover', x: h.x, y: h.y })
      }
      // segurou na borda da tela: joga para o monitor daquele lado
      const naBorda = h.x < 0.025 || h.x > 0.975
      if (naBorda && !md.jogou) {
        if (!md.edge) md.edge = now
        tip = 'Segure na borda para mandar ao outro monitor'
        if (now - md.edge > 350) {
          md.jogou = true
          k.sendWin({ type: 'janela.jogar', direcao: h.x < 0.5 ? 'esquerda' : 'direita' })
          k.sendWin({ type: 'janela.soltar' })
          desk.current = { m: 'idle' }
          play('card', h.x < 0.5 ? -1 : 1)
        }
      } else md.edge = 0
    }
    post()
  }

  const onMouseFrame = (h: Hand | undefined) => {
    const k = c.current
    const md = mode.current
    if (!h) {
      if (md.m === 'mouse-press' && md.down) k.sendMouse({ acao: 'up' })
      mode.current = { m: 'idle' }
      scrollY.current = null
      return
    }
    const now = performance.now()
    // dois dedos (Victory) rolam como no trackpad
    if (h.pose === 'Victory' && !h.pinch) {
      if (scrollY.current != null) k.sendMouse({ acao: 'scroll', dy: Math.round((h.palm.y - scrollY.current) * -2400) })
      scrollY.current = h.palm.y
      setStatus('Rolando')
      return
    }
    scrollY.current = null
    if (now - lastMouse.current > 30) {
      lastMouse.current = now
      k.sendMouse({ acao: 'move', x: h.x, y: h.y })
    }
    if (h.pinch && md.m !== 'mouse-press') {
      mode.current = { m: 'mouse-press', x: h.x, y: h.y, t: now, down: false }
    } else if (h.pinch && md.m === 'mouse-press' && !md.down && Math.hypot(h.x - md.x, h.y - md.y) > 0.02) {
      md.down = true
      k.sendMouse({ acao: 'down', x: md.x, y: md.y })
      setStatus('Arrastando')
    } else if (!h.pinch && md.m === 'mouse-press') {
      if (md.down) k.sendMouse({ acao: 'up' })
      else if (now - md.t < 450) k.sendMouse({ acao: 'click' })
      mode.current = { m: 'idle' }
      setStatus('')
    }
  }

  const onFrame = useCallback((f: HandFrame) => {
    const k = c.current
    const now = performance.now()
    const [h, h2] = f.hands
    let ring: Ring | null = null
    const md = mode.current

    if (k.mouse) {
      airStore.set(f)
      setHover(null)
      onMouseFrame(h)
      return
    }
    if (k.desk && !k.board) {
      airStore.set(f)
      setHover(null)
      onDeskFrame(f)
      return
    }
    if (desk.current.m !== 'idle') {
      // voltou para o HUD no meio de um gesto de janela: solta sem mexer
      c.current.sendWin({ type: 'janela.soltar', cancelar: desk.current.m === 'resize' })
      desk.current = { m: 'idle' }
    }
    handCh?.postMessage({ hands: [], ring: null, tip: '' })
    if (k.board) {
      airStore.set(f)
      setHover(null)
      return // o quadro desenha com a pinça por conta própria
    }

    // ---------- ajuste de tamanho ----------
    if (md.m === 'resize') {
      const card = cardOf(md.target)
      // cancelar: sumiu a mão, mão aberta (300 ms), ou soltou uma das pinças no modo de duas mãos
      if (!h || !card || (md.two && !(h2 && h.pinch && h2.pinch))) {
        reset('Ajuste cancelado')
        play('close')
        airStore.set(f)
        return
      }
      if (h.pose === 'Open_Palm') {
        if (!openSince.current) openSince.current = now
        if (now - openSince.current > 300) {
          openSince.current = 0
          reset('Ajuste cancelado')
          play('close')
          airStore.set(f)
          return
        }
      } else openSince.current = 0

      let target = md.z
      if (md.two && h2) {
        const d = Math.hypot(h.x - h2.x, h.y - h2.y)
        target = Math.min(MAX_Z, Math.max(MIN_Z, md.z0 * (d / md.d0)))
      } else {
        // só começa a seguir os dedos depois que eles abrem um pouco (sem pulo ao entrar no ajuste)
        if (!md.started && h.spread > 0.4) md.started = true
        if (md.started) target = scaleForSpread(h.spread)
      }
      const z = md.z + (target - md.z) * 0.35
      if (Math.abs(target - md.z) > 0.04) md.still = now
      md.z = z
      setLive({ id: md.target.id, z })
      if (card.kind === 'mercado') {
        const p = periodForScale(z)
        setPeriodPreview(p)
        setStatus(`Período · ${PERIOD_LABEL[p]} · parado fixa, mão aberta cancela`)
      } else setStatus(`Tamanho ${z.toFixed(1).replace('.', ',')}× · parado fixa, mão aberta cancela`)
      const moved = md.two || md.started
      const p = moved ? Math.min(1, (now - md.still) / k.hold) : 0
      if (p > 0.08) ring = { x: h.x, y: h.y, p, kind: 'fixar' }
      if (p >= 1) commitResize(md)
      airStore.set(f, ring)
      return
    }

    if (!h) {
      setHover(null)
      if (md.m !== 'idle') reset()
      airStore.set(f)
      return
    }

    const px = h.x * innerWidth
    const py = h.y * innerHeight
    const under = document.elementFromPoint(px, py) as HTMLElement | null

    // ---------- duas pinças paradas: ajuste com as duas mãos ----------
    if (h2 && h.pinch && h2.pinch && md.m === 'press') {
      const target = md.target ?? (k.focus ? ({ kind: 'focus', id: k.focus.id } as Target) : null)
      if (target) {
        const still = Math.hypot(h.x - md.x, h.y - md.y) < 0.03
        const p = still ? Math.min(1, (now - md.t) / k.hold) : 0
        if (!still) Object.assign(md, { x: h.x, y: h.y, t: now })
        ring = { x: (h.x + h2.x) / 2, y: (h.y + h2.y) / 2, p, kind: 'armar' }
        if (p >= 1) enterResize(target, true, Math.max(0.05, Math.hypot(h.x - h2.x, h.y - h2.y)), now)
        airStore.set(f, ring)
        return
      }
    }

    if (!h.pinch) {
      if (md.m === 'press') {
        // soltou rápido: clique
        if (now - md.t < 450) {
          const el = md.el?.closest(CLICKABLE) as HTMLElement | null
          el?.click()
          if (el instanceof HTMLInputElement) el.focus()
        }
        reset()
      } else if (md.m === 'drag-card' && k.focus) {
        const z = zoneAt(h)
        if (z === 'fixar') {
          const others = k.pinned.filter((p) => p.card.id !== k.focus!.id)
          k.setPinned([...others, { card: k.focus, x: 0.02, y: Math.min(0.62, 0.1 + others.length * 0.24), scale: k.scales[k.focus.id] }].slice(-3))
          k.setFocusId(null)
        } else if (z === 'fechar') k.closeCard(k.focus.id)
        else if (z === 'guardar') k.setFocusId(null)
        else if (z === 'copiar') {
          k.copyCard(k.focus)
          reset('Copiado · é só colar onde quiser')
          airStore.set(f)
          return
        }
        reset()
      } else if (md.m === 'drag-chip') {
        if (h.y - md.y < -0.08) k.setFocusId(md.id)
        reset()
      } else if (md.m === 'drag-pin') {
        if (h.x > 0.88) k.setPinned(k.pinned.filter((p) => p.card.id !== md.id))
        reset()
      } else if (md.m !== 'idle') reset()
      setHover(under?.closest(`${CLICKABLE}, .focus, .pinned`) ?? null)
      const id = (under?.closest('.focus, .pinned, .strip .chip') as HTMLElement | null)?.dataset.id ?? null
      if (id !== pointed.current) {
        pointed.current = id
        k.onPoint(id)
      }
      airStore.set(f)
      return
    }

    // ---------- pinça fechada ----------
    if (md.m === 'idle') {
      const pinEl = under?.closest('.pinned') as HTMLElement | null
      const chip = under?.closest('.strip .chip') as HTMLElement | null
      const onButton = !!under?.closest('button, a, input')
      const target: Target | null =
        pinEl?.dataset.id && !onButton ? { kind: 'pin', id: pinEl.dataset.id } : under?.closest('.focus') && k.focus && !onButton ? { kind: 'focus', id: k.focus.id } : null
      mode.current = { m: 'press', el: under, x: h.x, y: h.y, t: now, target, scroll: target ? null : scrollableAncestor(under), chip: chip?.dataset.id ?? null, pin: pinEl?.dataset.id ?? null }
      setHover(null)
      airStore.set(f)
      return
    }

    const dx = h.x - ('x' in md ? md.x : h.x)
    const dy = h.y - ('y' in md ? md.y : h.y)

    if (md.m === 'press') {
      const moved = Math.hypot(dx, dy) > 0.025
      if (moved) {
        // mexeu: é arrastar, nunca ajuste
        if (md.target?.kind === 'focus') {
          mode.current = { m: 'drag-card', x: md.x, y: md.y }
          setStatus('Segurando o cartão')
        } else if (md.target?.kind === 'pin') {
          const p = k.pinned.find((x) => x.card.id === md.target!.id)
          if (p) mode.current = { m: 'drag-pin', id: p.card.id, x: md.x, y: md.y, ox: p.x, oy: p.y }
        } else if (md.chip) {
          mode.current = { m: 'drag-chip', id: md.chip, x: md.x, y: md.y }
        } else if (md.scroll) {
          mode.current = { m: 'scroll', el: md.scroll, x: md.x, y: md.y, top: md.scroll.scrollTop, left: md.scroll.scrollLeft }
          setStatus('Rolando')
        } else mode.current = { m: 'idle' }
      } else if (md.target) {
        // parado em cima de um cartão: o anel enche e entra no ajuste
        const p = Math.min(1, (now - md.t) / k.hold)
        if (p > 0.12) ring = { x: h.x, y: h.y, p, kind: 'armar' }
        if (p >= 1) enterResize(md.target, false, 0, now)
      }
      airStore.set(f, ring)
      return
    }

    if (md.m === 'drag-card') {
      setDrag({ x: dx * innerWidth, y: dy * innerHeight })
      const z = zoneAt(h)
      setZone(z)
      setStatus(
        z === 'fixar' ? 'Solte para fixar' : z === 'fechar' ? 'Solte para fechar' : z === 'guardar' ? 'Solte para guardar' : z === 'copiar' ? 'Solte para copiar' : 'Segurando o cartão',
      )
    } else if (md.m === 'drag-chip') {
      setChipDrag({ id: md.id, x: dx * innerWidth, y: dy * innerHeight })
      setStatus(dy < -0.08 ? 'Solte para abrir' : 'Puxe para cima')
    } else if (md.m === 'drag-pin') {
      k.setPinned(k.pinned.map((p) => (p.card.id === md.id ? { ...p, x: clamp(md.ox + dx, 0, 0.8), y: clamp(md.oy + dy, 0.04, 0.8) } : p)))
      setStatus(h.x > 0.88 ? 'Solte para desafixar' : 'Movendo')
    } else if (md.m === 'scroll') {
      md.el.scrollTop = md.top - dy * innerHeight * 1.6
      md.el.scrollLeft = md.left - dx * innerWidth * 1.6
    }
    airStore.set(f)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => setHover(null), [])

  return { onFrame, drag, chipDrag, zone, live, periodPreview, status }
}

function zoneAt(h: Hand): Zone {
  if (h.y < 0.1 && h.x > 0.3 && h.x < 0.7) return 'copiar'
  if (h.x < 0.12) return 'fixar'
  if (h.x > 0.88) return 'fechar'
  if (h.y > 0.84) return 'guardar'
  return null
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
