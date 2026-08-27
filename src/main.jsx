import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

// Apply the saved theme before first paint so there's no flash of the
// default "Clear" theme before switching to "Classic Matrix" (see
// src/contexts/ThemeContext.jsx, which keeps this in sync afterward).
try {
  if (localStorage.getItem('morpheus_theme') === 'classic') {
    document.documentElement.setAttribute('data-theme', 'classic');
  }
} catch {}

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
