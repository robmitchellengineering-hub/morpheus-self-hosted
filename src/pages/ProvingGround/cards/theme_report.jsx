import { useEffect, useState } from 'react';

// Theme report — shows the theme attribute actually applied to <html> and the
// browser's prefers-color-scheme preference. The theme can be 'clear'
// (attribute absent), 'classic', or 'boring'; a theme that fails to apply is
// visible here because the page's own background/colors come from that
// attribute.
export default function ThemeReport() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'clear');
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e) => setPrefersDark(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return (
    <div className="space-y-2">
      <p className="text-xs font-mono text-ink-strong font-bold">THEME REPORT</p>
      <p className="text-[11px] font-mono text-ink-max">
        data-theme: <span className="text-ink">{theme}</span>
      </p>
      <p className="text-[11px] font-mono text-ink-max">
        prefers-color-scheme: <span className="text-ink">{prefersDark ? 'dark' : 'light'}</span>
      </p>
    </div>
  );
}
