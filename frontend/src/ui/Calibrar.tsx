// Calibração das mãos: o Jarvis aprende a sua mão e a sua câmera em cinco passos curtos, cada um avança sozinho
// quando a mão fica firme. Mede (com as medidas cruas que o núcleo manda em cada mão: hand.cal):
//   mão aberta, palma para a tela  → abertura normal da pinça e o lado "palma para a câmera"
//   pinça segurada                 → abertura com a pinça (os limites ficam entre as duas)
//   palma virada para você         → confirma o lado da palma (inverte se a câmera vê ao contrário)
//   cantos da tela                 → que pedaço da câmera vira a tela inteira
// Usado na configuração inicial e em Painel → Gestos → Recalibrar.

import { Check, Hand as HandIcon, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { handStore, type Hand } from '../lib/live'
import { JarvisSocket } from '../lib/socket'
import { CameraView } from './CameraView'
import './calibrar.css'

type Cal = NonNullable<Hand['cal']>
const AMOSTRAS = 30 // ~1 s de mão firme

const PASSOS = [
  { id: 'aberta', titulo: 'Mão aberta', texto: 'Levante a mão na altura do peito, aberta, com a palma virada para a tela.' },
  { id: 'pinca', titulo: 'Pinça', texto: 'Junte a ponta do polegar com a do indicador e segure.' },
  { id: 'palma', titulo: 'Palma para você', texto: 'Agora vire a mão: palma para o seu rosto, costas para a câmera.' },
  { id: 'canto1', titulo: 'Canto de cima', texto: 'Mão aberta de novo, palma para a tela: leve até onde for confortável apontar o canto de CIMA à ESQUERDA da tela, e segure.' },
  { id: 'canto2', titulo: 'Canto de baixo', texto: 'Agora o canto de BAIXO à DIREITA da tela, e segure.' },
] as const

const media = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)

export function Calibrar({ onFim, onPular }: { onFim?: () => void; onPular?: () => void }) {
  const [passo, setPasso] = useState(0)
  const [prog, setProg] = useState(0)
  const [aviso, setAviso] = useState('')
  const [fim, setFim] = useState(false)
  const amostras = useRef<Cal[]>([])
  const medidas = useRef<Record<string, Cal[]>>({})
  const ultimo = useRef<{ cx: number; cy: number } | null>(null)

  // conexão própria com o núcleo: na configuração inicial não há outra trazendo as mãos
  useEffect(() => {
    const s = new JarvisSocket('admin', { onEvent: () => {}, onOpen: () => {} })
    return () => s.close()
  }, [])

  useEffect(() => {
    if (fim) return
    amostras.current = []
    ultimo.current = null
    setProg(0)
    const p = PASSOS[passo]
    return handStore.subscribe(() => {
      const h = handStore.get().hands[0]
      if (!h?.cal) {
        setAviso('Não vejo sua mão. Fique de frente para a câmera.')
        return
      }
      const c = h.cal
      // mão firme: quase parada desde a amostra anterior (nos cantos e na pinça, principalmente)
      const u = ultimo.current
      ultimo.current = { cx: c.cx, cy: c.cy }
      if (u && Math.hypot(c.cx - u.cx, c.cy - u.cy) > 0.02) {
        amostras.current = []
        setProg(0)
        setAviso('Segure parado…')
        return
      }
      const aberta = media((medidas.current.aberta ?? []).map((m) => m.d))
      if (p.id === 'pinca' && !(c.d < aberta * 0.55)) {
        amostras.current = []
        setProg(0)
        setAviso('Junte mais o polegar e o indicador')
        return
      }
      if ((p.id === 'aberta' || p.id.startsWith('canto')) && c.d < 0.45) {
        amostras.current = []
        setProg(0)
        setAviso('Abra a mão')
        return
      }
      setAviso('')
      amostras.current.push(c)
      setProg(amostras.current.length / AMOSTRAS)
      if (amostras.current.length >= AMOSTRAS) {
        medidas.current[p.id] = amostras.current
        if (passo + 1 < PASSOS.length) setPasso(passo + 1)
        else concluir()
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passo, fim])

  async function concluir() {
    const m = medidas.current
    const dAberta = media(m.aberta.map((x) => x.d))
    const dPinca = media(m.pinca.map((x) => x.d))
    const fCam = media(m.aberta.map((x) => x.frente))
    const fVoce = media(m.palma.map((x) => x.frente))
    const x0 = media(m.canto1.map((x) => x.cx))
    const y0 = media(m.canto1.map((x) => x.cy))
    const x1 = media(m.canto2.map((x) => x.cx))
    const y1 = media(m.canto2.map((x) => x.cy))
    // folga de 4% em cada lado e um mínimo de área, para os cantos não ficarem no limite do braço
    const larg = Math.max(0.25, Math.abs(x1 - x0))
    const alt = Math.max(0.25, Math.abs(y1 - y0))
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    const area = [cx - larg / 2 - 0.04, cx + larg / 2 + 0.04, cy - alt / 2 - 0.04, cy + alt / 2 + 0.04].map((v) => Math.min(1, Math.max(0, v)))
    await api('/api/maos/calibracao', {
      method: 'PUT',
      json: {
        fecha: dPinca + (dAberta - dPinca) * 0.3,
        abre: dPinca + (dAberta - dPinca) * 0.5,
        // "palma para você" tem que dar o lado positivo; se a câmera mediu ao contrário, inverte
        inverter_palma: fVoce < fCam,
        area,
      },
    })
    setFim(true)
    onFim?.()
  }

  const p = PASSOS[passo]
  return (
    <div className="calibrar">
      <div className="calibrar-video">
        <CameraView on label={false} />
      </div>
      {fim ? (
        <div className="calibrar-texto">
          <h3>
            <Check size={16} /> Pronto, aprendi a sua mão
          </h3>
          <p className="muted">Dá para refazer quando quiser em Painel → Gestos → Recalibrar.</p>
          <button
            className="ghost"
            onClick={() => {
              medidas.current = {}
              setFim(false)
              setPasso(0)
            }}
          >
            <RotateCcw size={14} /> Refazer
          </button>
        </div>
      ) : (
        <div className="calibrar-texto">
          <small className="calibrar-passo">
            Passo {passo + 1} de {PASSOS.length} · {p.titulo}
          </small>
          <h3>
            <HandIcon size={16} /> {p.texto}
          </h3>
          <div className="calibrar-barra" role="progressbar" aria-valuenow={Math.round(prog * 100)} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${Math.round(prog * 100)}%` }} />
          </div>
          <p className="muted">{aviso || 'Segure até a barra encher.'}</p>
          {onPular && (
            <button className="ghost" onClick={onPular}>
              Pular por agora
            </button>
          )}
        </div>
      )}
    </div>
  )
}
