// Vídeo da câmera (do núcleo, em MJPEG) com o esqueleto das mãos desenhado por cima, sem passar pelo React.
// O vídeo e os pontos chegam espelhados, como num espelho.

import { useEffect, useRef, useState } from 'react'
import { handStore, useHands } from '../lib/live'
import './camera.css'

const LINKS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
]

export function CameraView({ on, video = true, label = true }: { on: boolean; video?: boolean; label?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [falhou, setFalhou] = useState(false)
  const [chave, setChave] = useState(0)
  useEffect(() => {
    setFalhou(false)
    setChave((k) => k + 1) // religou a câmera: abre o vídeo de novo
  }, [on])
  useEffect(
    () =>
      handStore.subscribe(() => {
        const cv = ref.current
        if (!cv) return
        const w = cv.clientWidth
        const h = cv.clientHeight
        const dpr = Math.min(2, devicePixelRatio || 1)
        if (cv.width !== Math.round(w * dpr)) {
          cv.width = Math.round(w * dpr)
          cv.height = Math.round(h * dpr)
        }
        const ctx = cv.getContext('2d')!
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        const { hands, pts } = handStore.get()
        ctx.clearRect(0, 0, w, h)
        pts.forEach((p, i) => {
          const pinch = hands[i]?.pinch
          ctx.strokeStyle = pinch ? '#ffffff' : 'rgb(95 212 255 / 0.95)'
          ctx.lineWidth = 1.8
          ctx.beginPath()
          for (const [a, b] of LINKS) {
            ctx.moveTo(p[a][0] * w, p[a][1] * h)
            ctx.lineTo(p[b][0] * w, p[b][1] * h)
          }
          ctx.stroke()
          ctx.fillStyle = pinch ? '#fff' : '#5fd4ff'
          for (const k of [4, 8]) {
            ctx.beginPath()
            ctx.arc(p[k][0] * w, p[k][1] * h, 3, 0, Math.PI * 2)
            ctx.fill()
          }
        })
      }),
    [],
  )
  const { hands } = useHands()
  return (
    <div className="camview">
      {on && video && !falhou && <img key={chave} src={`/api/camera/ao-vivo?k=${chave}`} alt="" onError={() => setFalhou(true)} />}
      {!on && <p className="camview-off">Câmera desligada</p>}
      <canvas ref={ref} />
      {label && on && (
        <span>{hands.length ? `${hands.length === 2 ? 'Duas mãos' : 'Mão'}${hands.some((h) => h.pinch) ? ' · pinça' : ''}` : 'Procurando a mão'}</span>
      )}
    </div>
  )
}
