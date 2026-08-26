import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Self-hosted build: the @base44/vite-plugin (app-id injection, HMR
// notifier, visual-edit agent — all Base44-hosted-platform features) is
// gone. What's left is a plain Vite + React SPA. In dev, /api and /uploads
// proxy to the Express backend (see server/.env's PORT) so the frontend dev
// server and API can run on different ports without CORS friction; in
// production these are usually served from the same origin behind nginx
// (see docker-compose.yml), where this proxy is simply unused.
const BACKEND_URL = process.env.VITE_BACKEND_URL || 'http://localhost:4500'

export default defineConfig({
  define: {
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString())
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: BACKEND_URL, changeOrigin: true },
      '/uploads': { target: BACKEND_URL, changeOrigin: true },
    },
  },
})
