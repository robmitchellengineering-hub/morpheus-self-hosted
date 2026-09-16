import { Settings as SettingsIcon, Download, Check } from 'lucide-react';
import { usePwaInstall } from '@/hooks/usePwaInstall';
import { C } from './deckConstants';
import { Card, pillBtn } from './DeckUI';

// Google account sync, business details, and Data vault status — a later
// phase of the Command Deck Phase 2 build. The install card is real now:
// Command Deck has its own separate installable PWA (own manifest/icon/
// start_url — see deck.html + public/deck-manifest.json), distinct from
// installing Morpheus itself.
export default function DeckSettings() {
  const { canInstall, installed, promptInstall } = usePwaInstall();

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

      <Card title="Settings" sub="Google sync, business details, and Drive backup.">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6rem', padding: '1.5rem 0', color: C.walnutSoft }}>
          <SettingsIcon size={28} />
          <p style={{ margin: 0, fontSize: '0.85rem', textAlign: 'center' }}>Coming soon — Gmail/Calendar/Drive sync and business details are next.</p>
        </div>
      </Card>
    </>
  );
}
