// Mãos como ponteiro da tela inteira, sem modos: o gesto vale para o que estiver embaixo.
//
//   cursor                  → anel que fecha conforme o polegar se aproxima do indicador (como no Quest)
//   pinça e solta           → clica onde a pinça começou (cartão do Jarvis ou qualquer app)
//   pinça e mexe            → arrasta o cartão ou a janela embaixo da mão; segurar na borda manda ao outro monitor
//   pinça PARADA (o anel)   → ajuste de tamanho: polegar e indicador em L, abrir aumenta, fechar diminui;
//                             parado de novo fixa; mão aberta ou tirar a mão cancela (volta como estava)
//   dois dedos (V) e mexe   → rola a página embaixo
//   palma virada para você  → aparece o botão na mão; pinça abre o menu rápido (como no Quest): com a pinça,
//                             aponte o item e solte; solte no meio para fechar; segure no meio para recentrar
//   duas mãos em pinça      → afastar ou juntar muda o tamanho do cartão ou da janela embaixo; soltar fixa
//
// O cursor, o anel, o menu e a borda são desenhados pela camada (Overlay.tsx) a partir do estado daqui.

import { useEffect, useRef, useState } from 'react'
import { handStore, type Hand } from '../lib/live'
import { play } from '../lib/sfx'

export type Ring = { x: number; y: number; p: number; kind: 'armar' | 'fixar' | 'centro' }
export type Menu = { x: number; y: number; sel: number | null }

export const MENU = [
  { acao: 'ouvir', rotulo: 'Falar' },
  { acao: 'alternar_hud', rotulo: 'HUD' },
  { acao: 'ver_tela', rotulo: 'Ver a tela' },
  { acao: 'memoria', rotulo: 'Memória' },
  { acao: 'fechar_cartoes', rotulo: 'Cartões' },
  { acao: 'parar', rotulo: 'Parar' },
] as const
export const MENU_RAIO = 92 // px do centro do menu até cada item

type Ctx = {
  send: (m: object) => void
  hold: number
  cardAt: (x: number, y: number) => string | null // id do cartão do Jarvis embaixo do ponto (px da camada)
  cardScale: (id: string) => number
  moveCard: (id: string, dx: number, dy: number, done: boolean) => void
  scaleCard: (id: string, z: number | null) => void // null = cancela (volta ao tamanho de antes)
  clickAt: (x: number, y: number) => boolean // clica num botão da camada; false se não havia nada
  /** Mãos nas coordenadas desta camada (0..1 do monitor dela). Ocupada (no meio de um gesto), fica com a mão
   *  mesmo fora do monitor, para arrastar uma janela de uma tela para a outra. */
  local: (hands: Hand[], ocupada: boolean) => Hand[]
}

type Mode =
  | { m: 'idle' }
  | { m: 'press'; x: number; y: number; t: number; card: string | null }
  | { m: 'drag-card'; id: string; x: number; y: number }
  | { m: 'drag-win'; edge: number }
  | { m: 'resize'; card: string | null; z0: number; z: number; started: boolean; still: number; open: number }
  | { m: 'menu'; x: number; y: number; sel: number | null; t: number }
  | { m: 'escala'; card: string | null; d0: number; z0: number; z: number }

const CLIQUE_MS = 650 // pinça e solta até aqui = clique
const MEXER = 0.03 // quanto (fração da largura) a mão anda com a pinça para virar arrasto
const MIN_Z = 0.5
const MAX_Z = 1.8
const RECENTRAR_MS = 1200
const zFor = (spread: number) => MIN_Z + ((Math.min(1.25, Math.max(0.25, spread)) - 0.25) / 1.0) * (MAX_Z - MIN_Z)

