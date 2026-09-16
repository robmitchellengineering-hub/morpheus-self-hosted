import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';

// Mirrors GoogleDriveConnectionContext.jsx's shape exactly, for Command
// Deck's own, separate Google connection (Gmail + Calendar + Drive backup +
// Docs) — see schema.prisma's DeckGoogleConnection comment for why the two
// are kept apart.
const DeckGoogleConnectionContext = createContext(null);

export function DeckGoogleConnectionProvider({ children }) {
  const [connected, setConnected] = useState(false);
  const [email, setEmail] = useState(null);
  const [loading, setLoading] = useState(true);

  const check = useCallback(async () => {
    try {
      const res = await base44.functions.invoke('checkDeckGoogleConnection', {});
      if (res.data?.connected) {
        setConnected(true);
        setEmail(res.data.email);
        return true;
      }
      setConnected(false);
      setEmail(null);
      return false;
    } catch {
      setConnected(false);
      setEmail(null);
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    base44.auth.isAuthenticated().then((authed) => {
      if (authed) check();
      else setLoading(false);
    });
  }, [check]);

  const connect = useCallback(async () => {
    const url = await base44.connectors.connectDeckGoogle();
    window.location.href = url;
  }, []);

  const disconnect = useCallback(async () => {
    try { await base44.connectors.disconnectDeckGoogle(); } catch { /* already gone */ }
    setConnected(false);
    setEmail(null);
  }, []);

  const value = { connected, email, loading, connect, disconnect, check };

  return (
    <DeckGoogleConnectionContext.Provider value={value}>
      {children}
    </DeckGoogleConnectionContext.Provider>
  );
}

export function useDeckGoogleConnectionContext() {
  const ctx = useContext(DeckGoogleConnectionContext);
  if (!ctx) {
    return {
      connected: false, email: null, loading: false,
      connect: () => {}, disconnect: () => {}, check: () => Promise.resolve(false),
    };
  }
  return ctx;
}
