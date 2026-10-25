// Mãos como ponteiro da tela inteira, sem modos: o gesto vale para o que estiver embaixo.
//
//   pinça e solta rápido   → clica (no cartão do Jarvis ou de verdade, em qualquer app)
//   pinça e mexe           → arrasta (o cartão do Jarvis, ou a janela do app embaixo)
//                            arrastar uma janela até a borda e segurar → manda para o outro monitor
//   pinça PARADA (o anel)  → ajuste de tamanho: polegar e indicador em L, abrir aumenta, fechar diminui;
//                            parado de novo fixa; mão aberta ou tirar a mão cancela (volta como estava)
//   dois dedos e mexe      → rola a página embaixo
//
// O cursor, o anel e a borda são desenhados pela camada (Overlay.tsx) a partir do estado daqui.

import { useEffect, useRef, useState } from 'react'
import { handStore, type Hand } from '../lib/live'
import { play } from '../lib/sfx'

export type Ring = { x: number; y: number; p: number; kind: 'armar' | 'fixar' }

type Ctx = {
  send: (m: object) => void
  hold: number
  cardAt: (x: number, y: number) => string | null // id do cartão do Jarvis embaixo do ponto (px da camada)
  cardScale: (id: string) => number
  moveCard: (id: string, dx: number, dy: number, done: boolean) => void
  scaleCard: (id: string, z: number | null) => void // null = cancela (volta ao tamanho de antes)
  clickAt: (x: number, y: number) => boolean // clica num botão da camada; false se não havia nada
}

type Mode =
  | { m: 'idle' }
  | { m: 'press'; x: number; y: number; t: number; card: string | null }
  | { m: 'drag-card'; id: string; x: number; y: number }
  | { m: 'drag-win'; edge: number }
  | { m: 'resize'; card: string | null; z0: number; z: number; started: boolean; still: number; open: number }

const MIN_Z = 0.5
const MAX_Z = 1.8
const zFor = (spread: number) => MIN_Z + ((Math.min(1.25, Math.max(0.25, spread)) - 0.25) / 1.0) * (MAX_Z - MIN_Z)

export function useHandControl(ctx: Ctx, active: boolean) {
  const c = useRef(ctx)
  c.current = ctx
  const mode = useRef<Mode>({ m: 'idle' })
  const aim = useRef({ t: 0, x: -1, y: -1 })
  const sent = useRef(0)
  const scroll = useRef<number | null>(null)
  const [ring, setRing] = useState<Ring | null>(null)
  const [tip, setTip] = useState('')
  const [hoverCard, setHoverCard] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    return handStore.subscribe(() => step(handStore.get().hands[0]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const reset = (msg = '') => {
    mode.current = { m: 'idle' }
    setRing(null)
    setTip(msg)
    if (msg) setTimeout(() => setTip((t) => (t === msg ? '' : t)), 1500)
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
      if (md.m === 'press' && now - md.t < 420) {
        // pinça rápida: clique (num botão do Jarvis, senão de verdade no app embaixo)
        if (!k.clickAt(px, py)) k.send({ type: 'clique', x: h.x, y: h.y })
      } else if (md.m === 'drag-card') {
        k.moveCard(md.id, px - md.x, py - md.y, true)
        play('close', h.x * 2 - 1)
      } else if (md.m === 'drag-win') {
        k.send({ type: 'janela.soltar' })
        play('close', h.x * 2 - 1)
      }
      if (md.m !== 'idle') reset()
      // dois dedos (Victory) e mexer: rola como no trackpad
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
      // mira: borda azul na janela embaixo da mão (8 vezes por segundo), fora dos cartões do Jarvis
      if (!card && now - aim.current.t > 120 && Math.hypot(h.x - aim.current.x, h.y - aim.current.y) > 0.004) {
        aim.current = { t: now, x: h.x, y: h.y }
        k.send({ type: 'janela.mira', x: h.x, y: h.y })
      }
      return
    }

    // ---------- pinça fechada ----------
    if (md.m === 'idle') {
      mode.current = { m: 'press', x: px, y: py, t: now, card: k.cardAt(px, py) }
      return
    }
    if (md.m === 'press') {
      if (Math.hypot(px - md.x, py - md.y) > 0.02 * innerWidth) {
        // mexeu: arrastar, nunca ajuste
        if (md.card) mode.current = { m: 'drag-card', id: md.card, x: md.x, y: md.y }
        else {
          k.send({ type: 'janela.pegar', x: md.x / innerWidth, y: md.y / innerHeight })
          mode.current = { m: 'drag-win', edge: 0 }
        }
        play('step', h.x * 2 - 1)
        return
      }
      // parado: o anel enche e entra no ajuste
      const p = Math.min(1, (now - md.t) / k.hold)
      setRing(p > 0.12 ? { x: h.x, y: h.y, p, kind: 'armar' } : null)
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
        setTip('')
      }
    }
  }

  return { ring, tip, hoverCard }
}
