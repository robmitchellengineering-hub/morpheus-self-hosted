import { useState, useEffect, useCallback, useRef } from 'react';
import { Download, Check, XCircle, Loader2, Mail, Calendar, HardDrive, FileText, UploadCloud, DownloadCloud, AlertTriangle, Coins, X } from 'lucide-react';
import { usePwaInstall } from '@/hooks/usePwaInstall';
import { useDeckGoogleConnection } from '@/hooks/useDeckGoogleConnection';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { base44 } from '@/api/base44Client';
import { TOKEN_BLOCKS } from '@/lib/tokenBlocks';
import { startTokenCheckout } from '@/lib/purchaseCredits';
import { C } from './deckConstants';
import { Card, pillBtn } from './DeckUI';

// Install card, Command Deck's own Google connection (Gmail sync +
// suggested replies, Drive backup/restore), and Data vault status. Calendar
// sync and Doc creation are still coming; so is a Business details form.
export default function DeckSettings() {
  const { canInstall, installed, promptInstall } = usePwaInstall();
  const google = useDeckGoogleConnection();
  const {
    driveBackupBusy, driveBackupMsg, driveRestoreBusy, driveRestoreMsg, lastBackupAt,
    driveBackup, driveRestore,
  } = useCommandDeck();
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const backupStamp = lastBackupAt || google.lastBackupAt;

  return (
    <>
      <Card title="Install" sub="Command Deck as its own app — its own icon, opens straight here.">
        {installed ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', color: C.sage, fontWeight: 600 }}>
            <Check size={16} /> Installed
          </div>
        ) : canInstall ? (
          <button onClick={promptInstall} style={{ ...pillBtn(C.brass), width: '100%', padding: '0.6rem', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}>
            <Download size={15} /> Install Command Deck
          </button>
        ) : (
          <p style={{ margin: 0, fontSize: '0.78rem', color: C.walnutSoft }}>
            Not available in this browser yet — on a phone, use "Add to Home Screen" from the browser menu instead.
          </p>
        )}
      </Card>

      <UsageMeter />

      <Card title="Google" sub="Gmail sync, Calendar, Drive backup, and Doc creation — one connection, separate from Morpheus's own Google sign-in.">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
            {google.loading ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', color: C.walnutSoft }}>
                <Loader2 size={13} className="animate-spin" /> Checking…
              </span>
            ) : google.connected ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.78rem', color: C.sage, fontWeight: 600 }}>
                <Check size={14} /> Connected{google.email ? ` · ${google.email}` : ''}
              </span>
            ) : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.78rem', color: C.walnutSoft }}>
                <XCircle size={14} /> Not connected
              </span>
            )}
          </div>
          {google.connected ? (
            <button onClick={google.disconnect} style={{ ...pillBtn(C.oxblood) }}>Disconnect</button>
          ) : (
            <button onClick={google.connect} style={{ ...pillBtn(C.brass) }}>Connect Google</button>
          )}
        </div>

        {google.connected && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.8rem' }}>
            <ScopeRow icon={Mail} label="Gmail" sub="Sync into the Inbox card, draft & send replies." active />
            <ScopeRow icon={Calendar} label="Calendar" sub="Coming soon — Murbah booking sync." />
            <ScopeRow icon={HardDrive} label="Drive backup" sub="Below — one-click backup & restore." active />
            <ScopeRow icon={FileText} label="Docs" sub="Coming soon — Jarvis-drafted documents." />
          </div>
        )}
      </Card>

      {google.connected && (
        <Card title="Data vault" sub="A full copy of everything on the Deck, mirrored to your own Google Drive.">
          <div style={{ fontSize: '0.75rem', color: C.walnutSoft, marginBottom: '0.7rem' }}>
            {backupStamp ? `Last backed up ${new Date(backupStamp).toLocaleString()}.` : 'No backup yet.'}
          </div>

          <button
            onClick={driveBackup}
            disabled={driveBackupBusy}
            style={{ ...pillBtn(C.brass), width: '100%', padding: '0.6rem', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', opacity: driveBackupBusy ? 0.7 : 1 }}
          >
            {driveBackupBusy ? <Loader2 size={15} className="animate-spin" /> : <UploadCloud size={15} />}
            {driveBackupBusy ? 'Backing up…' : 'Back up to Drive now'}
          </button>
          {driveBackupMsg && <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: C.walnutSoft }}>{driveBackupMsg}</p>}

          <div style={{ height: 1, background: C.line, margin: '0.9rem 0' }} />

          {!confirmingRestore ? (
            <button
              onClick={() => setConfirmingRestore(true)}
              style={{ ...pillBtn(C.walnutSoft), width: '100%', padding: '0.6rem', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}
            >
              <DownloadCloud size={15} /> Restore from Drive
            </button>
          ) : (
            <div style={{ background: C.tweed, border: `1px solid ${C.alert}`, borderRadius: 10, padding: '0.7rem' }}>
              <p style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4rem', margin: 0, fontSize: '0.78rem', color: C.ink }}>
                <AlertTriangle size={15} color={C.alert} style={{ flexShrink: 0, marginTop: '0.1rem' }} />
                This replaces everything currently on the Deck with the last Drive backup. It cannot be undone.
              </p>
              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.6rem' }}>
                <button
                  onClick={async () => { await driveRestore(); setConfirmingRestore(false); }}
                  disabled={driveRestoreBusy}
                  style={{ ...pillBtn(C.alert), flex: 1, opacity: driveRestoreBusy ? 0.7 : 1 }}
                >
                  {driveRestoreBusy ? 'Restoring…' : 'Yes, replace everything'}
                </button>
                <button onClick={() => setConfirmingRestore(false)} disabled={driveRestoreBusy} style={{ ...pillBtn(C.walnutSoft), flex: 1 }}>Cancel</button>
              </div>
            </div>
          )}
          {driveRestoreMsg && <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: C.walnutSoft }}>{driveRestoreMsg}</p>}
        </Card>
      )}
    </>
  );
}

