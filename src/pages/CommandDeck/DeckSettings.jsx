import { useState } from 'react';
import { Download, Check, XCircle, Loader2, Mail, Calendar, HardDrive, FileText, UploadCloud, DownloadCloud, AlertTriangle } from 'lucide-react';
import { usePwaInstall } from '@/hooks/usePwaInstall';
import { useDeckGoogleConnection } from '@/hooks/useDeckGoogleConnection';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
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
