import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => ({
  plugins: [react()],
  appType: 'spa',
  // Prod assets are served from /static/ by Flask, but routes themselves
  // (BrowserRouter, no basename) are plain (/annotator, not /static/annotator).
  // Only apply the /static/ prefix to the build output, not the dev server,
  // or client-side routes 404 in `npm run dev`.
  base: command === 'build' ? '/static/' : '/',
  server: {
    port: 5173,
    proxy: {
      '^/api/': {
        target: 'http://localhost:8501',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../static',
    emptyOutDir: true,
  },
}))
