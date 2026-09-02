import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

// Apply the saved theme before first paint so there's no flash of the
// default "Clear" theme before switching to "Classic Matrix" or "Boring"
// (see src/contexts/ThemeContext.jsx, which keeps this in sync afterward).
// Also applies Boring's own saved light/dark sub-mode (2026-09-02) the same
// way, so a Boring+Light user doesn't see a flash of dark Boring first.
try {
  const savedTheme = localStorage.getItem('morpheus_theme');
  if (savedTheme === 'classic' || savedTheme === 'boring') {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }
  const savedBoringMode = localStorage.getItem('morpheus_boring_mode');
  document.documentElement.setAttribute('data-boring-mode', savedBoringMode === 'light' ? 'light' : 'dark');
} catch {}

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
