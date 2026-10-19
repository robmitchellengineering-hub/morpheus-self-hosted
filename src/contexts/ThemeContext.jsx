import { createContext, useContext, useState, useCallback, useEffect } from 'react';

const ThemeContext = createContext(null);

const STORAGE_KEY = 'morpheus_theme';
const VALID_THEMES = ['clear', 'classic', 'boring'];

// Boring's own light/dark sub-toggle (2026-09-02, Rob's request) — separate
// from the three themes above since it only ever applies within Boring:
// flips Boring's black background to white and its grey text to near-black.
// See index.css's [data-theme="boring"][data-boring-mode="light"] block.
const BORING_MODE_KEY = 'morpheus_boring_mode';
const VALID_BORING_MODES = ['dark', 'light'];

// 'clear' = new default (higher-contrast green, visible borders, colored
// status accents). 'classic' = the original pure-#00ff41-on-black look.
// 'boring' = plain black/grey look with green accents (Feature Backlog Tier
// 4 #7) for users the Matrix aesthetic puts off — see index.css's
// [data-theme="boring"] block for the (dark, default) palette, and the
// [data-boring-mode="light"] block below it for the light variant.
export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return VALID_THEMES.includes(stored) ? stored : 'clear';
    } catch { return 'clear'; }
  });

  const [boringMode, setBoringModeState] = useState(() => {
    try {
      const stored = localStorage.getItem(BORING_MODE_KEY);
      return VALID_BORING_MODES.includes(stored) ? stored : 'dark';
    } catch { return 'dark'; }
  });

  // Keep <html data-theme="..."> and data-boring-mode="..." in sync.
  // main.jsx also sets both synchronously before first paint (from
  // localStorage) so there's no flash of the wrong theme/mode on load;
  // this effect keeps them correct whenever the user changes either live
  // from Settings. data-boring-mode is harmless to leave set when a
  // different theme is active -- the CSS override only ever matches when
  // data-theme="boring" is also present.
  useEffect(() => {
    if (theme === 'classic' || theme === 'boring') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-boring-mode', boringMode);
  }, [boringMode]);

  const setTheme = useCallback((next) => {
    const value = VALID_THEMES.includes(next) ? next : 'clear';
    setThemeState(value);
    try { localStorage.setItem(STORAGE_KEY, value); } catch { /* ignore */ }
  }, []);

  const setBoringMode = useCallback((next) => {
    const value = VALID_BORING_MODES.includes(next) ? next : 'dark';
    setBoringModeState(value);
    try { localStorage.setItem(BORING_MODE_KEY, value); } catch { /* ignore */ }
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, boringMode, setBoringMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) return { theme: 'clear', setTheme: () => {}, boringMode: 'dark', setBoringMode: () => {} };
  return ctx;
}
