import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Admin } from './admin/Admin'
import { Hud } from './hud/Hud'
import { Impressao } from './impressao/Impressao'
import { Memoria } from './memoria/Memoria'
import { Overlay } from './overlay/Overlay'
import { Setup } from './setup/Setup'
import { Site } from './site/Site'
import './hud/hud.css'
import './hud/widgets.css'

// /          HUD (a esfera e a conversa)
// /overlay   camada transparente sobre a tela (cartões, mãos, esfera que voa); uma por monitor
// /setup     configuração inicial
// /memoria  mapa da memória (estilo Obsidian)
// /admin/... painel de ajustes
// /site      site com login (servido pela portaria na VPS): launcher, contas, Telegram
// /impressao cartão ou relatório para virar imagem/PDF (Telegram)
const path = location.pathname
const page = path.startsWith('/site') ? <Site /> : path.startsWith('/impressao') ? <Impressao /> : path.startsWith('/admin') ? <Admin /> : path.startsWith('/memoria') ? <Memoria /> : path.startsWith('/overlay') ? <Overlay /> : path.startsWith('/setup') ? <Setup /> : <Hud />

if (path.startsWith('/admin')) document.title = 'Jarvis · Painel'
else if (path.startsWith('/setup')) document.title = 'Jarvis · Configuração'
else if (path.startsWith('/memoria')) document.title = 'Jarvis · Memória'

createRoot(document.getElementById('root')!).render(<StrictMode>{page}</StrictMode>)
