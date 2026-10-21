import { useEffect, useRef, type MutableRefObject } from 'react'
import type { Live, Phase } from './useJarvis'

// A esfera: fitas fechadas de luz que ondulam em volta de um núcleo escuro.
// Cada fita é um laço r(θ) = R·(1 + Σ aₖ·sin(kθ + φₖ(t))), desenhado em alguns fios finos
// com mistura aditiva. O volume da voz (live.level) aumenta a deformação e o brilho.

type Ribbon = {
  r: number
  harm: { k: number; a: number; w: number; p: number }[]
  strands: number
  spin: number
  hue: number
}

const PHASE_LOOK: Record<Phase, { speed: number; amp: number; glow: number; hue: number }> = {
  espera: { speed: 0.25, amp: 0.55, glow: 0.45, hue: 0 },
  ouvindo: { speed: 0.6, amp: 0.9, glow: 0.8, hue: -6 },
  pensando: { speed: 1.6, amp: 0.75, glow: 0.75, hue: 4 },
  falando: { speed: 0.9, amp: 1.25, glow: 1, hue: -10 },
}

function seeded(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647
    return (seed - 1) / 2147483646
  }
}

function makeRibbons(): Ribbon[] {
  const rnd = seeded(7)
  return Array.from({ length: 9 }, (_, i) => ({
    r: 0.8 + rnd() * 0.22,
    harm: [2, 3, 4, 5, 7].map((k) => ({
      k,
      a: (0.02 + rnd() * 0.06) / Math.sqrt(k - 1),
      w: (rnd() - 0.5) * 1.4,
      p: rnd() * Math.PI * 2,
    })),
    strands: 3 + (i % 2),
    spin: (rnd() - 0.5) * 0.35,
    hue: 196 + rnd() * 18,
  }))
}

export function Orb({ live, phase }: { live: MutableRefObject<Live>; phase: Phase }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  useEffect(() => {
    const cv = canvas.current!
    const ctx = cv.getContext('2d')!
    const ribbons = makeRibbons()
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const look = { ...PHASE_LOOK.espera }
    let t = 0
    let last = performance.now()
    let raf = 0
    const N = 200

    const resize = () => {
      const dpr = Math.min(2, devicePixelRatio || 1)
      const size = Math.min(cv.clientWidth, cv.clientHeight)
      cv.width = cv.height = Math.round(size * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(cv)
    resize()

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const target = PHASE_LOOK[phaseRef.current]
      for (const key of ['speed', 'amp', 'glow', 'hue'] as const) look[key] += (target[key] - look[key]) * 0.05
      const lvl = live.current.level
      t += dt * look.speed * (reduce ? 0.2 : 1) * (1 + lvl * 0.8)

      const size = Math.min(cv.clientWidth, cv.clientHeight)
      const c = size / 2
      const R = size * 0.36
      ctx.clearRect(0, 0, size, size)

      // núcleo: escurece o centro e dá volume
      const core = ctx.createRadialGradient(c, c, R * 0.1, c, c, R * 1.05)
      core.addColorStop(0, 'rgba(4,14,40,0.0)')
      core.addColorStop(0.75, 'rgba(10,40,110,0.18)')
      core.addColorStop(1, 'rgba(30,110,255,0.0)')
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(c, c, R * 1.05, 0, Math.PI * 2)
      ctx.fill()

      ctx.globalCompositeOperation = 'lighter'
      const amp = look.amp * (1 + lvl * 2.4)
      const pts = new Float32Array((N + 1) * 2)

      ribbons.forEach((rb, ri) => {
        for (let s = 0; s < rb.strands; s++) {
          const off = (s - rb.strands / 2) * 0.012
          for (let i = 0; i <= N; i++) {
            const th = (i / N) * Math.PI * 2
            let d = 0
            for (const h of rb.harm) d += h.a * Math.sin(h.k * th + h.p + t * h.w * 2 + s * 0.35)
            const rr = R * (rb.r + off + d * amp)
            const a = th + t * rb.spin
            pts[i * 2] = c + Math.cos(a) * rr
            pts[i * 2 + 1] = c + Math.sin(a) * rr
          }
          const hue = rb.hue + look.hue
          const alpha = (0.16 + 0.22 * lvl) * look.glow
          ctx.beginPath()
          ctx.moveTo(pts[0], pts[1])
          for (let i = 1; i <= N; i++) ctx.lineTo(pts[i * 2], pts[i * 2 + 1])
          // halo largo e fraco, depois o fio fino e claro
          ctx.lineWidth = 7
          ctx.strokeStyle = `hsla(${hue}, 100%, 55%, ${alpha * 0.16})`
          ctx.stroke()
          ctx.lineWidth = 1.1
          ctx.strokeStyle = `hsla(${hue}, 100%, ${70 + lvl * 15}%, ${alpha + 0.12})`
          ctx.stroke()

          // faíscas que correm pelas fitas
          if (!reduce && s === 0) {
            for (let k = 0; k < 2; k++) {
              const u = (t * (0.07 + ri * 0.011) + k * 0.5 + ri * 0.13) % 1
              const idx = Math.floor(u * N)
              const x = pts[idx * 2]
              const y = pts[idx * 2 + 1]
              const sr = 10 + lvl * 14
              const g = ctx.createRadialGradient(x, y, 0, x, y, sr)
              g.addColorStop(0, `hsla(${hue}, 100%, 88%, ${0.55 * look.glow})`)
              g.addColorStop(1, 'hsla(210, 100%, 60%, 0)')
              ctx.fillStyle = g
              ctx.fillRect(x - sr, y - sr, sr * 2, sr * 2)
            }
          }
        }
      })
      ctx.globalCompositeOperation = 'source-over'
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [live])

  return <canvas ref={canvas} className="orb" aria-hidden="true" />
}
