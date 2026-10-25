// Atualização do Jarvis: aviso discreto quando há versão nova no servidor e, ao aceitar, a sequência
// "Atualizando J.A.R.V.I.S." em tela cheia (anéis, etapas, progresso), até o sistema voltar na versão nova.

import { Download, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { play } from '../lib/sfx'

type Info = { versao: string; commit: string; disponivel: boolean; nova?: string; mudancas?: string[]; motivo?: string; app_muda?: boolean }
export type UpdateEvent = { etapa: string; pct: number; erro?: string; reiniciar?: boolean; app_muda?: boolean }

const DONE_KEY = 'jarvis.atualizado'
const app = (window as unknown as { jarvisApp?: { updateApp?: () => void } }).jarvisApp

export function Updater({ event }: { event: UpdateEvent | null }) {
  const [info, setInfo] = useState<Info | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState<string | null>(() => {
    try {
      const v = localStorage.getItem(DONE_KEY)
      localStorage.removeItem(DONE_KEY)
      return v
    } catch {
      return null
    }
  })

  // confere no servidor ao abrir e a cada 30 min
  useEffect(() => {
    const check = () => api<Info>('/api/atualizacao').then(setInfo).catch(() => {})
    const first = setTimeout(check, 8000)
    const t = setInterval(check, 30 * 60 * 1000)
    return () => {
      clearTimeout(first)
      clearInterval(t)
    }
  }, [])

  // "Atualizado" some sozinho
  useEffect(() => {
    if (!done) return
    play('unlock')
    const t = setTimeout(() => setDone(null), 4200)
    return () => clearTimeout(t)
  }, [done])

  // reiniciando: espera o servidor voltar e recarrega na versão nova
  useEffect(() => {
    if (!event?.reiniciar) return
    let alive = true
    const wait = async () => {
      await new Promise((r) => setTimeout(r, 2500))
      for (let i = 0; i < 90 && alive; i++) {
        try {
          const v = await api<{ versao: string }>('/api/versao')
          try {
            localStorage.setItem(DONE_KEY, v.versao)
          } catch {
            /* sem armazenamento */
          }
          if (event.app_muda) app?.updateApp?.()
          location.reload()
          return
        } catch {
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    }
    wait()
    return () => {
      alive = false
    }
  }, [event])

  const start = async () => {
    setRunning(true)
    play('start')
    await api('/api/atualizacao/aplicar', { method: 'POST' }).catch(() => setRunning(false))
  }

  const showScreen = running || (event && !event.erro && event.pct > 0)
  return (
    <>
      {info?.disponivel && !dismissed && !showScreen && (
        <div className="update-banner" role="status">
          <Download size={15} />
          <span>
            <b>Nova versão {info.nova}</b>
            {info.mudancas?.[0] && <small>{info.mudancas[0]}</small>}
          </span>
          <button className="chip-btn primary" onClick={start}>
            Atualizar o Jarvis
          </button>
          <button className="icon-btn" onClick={() => setDismissed(true)} aria-label="Depois">
            <X size={13} />
          </button>
        </div>
      )}
      {showScreen && <UpdateScreen etapa={event?.etapa ?? 'Preparando'} pct={event?.pct ?? 4} versao={info?.nova} mudancas={info?.mudancas ?? []} />}
      {event?.erro && running && (
        <div className="update-banner error" role="alert">
          <span>
            <b>A atualização não terminou</b>
            <small>{event.erro}</small>
          </span>
          <button className="icon-btn" onClick={() => setRunning(false)} aria-label="Fechar">
            <X size={13} />
          </button>
        </div>
      )}
      {done && (
        <div className="update-done" role="status">
          <span className="ud-ring" />
          <b>J.A.R.V.I.S. atualizado</b>
          <small>Versão {done} · todos os sistemas operacionais</small>
        </div>
      )}
    </>
  )
}

function UpdateScreen({ etapa, pct, versao, mudancas }: { etapa: string; pct: number; versao?: string; mudancas: string[] }) {
  return (
    <section className="update-screen" aria-live="polite">
      <div className="us-rings" aria-hidden="true">
        <i />
        <i />
        <i />
        <b>{Math.round(pct)}%</b>
      </div>
      <h2>Atualizando J.A.R.V.I.S.</h2>
      <p className="us-step">{etapa}…</p>
      <div className="us-bar" aria-hidden="true">
        <span style={{ width: `${Math.max(4, pct)}%` }} />
      </div>
      {versao && <small>Versão {versao}</small>}
      {mudancas.length > 0 && (
        <ul>
          {mudancas.slice(0, 4).map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
