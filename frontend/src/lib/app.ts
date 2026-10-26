// Ponte com o app Jarvis (Tauri). As páginas também abrem num navegador comum (desenvolvimento): aí as
// funções viram nada e a página segue funcionando.

type Tauri = {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
  event: { listen: (ev: string, cb: (e: { payload: any }) => void) => Promise<() => void> }
}

const T = (window as unknown as { __TAURI__?: Tauri }).__TAURI__

export const isApp = !!T

export type HudState = { modo: 'visivel' | 'minimizado' | 'oculto'; focused: boolean; bounds: { x: number; y: number; w: number; h: number } | null }

const call = (cmd: string, args?: Record<string, unknown>) => T?.core.invoke(cmd, args).catch(() => {})

export const app = {
  showHud: () => call('hud_mostrar'),
  minimize: () => call('hud_minimizar'),
  hide: () => call('hud_esconder'),
  openPanel: () => call('painel_abrir'),
  openMemory: (foco = '') => call('memoria_abrir', { foco }),
  openFinance: (pagina = '') => call('financeiro_abrir', { pagina }),
  setupDone: () => call('configuracao_pronta'),
  /** Áreas da camada que recebem o mouse (cartões, esfera do canto); o resto deixa o clique passar. */
  setHitRegions: (rects: { x: number; y: number; w: number; h: number }[]) => call('regioes', { rects }),
  onHud(cb: (s: HudState) => void) {
    T?.event.listen('hud-estado', (e) => cb(e.payload as HudState))
    call('hud_estado')?.then((s) => s && cb(s as HudState))
  },
}
