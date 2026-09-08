import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import GithubDeviceModal from '@/components/matrix/GithubDeviceModal';

// Single source of truth for "is this user's GitHub account linked".
// Previously each useGithubConnection() call site (GithubGate,
// ConnectionsDialog, CapabilityStatus) held its own copy of this state and
// re-probed independently — they could and did drift out of sync. Now one
// provider owns the state and the device-flow modal, and the hook just
// reads it.
const GithubConnectionContext = createContext(null);

// device.phase: 'idle' | 'starting' | 'awaiting' | 'connecting' | 'error'
const IDLE_DEVICE = { phase: 'idle', userCode: null, verificationUri: null, error: null };

export function GithubConnectionProvider({ children }) {
  const [connected, setConnected] = useState(false);
  const [login, setLogin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [device, setDevice] = useState(IDLE_DEVICE);

  // Held across renders so cancel()/unmount can stop an in-flight poll loop.
  const pollRef = useRef({ cancelled: false });

  const check = useCallback(async () => {
    try {
      const res = await base44.functions.invoke('checkGithubConnection', {});
      if (res.data?.connected) {
        setConnected(true);
        setLogin(res.data.login);
        return true;
      }
      setConnected(false);
      setLogin(null);
      return false;
    } catch {
      setConnected(false);
      setLogin(null);
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

  const stopPolling = useCallback(() => {
    pollRef.current.cancelled = true;
  }, []);

  const cancelDevice = useCallback(() => {
    stopPolling();
    setDevice(IDLE_DEVICE);
  }, [stopPolling]);

  const runPollLoop = useCallback((pollToken, intervalSec) => {
    const session = { cancelled: false };
    pollRef.current = session;
    // GitHub returns `slow_down` if we poll faster than its stated interval;
    // sit one second above it so we never trip that.
    const intervalMs = (Math.max(2, Number(intervalSec) || 5) + 1) * 1000;

    const tick = async () => {
      if (session.cancelled) return;
      try {
        const out = await base44.connectors.githubDevicePoll(pollToken);
        if (session.cancelled) return;
        if (out.status === 'connected') {
          setDevice(IDLE_DEVICE);
          setConnected(true);
          setLogin(out.login);
          return;
        }
        // 'pending' — keep waiting.
        setTimeout(tick, intervalMs);
      } catch (err) {
        if (session.cancelled) return;
        const status = err?.data?.status;
        if (status === 'expired' || status === 'denied') {
          setDevice((d) => ({ ...d, phase: 'error', error: err.message }));
          return;
        }
        // Transient (network blip, 500) — back off once and retry rather
        // than dropping the user out of a flow they've already approved.
        setTimeout(tick, intervalMs * 2);
      }
    };

    setTimeout(tick, intervalMs);
  }, []);

  const connect = useCallback(async () => {
    stopPolling();
    setDevice({ ...IDLE_DEVICE, phase: 'starting' });
    try {
      const data = await base44.connectors.githubDeviceStart();
      setDevice({
        phase: 'awaiting',
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        error: null,
      });
      // Pop GitHub open right away; the modal also has a button to reopen it.
      try { window.open(data.verification_uri, '_blank', 'noopener'); } catch { /* popup blocked — modal button covers it */ }
      runPollLoop(data.poll_token, data.interval);
    } catch (err) {
      setDevice({ ...IDLE_DEVICE, phase: 'error', error: err.message });
    }
  }, [runPollLoop, stopPolling]);

  const disconnect = useCallback(async () => {
    stopPolling();
    try { await base44.connectors.disconnectAppUser(); } catch { /* already gone */ }
    setConnected(false);
    setLogin(null);
    setDevice(IDLE_DEVICE);
  }, [stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const value = { connected, login, loading, connect, disconnect, check, device };

  return (
    <GithubConnectionContext.Provider value={value}>
      {children}
      <GithubDeviceModal
        device={device}
        onCancel={cancelDevice}
        onRetry={connect}
      />
    </GithubConnectionContext.Provider>
  );
}

export function useGithubConnectionContext() {
  const ctx = useContext(GithubConnectionContext);
  if (!ctx) {
    // No provider (shouldn't happen in-app; keeps isolated component tests
    // and Storybook from crashing).
    return {
      connected: false, login: null, loading: false, device: IDLE_DEVICE,
      connect: () => {}, disconnect: () => {}, check: () => Promise.resolve(false),
    };
  }
  return ctx;
}
