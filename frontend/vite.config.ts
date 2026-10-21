import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Em desenvolvimento o Vite repassa API e WebSocket para o backend (porta 8000).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000',
      '/health': 'http://localhost:8000',
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
})
