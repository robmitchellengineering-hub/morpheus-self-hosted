import { Download, Check, XCircle, Loader2, Mail, Calendar, HardDrive, FileText } from 'lucide-react';
import { usePwaInstall } from '@/hooks/usePwaInstall';
import { useDeckGoogleConnection } from '@/hooks/useDeckGoogleConnection';
import { C } from './deckConstants';
import { Card, pillBtn } from './DeckUI';

// Install card, and Command Deck's own Google connection (Gmail sync +
// suggested replies now; Calendar/Drive backup/Docs land in a later
// phase — see the approved plan). Business details form and Data vault
// status are still coming.
export default function DeckSettings() {
  const { canInstall, installed, promptInstall } = usePwaInstall();
  const google = useDeckGoogleConnection();

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
            <ScopeRow icon={HardDrive} label="Drive backup" sub="Coming soon — one-click backup & restore." />
            <ScopeRow icon={FileText} label="Docs" sub="Coming soon — Jarvis-drafted documents." />
          </div>
        )}
      </Card>
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
