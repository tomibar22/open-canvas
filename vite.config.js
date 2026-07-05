import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base '/open-canvas/' for GitHub Pages project sites; '/' locally.
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/open-canvas/' : '/',
  plugins: [react()],
  server: { port: 5173 },
})
