import { CalendarRange, LockOpen, Radio, ScanFace, UserRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { distance, MATCH, openCamera, readFace } from '../lib/face'

// Presença: a câmera procura um rosto; se for o dono, desbloqueia as telas e, de manhã,
// abre o briefing sozinho. Tudo roda no navegador (face-api); só os descritores ficam salvos.

const STEPS = [
  { id: 'presenca', label: 'Presença detectada', icon: UserRound },
  { id: 'reconhecido', label: 'Reconhecimento facial', icon: ScanFace },
  { id: 'desbloqueado', label: 'Sistema desbloqueado', icon: LockOpen },
  { id: 'briefing', label: 'Briefing iniciado', icon: Radio },
  { id: 'panorama', label: 'Panorama do dia', icon: CalendarRange },
] as const

type Step = (typeof STEPS)[number]['id'] | 'idle'

export function Presence({
  enabled,
  onStep,
  onRecognized,
  onError,
}: {
  enabled: boolean
  onStep: (etapa: string) => void
  onRecognized: () => Promise<boolean> // devolve true se abriu o briefing
  onError: (msg: string | null) => void
}) {
  const [step, setStep] = useState<Step>('idle')
  const [show, setShow] = useState(false)
  const [name, setName] = useState('senhor')
  const video = useRef<HTMLVideoElement>(null)
  const busy = useRef(false)
  const sleepUntil = useRef(0)

  useEffect(() => {
    if (!enabled) return
    let stream: MediaStream | null = null
    let timer = 0
    let stopped = false
    let samples: number[][] = []

    const run = async () => {
      try {
        const r = await api<{ nome: string; descritores: number[][] }>('/api/rosto')
        samples = r.descritores
        setName(r.nome || 'senhor')
        if (!samples.length) {
          onError('Cadastre seu rosto em Painel → Presença para o reconhecimento funcionar.')
          return
        }
        stream = await openCamera(480)
        if (stopped) return
        const v = video.current!
        v.srcObject = stream
        await v.play()
        onError(null)
      } catch {
        onError('Não consegui abrir a câmera para a presença.')
        return
      }

      const tick = async () => {
        if (stopped) return
        if (!busy.current && Date.now() > sleepUntil.current && video.current) {
          busy.current = true
          try {
            const face = await readFace(video.current)
            if (face) {
              setShow(true)
              setStep((s) => (s === 'idle' ? 'presenca' : s))
              onStep('presenca')
              if (distance(face.descriptor, samples) < MATCH) {
                sleepUntil.current = Date.now() + 30 * 60 * 1000 // não repete por 30 min
                setStep('reconhecido')
                onStep('reconhecido')
                await wait(700)
                setStep('desbloqueado')
                await wait(700)
                const briefed = await onRecognized()
                if (briefed) {
                  setStep('briefing')
                  await wait(900)
                  setStep('panorama')
                }
                await wait(1800)
                setShow(false)
                setStep('idle')
              }
            }
          } finally {
            busy.current = false
          }
        }
        timer = window.setTimeout(tick, 900)
      }
      tick()
    }
    run()
    return () => {
      stopped = true
      clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [enabled, onStep, onRecognized, onError])

  const idx = STEPS.findIndex((s) => s.id === step)
  return (
    <>
      <video ref={video} className="presence-cam" muted playsInline aria-hidden="true" />
      {show && (
        <div className="presence" role="status">
          <div className="presence-text">
            <span className="presence-eyebrow">Briefing · Inteligente</span>
            <h2>
              {greeting()},
              <br />
              {step === 'presenca' ? 'senhor.' : `${name}.`}
            </h2>
            <ol>
              {STEPS.map((s, i) => (
                <li key={s.id} className={i <= idx ? 'done' : ''}>
                  <span>
                    <s.icon size={13} />
                  </span>
                  {s.label}
                </li>
              ))}
            </ol>
          </div>
          <div className={`face-frame ${idx >= 1 ? 'ok' : ''}`}>
            <ScanFace size={58} strokeWidth={1.2} />
            <small>{idx >= 1 ? 'Reconhecido' : 'Analisando'}</small>
          </div>
        </div>
      )}
    </>
  )
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'
}
