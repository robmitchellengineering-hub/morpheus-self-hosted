import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import { clearStaleChunkMark, recoverFromStaleChunk } from '@/lib/staleChunk'

// ── A deploy does not have to look like a crash (2026-09-28) ────────────────
// Every route is a `lazy()` import and Vite names each chunk with a content hash, so a page left
// open across a deploy asks the CDN for a file that has been replaced. Vite reports that case as
// `vite:preloadError`; recovering from it is one reload, and the decision (and the once-only rule
// that stops a broken build becoming a reload loop) lives in lib/staleChunk.js. See that file for
// the full story — Rob hit this repeatedly on a day with several deploys.
window.addEventListener('vite:preloadError', (event) => {
  // Vite's default is to log the failure and let the import reject; this is the handling.
  event.preventDefault?.()
  const reloaded = recoverFromStaleChunk({ storage: window.sessionStorage, reload: () => window.location.reload() })
  console.warn(reloaded
    ? '[stale-chunk] a lazy route belonged to a previous deploy — reloading once'
    : '[stale-chunk] a lazy route is still missing after a reload — letting the error boundary report it')
})

// The app came up, so the build this page names IS being served: allow a later deploy its own
// recovery. After the cooldown, not immediately — the reload this guards against happens in the
// first paint.
window.setTimeout(() => clearStaleChunkMark(window.sessionStorage), 10_000)

// Apply the saved theme before first paint so there's no flash of the
// default "Clear" theme before switching to "Classic Matrix" or "Boring"
// (see src/contexts/ThemeContext.jsx, which keeps it in sync afterward).
// Also applies Boring's own saved light/dark sub-mode (2026-09-02) the same
// way, so a Boring+Light user doesn't see a flash of dark Boring first.
try {
  const savedTheme = localStorage.getItem('morpheus_theme');
  if (savedTheme === 'classic' || savedTheme === 'boring') {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }
  const savedBoringMode = localStorage.getItem('morpheus_boring_mode');
  document.documentElement.setAttribute('data-boring-mode', savedBoringMode === 'light' ? 'light' : 'dark');
} catch { /* ignore */ }

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
