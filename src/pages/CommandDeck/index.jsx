import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { X } from 'lucide-react';
import { CommandDeckProvider, useCommandDeck } from '@/contexts/CommandDeckContext';
import { DeckGoogleConnectionProvider } from '@/contexts/DeckGoogleConnectionContext';
import DeckTabBar from './DeckTabBar';
import { C } from './deckConstants';
import { pillBtn } from './DeckUI';

// Command Deck's layout shell: theme swap, shared data provider, header,
// the four tab pages via <Outlet/>, and the bottom tab bar. Replaces the
// old single-file CommandDeck.jsx — see src/pages/CommandDeck/DeckHome.jsx,
// DeckJarvis.jsx, DeckTools.jsx, DeckSettings.jsx for the actual tab content.
export default function CommandDeckLayout() {
  // Tweed & Walnut is a deliberate departure from Morpheus's own Matrix
  // theme — swap the html[data-theme] attribute while mounted, restore
  // whatever the user actually had set on unmount.
  useEffect(() => {
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'deck');
    return () => {
      if (prev === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', prev);
    };
  }, []);

  useEffect(() => {
    if (!document.getElementById('lexend-font-link')) {
      const link = document.createElement('link');
      link.id = 'lexend-font-link';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Lexend:wght@400;500;600;700&display=swap';
      document.head.appendChild(link);
    }
  }, []);

  return (
    <CommandDeckProvider>
      <DeckGoogleConnectionProvider>
        <CommandDeckShell />
      </DeckGoogleConnectionProvider>
    </CommandDeckProvider>
  );
}

function CommandDeckShell() {
  const { loaded, saveErr, lightboxImg, setLightboxImg, confirmDeleteState, resolveConfirmDelete, businessProfile } = useCommandDeck();

  // Falls back to the original hardcoded header text until a
  // DeckBusinessProfile exists — every account gets one via this feature's
  // own migration (Rob's backfilled with exactly this text), so this
  // fallback only ever matters for a genuinely fresh account mid-onboarding.
  const headerEyebrow = businessProfile?.shop_name
    ? `${businessProfile.shop_name}${businessProfile.tagline ? ` · ${businessProfile.tagline}` : ''}`
    : 'Valiant Music · Brunswick Heads / Murwillumbah';

  return (
    <div
      style={{
        minHeight: '100vh',
        background: C.tweed,
        backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(43,31,23,0.06) 1px, transparent 0)',
        backgroundSize: '14px 14px',
        color: C.ink,
        fontFamily: "'Lexend', sans-serif",
        paddingBottom: 'calc(4.2rem + env(safe-area-inset-bottom, 0px))',
      }}
    >
      <header
        style={{
          background: C.walnut,
          color: C.paper,
          padding: '1.5rem 1.25rem 1.75rem',
          borderBottom: `6px solid ${C.gold}`,
          borderRadius: '0 0 18px 18px',
        }}
      >
        <div style={{ fontSize: '0.68rem', letterSpacing: '0.18em', color: C.brassLight, textTransform: 'uppercase', marginBottom: '0.35rem' }}>
          {headerEyebrow}
        </div>
        <h1 style={{ fontWeight: 600, fontSize: '1.9rem', margin: 0, letterSpacing: '-0.01em' }}>Command Deck</h1>
        <p style={{ margin: '0.35rem 0 0', fontSize: '0.85rem', color: 'rgba(246,240,223,0.75)' }}>
          One thing at a time. Everything else lives here, not in your head.
        </p>
      </header>

      <main style={{ padding: '1.1rem 1rem 0', maxWidth: 620, margin: '0 auto' }}>
        <Outlet />
        <p style={{ textAlign: 'center', fontSize: '0.7rem', color: C.walnutSoft, opacity: 0.6, marginTop: '1.5rem' }}>
          {loaded ? 'Saved automatically, just for you.' : 'Loading your deck…'}
          {saveErr && " · couldn't save last change — try again"}
        </p>
      </main>

      {lightboxImg && (
        <div
          onClick={() => setLightboxImg(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(28,19,11,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1.5rem', cursor: 'zoom-out' }}
        >
          <img src={lightboxImg} alt="Full size" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 12, boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }} />
          <button
            onClick={() => setLightboxImg(null)}
            style={{ position: 'absolute', top: '1.2rem', right: '1.2rem', width: 36, height: 36, borderRadius: '50%', background: 'rgba(246,240,223,0.15)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <X size={18} color={C.paper} />
          </button>
        </div>
      )}

      {confirmDeleteState && (
        <div
          onClick={() => resolveConfirmDelete(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(28,19,11,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, padding: '1.5rem' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: C.paper, borderRadius: 16, padding: '1.3rem 1.2rem', maxWidth: 340, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,0.4)' }}
          >
            <p style={{ margin: '0 0 1.1rem', fontSize: '0.95rem', color: C.ink, lineHeight: 1.5 }}>{confirmDeleteState.message}</p>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button onClick={() => resolveConfirmDelete(true)} style={{ ...pillBtn(C.alert), flex: 1, padding: '0.6rem' }}>Delete it</button>
              <button onClick={() => resolveConfirmDelete(false)} style={{ ...pillBtn(C.walnutSoft), flex: 1, padding: '0.6rem' }}>Never mind</button>
            </div>
          </div>
        </div>
      )}

      <DeckTabBar />
    </div>
  );
}
