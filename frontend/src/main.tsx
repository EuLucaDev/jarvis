import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Hud } from './hud/Hud'
import './hud/hud.css'

// Fase 4 adiciona /admin e Fase 5 as telas extras (/tela/:id). Por enquanto tudo abre o HUD.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Hud />
  </StrictMode>,
)
