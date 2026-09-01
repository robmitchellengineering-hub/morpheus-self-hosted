import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

// Apply the saved theme before first paint so there's no flash of the
// default "Clear" theme before switching to "Classic Matrix" or "Boring"
// (see src/contexts/ThemeContext.jsx, which keeps this in sync afterward).
try {
  const savedTheme = localStorage.getItem('morpheus_theme');
  if (savedTheme === 'classic' || savedTheme === 'boring') {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }
} catch {}

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
