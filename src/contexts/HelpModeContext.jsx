import { createContext, useContext, useState, useCallback } from 'react';

const HelpModeContext = createContext(null);

const STORAGE_KEY = 'morpheus_help_mode';

export function HelpModeProvider({ children }) {
  const [helpMode, setHelpMode] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  });
  // Tracks which hints have been dismissed this help session. Reset whenever
  // help mode is toggled back on so every feature re-explains itself.
  const [seenHints, setSeenHints] = useState(new Set());

  const toggleHelpMode = useCallback(() => {
    setHelpMode(prev => {
      const next = !prev;
      try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch {}
      if (next) setSeenHints(new Set());
      return next;
    });
  }, []);

  const markSeen = useCallback((id) => {
    setSeenHints(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  return (
    <HelpModeContext.Provider value={{ helpMode, toggleHelpMode, seenHints, markSeen }}>
      {children}
    </HelpModeContext.Provider>
  );
}

export function useHelpMode() {
  const ctx = useContext(HelpModeContext);
  if (!ctx) return { helpMode: false, toggleHelpMode: () => {}, seenHints: new Set(), markSeen: () => {} };
  return ctx;
}