function ScopeRow({ icon: Icon, label, sub, active }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.4rem 0.1rem', opacity: active ? 1 : 0.55 }}>
      <Icon size={15} color={active ? C.brass : C.walnutSoft} style={{ flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: '0.72rem', color: C.walnutSoft }}>{sub}</div>
      </div>
    </div>
  );
}

// Same balance/buy-more logic as src/components/matrix/CreditBalance.jsx
// (that component's own comment already anticipated this exact reuse) —
// rebuilt with Deck's own Card/pillBtn instead of Morpheus's Matrix styling,
// but sharing the same credit_balance field, startTokenCheckout(blockIndex),
// and TOKEN_BLOCKS as the rest of the app. One shared balance across every
// AI feature (Morpheus builds, Jarvis chat, Gmail classification, etc.) —
// there's no separate Jarvis-only credit pool.
const POLL_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 2000;

function UsageMeter() {
  const [balance, setBalance] = useState(null);
  const [loadingBalance, setLoadingBalance] = useState(true);
  const [buyingIndex, setBuyingIndex] = useState(null);
  const [error, setError] = useState('');
  const [banner, setBanner] = useState(null); // { kind: 'success' | 'cancelled' }
  const pollRef = useRef(null);

  const fetchBalance = useCallback(async () => {
    try {
      const user = await base44.auth.me();
      setBalance(Number(user?.credit_balance ?? 0));
    } catch {
      // Not fatal — balance just won't render; the rest of Settings still works.
    } finally {
      setLoadingBalance(false);
    }
  }, []);

  useEffect(() => {
    fetchBalance();

    const params = new URLSearchParams(window.location.search);
    const credits = params.get('credits');
    if (credits === 'success' || credits === 'cancelled') {
      setBanner({ kind: credits });
      params.delete('credits');
      const cleanUrl = window.location.pathname + (params.toString() ? `?${params}` : '');
      window.history.replaceState({}, '', cleanUrl);
    }
    if (credits === 'success') {
      let attempts = 0;
      pollRef.current = setInterval(() => {
        attempts += 1;
        fetchBalance();
        if (attempts >= POLL_ATTEMPTS && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, POLL_INTERVAL_MS);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchBalance]);

  const buy = async (blockIndex) => {
    setError('');
    setBuyingIndex(blockIndex);
    try {
      await startTokenCheckout(blockIndex);
    } catch (e) {
      setError(e.message || 'Could not start checkout');
      setBuyingIndex(null);
    }
  };

  return (
    <Card title="Usage" sub="Every AI action across Morpheus and Jarvis draws from one shared credit balance — no subscription, no expiry.">
      {banner?.kind === 'success' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: C.tweedDark, borderRadius: 8, padding: '0.5rem 0.6rem', marginBottom: '0.7rem', fontSize: '0.78rem', color: C.sage }}>
          <Check size={14} /> Payment received — your balance updates within a few seconds.
        </div>
      )}
      {banner?.kind === 'cancelled' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: C.tweedDark, borderRadius: 8, padding: '0.5rem 0.6rem', marginBottom: '0.7rem', fontSize: '0.78rem', color: C.walnutSoft }}>
          <X size={14} /> Checkout cancelled — no charge was made.
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.9rem' }}>
        <Coins size={16} color={C.brass} />
        <span style={{ fontSize: '0.72rem', color: C.walnutSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Balance</span>
        {loadingBalance ? (
          <Loader2 size={14} className="animate-spin" color={C.walnutSoft} />
        ) : (
          <span style={{ fontSize: '1.1rem', fontWeight: 700, color: C.walnut }}>{balance != null ? balance.toFixed(2) : '—'} credits</span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.5rem' }}>
        {TOKEN_BLOCKS.map((block, i) => (
          <button
            key={block.credits}
            onClick={() => buy(i)}
            disabled={buyingIndex !== null}
            style={{
              textAlign: 'left', background: C.paper, border: `1.5px solid ${C.line}`, borderRadius: 10,
              padding: '0.6rem 0.7rem', cursor: buyingIndex !== null ? 'default' : 'pointer', opacity: buyingIndex !== null && buyingIndex !== i ? 0.5 : 1,
            }}
          >
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: C.walnut }}>{block.credits.toLocaleString()} credits</div>
            <div style={{ fontSize: '0.68rem', color: C.walnutSoft, marginTop: '0.15rem' }}>~${block.intendedNetUsd.toFixed(2)} + card fees</div>
            <div style={{ marginTop: '0.4rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', fontWeight: 600, color: C.brass }}>
              {buyingIndex === i ? <Loader2 size={12} className="animate-spin" /> : null}
              {buyingIndex === i ? 'Redirecting…' : 'Buy'}
            </div>
          </button>
        ))}
      </div>

      {error && <p style={{ margin: '0.6rem 0 0', fontSize: '0.75rem', color: C.alert }}>{error}</p>}
      <p style={{ margin: '0.6rem 0 0', fontSize: '0.68rem', color: C.walnutSoft }}>Secure checkout via Stripe.</p>
    </Card>
  );
}
