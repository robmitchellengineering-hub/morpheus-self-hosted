import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { C, isYou } from './deckConstants';
import { pillBtn, ghostBtn, miniInput, MicField, MicTextarea } from './DeckUI';

// 2026-09-17: Command Deck opened up to every signed-in account tonight,
// but that fix was deliberately minimal — a new user still landed on a
// bare dashboard with no explanation of what this is, a header telling
// them to "set up your business," and their one seeded person literally
// named "You." No first-run pattern existed anywhere in the app to reuse.
// One compact modal, not a wizard: everything it writes already goes
// through saveBusinessProfile/updatePersonName — the exact same actions
// DeckSettings.jsx's own BusinessProfileForm/people-manager already use —
// so this is a second, friendlier UI over already-shipped plumbing, not
// new backend surface.
export default function DeckWelcomeModal({ onDismiss }) {
  const { businessProfile, saveBusinessProfile, businessProfileBusy, people, updatePersonName } = useCommandDeck();
  const self = people.find(isYou);
  const [yourName, setYourName] = useState(self?.name && self.name !== 'You' ? self.name : '');
  const [shopName, setShopName] = useState('');
  const [tagline, setTagline] = useState('');
  const [businessContext, setBusinessContext] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    if (self && yourName.trim() && yourName.trim() !== self.name) {
      updatePersonName(self.id, yourName.trim());
    }
    if (shopName.trim() || tagline.trim() || businessContext.trim()) {
      await saveBusinessProfile({
        shop_name: shopName.trim(),
        tagline: tagline.trim(),
        business_context: businessContext.trim(),
      });
    }
    setSaving(false);
    onDismiss();
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(28,19,11,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200, padding: '1.5rem' }}
    >
      <div style={{ background: C.paper, borderRadius: 18, padding: '1.5rem 1.4rem', maxWidth: 420, width: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 12px 50px rgba(0,0,0,0.45)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <Sparkles size={18} color={C.brass} />
          <h2 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 600, color: C.walnut }}>Welcome to your Deck</h2>
        </div>
        <p style={{ margin: '0 0 1.1rem', fontSize: '0.85rem', color: C.walnutSoft, lineHeight: 1.5 }}>
          This is your own private life-and-business dashboard — brain dumps, tasks, notes, whatever you connect. Jarvis reads all of it and helps you keep on track. A couple of quick things so it actually feels like yours:
        </p>

        <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 600, color: C.walnutSoft, marginBottom: '0.3rem' }}>Your name</label>
        <MicField value={yourName} onChange={setYourName} placeholder="What should Jarvis call you?" style={{ ...miniInput, width: '100%', boxSizing: 'border-box' }} />

        <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 600, color: C.walnutSoft, margin: '0.9rem 0 0.3rem' }}>What should we call your dashboard?</label>
        <MicField value={shopName} onChange={setShopName} placeholder="e.g. your name, your business, whatever fits" style={{ ...miniInput, width: '100%', boxSizing: 'border-box' }} />

        <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 600, color: C.walnutSoft, margin: '0.9rem 0 0.3rem' }}>One line about it</label>
        <MicField value={tagline} onChange={setTagline} placeholder="Optional — shown under the name" style={{ ...miniInput, width: '100%', boxSizing: 'border-box' }} />

        <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 600, color: C.walnutSoft, margin: '0.9rem 0 0.3rem' }}>Tell Jarvis about yourself</label>
        <MicTextarea
          value={businessContext}
          onChange={setBusinessContext}
          placeholder="Your work, your goals, anything worth knowing when Jarvis is helping you decide what matters"
          rows={3}
          style={miniInput}
        />

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.3rem' }}>
          <button onClick={save} disabled={saving || businessProfileBusy} style={{ ...pillBtn(C.brass), flex: 1, padding: '0.65rem', opacity: saving || businessProfileBusy ? 0.7 : 1 }}>
            {saving || businessProfileBusy ? 'Saving…' : 'Save & start'}
          </button>
          <button onClick={onDismiss} style={{ ...ghostBtn, flex: '0 0 auto', padding: '0.65rem 0.9rem', fontSize: '0.8rem', color: C.walnutSoft, border: `1px solid ${C.line}`, borderRadius: 999 }}>
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
