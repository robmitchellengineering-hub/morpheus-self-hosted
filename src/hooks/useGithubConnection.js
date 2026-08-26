import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';

const GITHUB_CONNECTOR_ID = '6a8785ad122b26c1461f0f6c';

export function useGithubConnection() {
  const [connected, setConnected] = useState(false);
  const [login, setLogin] = useState(null);
  const [loading, setLoading] = useState(true);

  const check = useCallback(async () => {
    try {
      const res = await base44.functions.invoke('checkGithubConnection', {});
      if (res.data?.connected) {
        setConnected(true);
        setLogin(res.data.login);
      } else {
        setConnected(false);
        setLogin(null);
      }
    } catch {
      setConnected(false);
      setLogin(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    base44.auth.isAuthenticated().then(async (authed) => {
      if (authed) {
        await check();
      } else {
        setLoading(false);
      }
    });
  }, [check]);

  const connect = useCallback(async () => {
    const url = await base44.connectors.connectAppUser(GITHUB_CONNECTOR_ID);
    const popup = window.open(url, '_blank');
    const timer = setInterval(() => {
      if (!popup || popup.closed) {
        clearInterval(timer);
        check();
      }
    }, 500);
  }, [check]);

  const disconnect = useCallback(async () => {
    await base44.connectors.disconnectAppUser(GITHUB_CONNECTOR_ID);
    setConnected(false);
    setLogin(null);
  }, []);

  return { connected, login, loading, connect, disconnect, check };
}