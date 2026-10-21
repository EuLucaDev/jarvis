import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Admin } from './admin/Admin'
import { Hud } from './hud/Hud'
import { Tela } from './tela/Tela'
import './hud/hud.css'

// /           HUD com a esfera (monitor principal)
// /tela/<id>  tela extra com widgets
// /admin/...  painel
const path = location.pathname
const tela = path.match(/^\/tela\/([^/]+)/)
const page = path.startsWith('/admin') ? <Admin /> : tela ? <Tela id={decodeURIComponent(tela[1])} /> : <Hud />

if (path.startsWith('/admin')) document.title = 'Jarvis · Painel'
else if (tela) document.title = `Jarvis · ${tela[1]}`

createRoot(document.getElementById('root')!).render(<StrictMode>{page}</StrictMode>)
