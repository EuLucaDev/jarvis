// Mãos como ponteiro da tela inteira, no modelo de interação da Meta (Quest e pulseira do Ray-Ban Display),
// adaptado à câmera. Sem modos: o gesto vale para o que estiver embaixo.
//
//   cursor                  → anel que fecha conforme o polegar se aproxima do indicador (força da pinça)
//   pinça e solta           → seleciona: clica onde a pinça começou (cartão do Jarvis ou qualquer app)
//   pinça e arrasta         → no conteúdo, rola (como arrastar no Quest), com inércia ao soltar;
//                             na barra de título de uma janela, move a janela (segurar na borda: outro monitor);
//                             num cartão do Jarvis, move o cartão
//   pinça parada e gira     → "pinçar e girar" da pulseira: girar o punho muda o volume
//   palma virada para você  → aparece o botão na mão; pinça abre o menu rápido. Com a pinça, aponte o item e
//                             solte para escolher; solte no meio para fechar; segure no meio para recentrar
//   duas mãos em pinça      → afastar ou juntar muda o tamanho do cartão ou da janela embaixo
//
// Microgestos (polegar no indicador) e a pinça do dedo médio são reconhecidos no núcleo (hands.py).
// O cursor, o anel, o menu e a borda são desenhados pela camada (Overlay.tsx) a partir do estado daqui.

import { useEffect, useRef, useState } from 'react'
import { handStore, type Hand } from '../lib/live'
import { play } from '../lib/sfx'

export type Ring = { x: number; y: number; p: number; kind: 'armar' | 'girar' | 'centro'; valor?: number }
export type Menu = { x: number; y: number; sel: number | null }
type Rect = { x: number; y: number; w: number; h: number }

export const MENU = [
  { acao: 'ouvir', rotulo: 'Falar' },
  { acao: 'alternar_hud', rotulo: 'HUD' },
  { acao: 'espelho', rotulo: 'Tela' },
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
  winAt: () => Rect | null // janela mirada agora (px da camada), para saber se a pinça caiu na barra de título
  /** Mãos nas coordenadas desta camada (0..1 do monitor dela). Ocupada (no meio de um gesto), fica com a mão
   *  mesmo fora do monitor, para arrastar uma janela de uma tela para a outra. */
  local: (hands: Hand[], ocupada: boolean) => Hand[]
}

type Mode =
  | { m: 'idle' }
  | { m: 'press'; x: number; y: number; t: number; card: string | null; barra: boolean; giro0: number }
  | { m: 'drag-card'; id: string; x: number; y: number }
  | { m: 'drag-win'; edge: number }
  | { m: 'scroll'; y: number; x: number; vy: number; vx: number; t: number }
  | { m: 'girar'; giro: number; nivel: number }
  | { m: 'menu'; x: number; y: number; sel: number | null; t: number }
  | { m: 'escala'; card: string | null; d0: number; z0: number; z: number }

const CLIQUE_MS = 600 // pinça e solta até aqui = seleção
const MEXER = 0.025 // quanto (fração da largura) a mão anda com a pinça para virar arrasto
const BARRA_PX = 46 // altura da barra de título (Mac ~28, Windows ~32, com folga)
const GIRAR_GRAUS = 14 // cada passo do "pinçar e girar"
const RECENTRAR_MS = 1200

const angDif = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180

