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

// Command Deck installs as its own separate PWA (own name/icon/start_url —
// see deck.html + public/deck-manifest.json), which needs its own static
// HTML entry point distinct from index.html. In dev, Vite's own server
// doesn't know about Netlify's public/_redirects rewrite, so this plugin
// mirrors it: a request under /deck serves deck.html instead of index.html,
// same as production (see public/_redirects for the matching prod rule).
function deckHtmlDevMiddleware() {
  return {
    name: 'deck-html-dev-middleware',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url.split('?')[0];
        if (path === '/deck' || path.startsWith('/deck/')) req.url = '/deck.html';
        next();
      });
    },
  };
}

export default defineConfig({
  define: {
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString())
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  plugins: [react(), deckHtmlDevMiddleware()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        deck: path.resolve(__dirname, 'deck.html'),
      },
    },
  },
  server: {
    proxy: {
      '/api': { target: BACKEND_URL, changeOrigin: true },
      '/uploads': { target: BACKEND_URL, changeOrigin: true },
    },
  },
})