export function useHandControl(ctx: Ctx, active: boolean) {
  const c = useRef(ctx)
  c.current = ctx
  const mode = useRef<Mode>({ m: 'idle' })
  const aim = useRef({ t: 0, x: -1, y: -1 })
  const sent = useRef(0)
  const scroll = useRef<number | null>(null)
  const [ring, setRing] = useState<Ring | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [tip, setTip] = useState('')
  const [hoverCard, setHoverCard] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    return handStore.subscribe(() => {
      const md = mode.current
      const hs = c.current.local(handStore.get().hands, md.m !== 'idle')
      if (hs.length === 2 && hs[0].pinch && hs[1].pinch && md.m !== 'resize' && md.m !== 'menu') return escala(hs[0], hs[1])
      if (md.m === 'escala') return fimEscala()
      step(hs[0])
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const flash = (msg: string, ms = 1500) => {
    setTip(msg)
    setTimeout(() => setTip((t) => (t === msg ? '' : t)), ms)
  }
  const reset = (msg = '') => {
    mode.current = { m: 'idle' }
    setRing(null)
    setMenu(null)
    if (msg) flash(msg)
    else setTip('')
  }

  // ---------- duas mãos: tamanho do cartão ou da janela embaixo do meio delas ----------
  function escala(a: Hand, b: Hand) {
    const k = c.current
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    let md = mode.current
    if (md.m !== 'escala') {
      if (md.m === 'drag-win') k.send({ type: 'janela.soltar', cancelar: true })
      const mx = ((a.x + b.x) / 2) * innerWidth
      const my = ((a.y + b.y) / 2) * innerHeight
      const card = k.cardAt(mx, my)
      if (!card) k.send({ type: 'janela.pegar', x: mx / innerWidth, y: my / innerHeight, modo: 'ajuste' })
      const z0 = card ? k.cardScale(card) : 1
      md = mode.current = { m: 'escala', card, d0: Math.max(0.05, d), z0, z: z0 }
      setRing(null)
      play('start')
    }
    const alvo = Math.min(2.4, Math.max(0.45, (d / md.d0) * md.z0))
    md.z += (alvo - md.z) * 0.4
    if (md.card) k.scaleCard(md.card, md.z)
    else if (performance.now() - sent.current > 50) {
      sent.current = performance.now()
      k.send({ type: 'janela.ajustar', escala: Number(md.z.toFixed(3)) })
    }
    setTip(`Tamanho ${md.z.toFixed(1).replace('.', ',')}× · solte para fixar`)
  }
  function fimEscala() {
    const md = mode.current
    if (md.m !== 'escala') return
    if (!md.card) c.current.send({ type: 'janela.soltar' })
    play('ack')
    reset('Tamanho fixado')
  }

  function step(h: Hand | undefined) {
    const k = c.current
    const md = mode.current
    const now = performance.now()

    if (!h) {
      if (md.m === 'drag-win') k.send({ type: 'janela.soltar' })
      if (md.m === 'resize') md.card ? k.scaleCard(md.card, null) : k.send({ type: 'janela.soltar', cancelar: true })
      if (md.m !== 'idle') reset()
      setHoverCard(null)
      return
    }
    const px = h.x * innerWidth
    const py = h.y * innerHeight

    // ---------- menu da palma: a pinça segura o menu, apontar escolhe, soltar confirma ----------
    if (md.m === 'menu') {
      const dx = px - md.x
      const dy = py - md.y
      let sel: number | null = null
      if (Math.hypot(dx, dy) > MENU_RAIO * 0.45) {
        const ang = (Math.atan2(dy, dx) * 180) / Math.PI + 90 // 0° = em cima, sentido horário
        sel = Math.round((((ang % 360) + 360) % 360) / (360 / MENU.length)) % MENU.length
      }
      if (sel !== md.sel) {
        md.sel = sel
        md.t = now
        if (sel != null) play('step', h.x * 2 - 1)
      }
      if (!h.pinch) {
        if (md.sel != null) {
          const item = MENU[md.sel]
          k.send({ type: 'gesto.acao', acao: item.acao })
          play('ack')
          reset(item.rotulo)
        } else {
          play('close')
          reset()
        }
        return
      }
      // segurar no meio: recentrar (o ponto onde a mão está vira o meio da tela)
      const p = md.sel == null ? Math.min(1, (now - md.t) / RECENTRAR_MS) : 0
      setRing(p > 0.15 ? { x: md.x / innerWidth, y: md.y / innerHeight, p, kind: 'centro' } : null)
      if (p >= 1) {
        k.send({ type: 'maos.recentrar' })
        play('start')
        reset('Recentrado')
        return
      }
      setMenu({ x: md.x, y: md.y, sel: md.sel })
      setTip(md.sel == null ? 'Aponte e solte · segure no meio para recentrar' : MENU[md.sel].rotulo)
      return
    }

    // ---------- ajuste de tamanho (cartão ou janela) ----------
    if (md.m === 'resize') {
      if (h.pose === 'Open_Palm') {
        if (!md.open) md.open = now
        if (now - md.open > 300) {
          md.card ? k.scaleCard(md.card, null) : k.send({ type: 'janela.soltar', cancelar: true })
          play('close')
          reset('Ajuste cancelado')
          return
        }
      } else md.open = 0
      if (!md.started && h.spread > 0.4) md.started = true // só segue os dedos depois que abrem um pouco
      if (md.started) {
        const alvo = md.card ? zFor(h.spread) * md.z0 : zFor(h.spread)
        if (Math.abs(alvo - md.z) > 0.03) md.still = now
        md.z += (alvo - md.z) * 0.35
        if (md.card) k.scaleCard(md.card, md.z)
        else if (now - sent.current > 50) {
          sent.current = now
          k.send({ type: 'janela.ajustar', escala: Number(md.z.toFixed(3)) })
        }
        const p = Math.min(1, (now - md.still) / k.hold)
        setRing(p > 0.08 ? { x: h.x, y: h.y, p, kind: 'fixar' } : null)
        setTip(`Tamanho ${md.z.toFixed(1).replace('.', ',')}× · parado fixa · mão aberta cancela`)
        if (p >= 1) {
          if (!md.card) k.send({ type: 'janela.soltar' })
          play('ack')
          reset('Tamanho fixado')
        }
      } else setTip('Abra polegar e indicador em L')
      return
    }

    // ---------- mão sem pinça ----------
    if (!h.pinch) {
      if (md.m === 'press' && now - md.t < CLIQUE_MS) {
        // pinça e solta: clique onde a pinça COMEÇOU (soltar os dedos mexe a mão), num botão do Jarvis ou no app
        if (!k.clickAt(md.x, md.y)) k.send({ type: 'clique', x: md.x / innerWidth, y: md.y / innerHeight })
        play('ack', (md.x / innerWidth) * 2 - 1)
        flash('Clique', 600)
      } else if (md.m === 'drag-card') {
        k.moveCard(md.id, px - md.x, py - md.y, true)
        play('close', h.x * 2 - 1)
      } else if (md.m === 'drag-win') {
        k.send({ type: 'janela.soltar' })
        play('close', h.x * 2 - 1)
      }
      if (md.m !== 'idle') reset()
      // dois dedos (V) e mexer: rola como no trackpad
      if (h.pose === 'Victory') {
        if (scroll.current != null) k.send({ type: 'rolar', dy: Math.round((h.palm[1] - scroll.current) * -2400) })
        scroll.current = h.palm[1]
        setTip('Rolando')
        return
      }
      if (scroll.current != null) {
        scroll.current = null
        setTip('')
      }
      const card = k.cardAt(px, py)
      setHoverCard(card)
      setTip((t) => (h.costas ? 'Pince para o menu' : t === 'Pince para o menu' ? '' : t))
      // mira: borda azul na janela embaixo da mão (8 vezes por segundo), fora dos cartões do Jarvis
      if (!card && !h.costas && now - aim.current.t > 120 && Math.hypot(h.x - aim.current.x, h.y - aim.current.y) > 0.004) {
        aim.current = { t: now, x: h.x, y: h.y }
        k.send({ type: 'janela.mira', x: h.x, y: h.y })
      }
      return
    }

    // ---------- pinça fechada ----------
    if (md.m === 'idle') {
      const x = (h.ax ?? h.x) * innerWidth
      const y = (h.ay ?? h.y) * innerHeight
      if (h.costas) {
        // palma virada para você + pinça: o menu rápido abre ali
        mode.current = { m: 'menu', x, y, sel: null, t: now }
        setMenu({ x, y, sel: null })
        play('start')
        return
      }
      mode.current = { m: 'press', x, y, t: now, card: k.cardAt(x, y) }
      return
    }
    if (md.m === 'press') {
      if (Math.hypot(px - md.x, py - md.y) > MEXER * innerWidth) {
        // mexeu: arrastar, nunca ajuste
        if (md.card) mode.current = { m: 'drag-card', id: md.card, x: md.x, y: md.y }
        else {
          k.send({ type: 'janela.pegar', x: md.x / innerWidth, y: md.y / innerHeight })
          mode.current = { m: 'drag-win', edge: 0 }
        }
        setRing(null)
        play('step', h.x * 2 - 1)
        return
      }
      // parado: o anel enche e entra no ajuste (só aparece depois do tempo do clique, para não piscar)
      const p = Math.min(1, (now - md.t) / k.hold)
      setRing(now - md.t > CLIQUE_MS ? { x: md.x / innerWidth, y: md.y / innerHeight, p, kind: 'armar' } : null)
      if (p >= 1) {
        if (!md.card) k.send({ type: 'janela.pegar', x: md.x / innerWidth, y: md.y / innerHeight, modo: 'ajuste' })
        const z0 = md.card ? k.cardScale(md.card) : 1
        mode.current = { m: 'resize', card: md.card, z0, z: md.card ? z0 : 1, started: false, still: now, open: 0 }
        setRing(null)
        play('start')
      }
      return
    }
    if (md.m === 'drag-card') {
      k.moveCard(md.id, px - md.x, py - md.y, false)
      setTip('Arrastando o cartão')
    } else if (md.m === 'drag-win') {
      if (now - sent.current > 33) {
        sent.current = now
        k.send({ type: 'janela.mover', x: h.x, y: h.y })
      }
      const borda = h.x < 0.025 || h.x > 0.975
      if (borda) {
        if (!md.edge) md.edge = now
        setTip('Segure na borda para mandar ao outro monitor')
        if (now - md.edge > 350) {
          k.send({ type: 'janela.jogar', direcao: h.x < 0.5 ? 'esquerda' : 'direita' })
          k.send({ type: 'janela.soltar' })
          play('card', h.x < 0.5 ? -1 : 1)
          reset()
        }
      } else {
        md.edge = 0
        setTip('Movendo a janela')
      }
    }
  }

  return { ring, menu, tip, hoverCard }
}