export function useHandControl(ctx: Ctx, active: boolean) {
  const c = useRef(ctx)
  c.current = ctx
  const mode = useRef<Mode>({ m: 'idle' })
  const aim = useRef({ t: 0, x: -1, y: -1 })
  const sent = useRef(0)
  const inercia = useRef(0)
  const [ring, setRing] = useState<Ring | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [tip, setTip] = useState('')
  const [hoverCard, setHoverCard] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    return handStore.subscribe(() => {
      const md = mode.current
      const hs = c.current.local(handStore.get().hands, md.m !== 'idle')
      if (hs.length === 2 && hs[0].pinch && hs[1].pinch && md.m !== 'menu' && md.m !== 'girar') return escala(hs[0], hs[1])
      if (md.m === 'escala') return fimEscala()
      step(hs[0])
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const flash = (msg: string, ms = 1200) => {
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

  // ---------- inércia da rolagem, como no Quest ----------
  function soltarRolagem(vy: number, vx: number) {
    clearInterval(inercia.current)
    if (Math.hypot(vx, vy) < 0.4) return
    let n = 0
    inercia.current = window.setInterval(() => {
      vy *= 0.86
      vx *= 0.86
      n++
      if (n > 22 || Math.hypot(vx, vy) < 0.15) return clearInterval(inercia.current)
      c.current.send({ type: 'rolar', dy: Math.round(vy * 33), dx: Math.round(vx * 33) })
    }, 33)
  }

  function step(h: Hand | undefined) {
    const k = c.current
    const md = mode.current
    const now = performance.now()

    if (!h) {
      if (md.m === 'drag-win') k.send({ type: 'janela.soltar' })
      if (md.m !== 'idle') reset()
      setHoverCard(null)
      return
    }
    const px = h.x * innerWidth
    const py = h.y * innerHeight

    // ---------- menu da palma aberto: a pinça segura o menu, apontar escolhe, soltar confirma ----------
    if (md.m === 'menu') {
      const dx = px - md.x
      const dy = py - md.y
      const r = Math.hypot(dx, dy)
      let sel: number | null = null
      if (r > MENU_RAIO * 0.45) {
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

    // ---------- pinçar e girar: volume ----------
    if (md.m === 'girar') {
      if (!h.pinch) {
        play('close')
        reset()
        return
      }
      const giro = h.torcao ?? 0
      const dif = angDif(giro, md.giro)
      if (Math.abs(dif) >= GIRAR_GRAUS) {
        const passo = dif > 0 ? 1 : -1
        md.giro = giro
        md.nivel += passo
        k.send({ type: 'volume', delta: passo * 4 })
        play('step', passo * 0.5)
      }
      setRing({ x: h.x, y: h.y, p: 1, kind: 'girar', valor: md.nivel })
      setTip('Gire o punho: volume · solte para terminar')
      return
    }

    // ---------- mão sem pinça ----------
    if (!h.pinch) {
      if (md.m === 'press' && now - md.t < CLIQUE_MS) {
        // seleção onde a pinça COMEÇOU (soltar os dedos mexe a mão), num botão do Jarvis ou no app
        if (!k.clickAt(md.x, md.y)) k.send({ type: 'clique', x: md.x / innerWidth, y: md.y / innerHeight })
        play('ack', (md.x / innerWidth) * 2 - 1)
        flash('Clique', 600)
      } else if (md.m === 'drag-card') {
        k.moveCard(md.id, px - md.x, py - md.y, true)
        play('close', h.x * 2 - 1)
      } else if (md.m === 'drag-win') {
        k.send({ type: 'janela.soltar' })
        play('close', h.x * 2 - 1)
      } else if (md.m === 'scroll') {
        soltarRolagem(md.vy, md.vx)
      }
      if (md.m !== 'idle') reset()
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
      clearInterval(inercia.current)
      const x = (h.ax ?? h.x) * innerWidth
      const y = (h.ay ?? h.y) * innerHeight
      if (h.costas) {
        // palma virada para você + pinça: o menu rápido abre ali
        mode.current = { m: 'menu', x, y, sel: null, t: now }
        setMenu({ x, y, sel: null })
        play('start')
        return
      }
      const card = k.cardAt(x, y)
      const w = card ? null : k.winAt()
      const barra = !!w && x >= w.x && x <= w.x + w.w && y >= w.y && y - w.y <= BARRA_PX
      mode.current = { m: 'press', x, y, t: now, card, barra, giro0: h.torcao ?? 0 }
      return
    }
    if (md.m === 'press') {
      if (Math.hypot(px - md.x, py - md.y) > MEXER * innerWidth) {
        if (md.card) mode.current = { m: 'drag-card', id: md.card, x: md.x, y: md.y }
        else if (md.barra) {
          k.send({ type: 'janela.pegar', x: md.x / innerWidth, y: md.y / innerHeight })
          mode.current = { m: 'drag-win', edge: 0 }
        } else {
          // arrastar o conteúdo rola, como no Quest: o conteúdo segue a mão
          mode.current = { m: 'scroll', x: px, y: py, vx: 0, vy: 0, t: now }
          setTip('Rolando')
        }
        setRing(null)
        play('step', h.x * 2 - 1)
        return
      }
      // parada: o anel enche e vira o "pinçar e girar"; girar já no meio do anel também entra
      const p = Math.min(1, (now - md.t) / k.hold)
      setRing(now - md.t > CLIQUE_MS * 0.8 ? { x: md.x / innerWidth, y: md.y / innerHeight, p, kind: 'armar' } : null)
      if (p >= 1 || (now - md.t > 250 && Math.abs(angDif(h.torcao ?? 0, md.giro0)) > GIRAR_GRAUS * 1.5)) {
        mode.current = { m: 'girar', giro: h.torcao ?? 0, nivel: 0 }
        play('start')
      }
      return
    }
    if (md.m === 'scroll') {
      const dt = Math.max(1, now - md.t)
      if (dt < 30) return
      const dy = py - md.y
      const dx = px - md.x
      md.vy = md.vy * 0.5 + (dy / dt) * 0.5 * 1.6
      md.vx = md.vx * 0.5 + (dx / dt) * 0.5 * 1.6
      md.x = px
      md.y = py
      md.t = now
      if (Math.abs(dy) + Math.abs(dx) > 1) k.send({ type: 'rolar', dy: Math.round(dy * 1.6), dx: Math.round(dx * 1.6) })
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
