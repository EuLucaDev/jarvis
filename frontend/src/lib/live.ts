// Sinais que mudam 20 a 30 vezes por segundo (fase e nível da voz, mãos) ficam fora do React: quem
// desenha (Aura, espectro, cursor) lê direto daqui a cada quadro, sem re-renderizar a tela inteira.

import { useSyncExternalStore } from 'react'

export type Phase = 'espera' | 'ouvindo' | 'pensando' | 'falando'

// ax/ay: onde o ponteiro estava logo antes da pinça (o clique cai ali, não onde os dedos se mexeram)
export type Hand = {
  key: string; x: number; y: number; pinch: boolean; spread: number; pose: string; palm: [number, number]
  /** força da pinça 0..1 (o cursor fecha), palma virada para a pessoa, giro do punho em graus, mão fechada */
  forca?: number; costas?: boolean; torcao?: number; micro?: boolean
  /** medidas cruas para a calibração: abertura da pinça (em tamanhos de mão), lado da palma, ponto na câmera */
  cal?: { d: number; frente: number; cx: number; cy: number }
  ax?: number; ay?: number; gx?: number; gy?: number; gax?: number; gay?: number }

function store<T>(initial: T) {
  let value = initial
  const subs = new Set<() => void>()
  return {
    get: () => value,
    set(v: T) {
      value = v
      subs.forEach((s) => s())
    },
    subscribe(cb: () => void) {
      subs.add(cb)
      return () => {
        subs.delete(cb)
      }
    },
  }
}

/** Voz: fase e nível (0..1) mandados pelo núcleo. */
export const voiceStore = store<{ fase: Phase; nivel: number; ouvindo: number }>({ fase: 'espera', nivel: 0, ouvindo: 0 })

/** Mãos pela câmera: posição já na tela (0..1), pinça, abertura e o esqueleto para a prévia. */
export const handStore = store<{ hands: Hand[]; pts: number[][][] }>({ hands: [], pts: [] })

export const useVoice = () => useSyncExternalStore(voiceStore.subscribe, voiceStore.get)
export const useHands = () => useSyncExternalStore(handStore.subscribe, handStore.get)

/** Só a fase (muda poucas vezes): re-renderiza quando troca, não a cada nível. */
export function usePhase(): Phase {
  return useSyncExternalStore(voiceStore.subscribe, () => voiceStore.get().fase)
}
