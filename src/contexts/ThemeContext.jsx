import { createContext, useContext, useState, useCallback, useEffect } from 'react';

const ThemeContext = createContext(null);

const STORAGE_KEY = 'morpheus_theme';

// 'clear' = new default (higher-contrast green, visible borders, colored
// status accents). 'classic' = the original pure-#00ff41-on-black look.
export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === 'classic' ? 'classic' : 'clear'; } catch { return 'clear'; }
  });

  // Keep <html data-theme="..."> in sync. main.jsx also sets this
  // synchronously before first paint (from localStorage) so there's no
  // flash of the wrong theme on load; this effect keeps it correct
  // whenever the user changes it live from Settings.
  useEffect(() => {
    if (theme === 'classic') {
      document.documentElement.setAttribute('data-theme', 'classic');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, [theme]);

  const setTheme = useCallback((next) => {
    const value = next === 'classic' ? 'classic' : 'clear';
    setThemeState(value);
    try { localStorage.setItem(STORAGE_KEY, value); } catch {}
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) return { theme: 'clear', setTheme: () => {} };
  return ctx;
}
