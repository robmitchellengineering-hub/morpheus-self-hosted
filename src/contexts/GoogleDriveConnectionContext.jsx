import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';

// Mirrors GithubConnectionContext.jsx's role (one shared source of truth,
// not one copy per call site) but simpler: Drive connect is a plain
// redirect (connections.routes.js's Phase 1 scope has no device flow), so
// there's no poll loop or modal to own here.
const GoogleDriveConnectionContext = createContext(null);

export function GoogleDriveConnectionProvider({ children }) {
  const [connected, setConnected] = useState(false);
  const [email, setEmail] = useState(null);
  const [loading, setLoading] = useState(true);

  const check = useCallback(async () => {
    try {
      const res = await base44.functions.invoke('checkGoogleDriveConnection', {});
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
    const url = await base44.connectors.connectGoogleDrive();
    window.location.href = url;
  }, []);

  const disconnect = useCallback(async () => {
    try { await base44.connectors.disconnectGoogleDrive(); } catch { /* already gone */ }
    setConnected(false);
    setEmail(null);
  }, []);

  const value = { connected, email, loading, connect, disconnect, check };

  return (
    <GoogleDriveConnectionContext.Provider value={value}>
      {children}
    </GoogleDriveConnectionContext.Provider>
  );
}

export function useGoogleDriveConnectionContext() {
  const ctx = useContext(GoogleDriveConnectionContext);
  if (!ctx) {
    return {
      connected: false, email: null, loading: false,
      connect: () => {}, disconnect: () => {}, check: () => Promise.resolve(false),
    };
  }
  return ctx;
}
