import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Admin } from './admin/Admin'
import { Hud } from './hud/Hud'
import { Overlay } from './overlay/Overlay'
import { Tela } from './tela/Tela'
import './hud/hud.css'
import './tela/tela.css'

// /           HUD com a esfera (monitor principal)
// /tela/<id>  tela extra com widgets
// /admin/...  painel
// dentro do app Jarvis instalado: espaço para os botões da janela e barra superior arrastável
if ((window as unknown as { jarvisApp?: unknown }).jarvisApp) document.documentElement.classList.add('in-app')

const path = location.pathname
const tela = path.match(/^\/tela\/([^/]+)/)
// /overlay     camada transparente por cima da tela (só no app Jarvis instalado)
const page = path.startsWith('/admin') ? <Admin /> : path.startsWith('/overlay') ? <Overlay /> : tela ? <Tela id={decodeURIComponent(tela[1])} /> : <Hud />

if (path.startsWith('/admin')) document.title = 'Jarvis · Painel'
else if (tela) document.title = `Jarvis · ${tela[1]}`

createRoot(document.getElementById('root')!).render(<StrictMode>{page}</StrictMode>)
