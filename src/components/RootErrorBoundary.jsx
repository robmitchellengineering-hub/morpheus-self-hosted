import { Component } from 'react';
import { isStaleChunkError, recoverFromStaleChunk } from '@/lib/staleChunk';

// Rob, 2026-09-17: "the above blanking out needed a refresh... page
// transitions system wide need to be looked at" — traced one real cause
// (a Date object where Command Deck's Murbah date field expected a string,
// crashing the whole render tree on the very next paint) but the deeper
// problem is that nothing in this app ever caught a render error at all:
// ANY uncaught error anywhere below this point took the entire page to a
// blank white screen, with no way back except a manual reload. This is the
// generic safety net — it doesn't fix a bug's root cause, but it turns
// "blank page, no idea what happened" into a real, recoverable screen.
//
// 2026-09-28, Rob: "Im also getting this alot in the first stages of morpheus — Something broke on
// this screen. Failed to fetch dynamically imported module: .../Workspace-Dp8wM2AG.js". That is not
// a bug at all: the page is holding the previous deploy's chunk names, and one reload fixes it. The
// boundary treated it identically to a real crash, which is why a routine deploy looked like the app
// breaking. It now recognises that case, says so, and recovers once by itself (lib/staleChunk.js
// holds the classification and the once-only rule).
export default class RootErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, stale: false };
  }

  static getDerivedStateFromError(error) {
    return { error, stale: isStaleChunkError(error) };
  }

  componentDidCatch(error, info) {
    console.error('[RootErrorBoundary] caught a render error:', error, info?.componentStack);
    if (isStaleChunkError(error)) {
      // Reload once; if a reload already happened inside the cooldown window this declines, and the
      // fallback below explains it instead of looping.
      recoverFromStaleChunk({ storage: window.sessionStorage, reload: () => window.location.reload() });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    const stale = this.state.stale;
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1rem',
          padding: '2rem',
          textAlign: 'center',
          background: '#0a0a0a',
          color: '#e5e5e5',
          fontFamily: 'monospace',
        }}
      >
        <p style={{ fontSize: '1.1rem', margin: 0 }}>
          {stale ? 'Morpheus was updated while this page was open.' : 'Something broke on this screen.'}
        </p>
        <p style={{ fontSize: '0.85rem', opacity: 0.65, margin: 0, maxWidth: 420 }}>
          {stale
            // Naming the cause and the action. The raw message ("Failed to fetch dynamically
            // imported module: ...") reads as a fault in the app; it is a stale file list.
            ? 'One reload fetches the current version — nothing is wrong with your data.'
            : (this.state.error?.message || 'An unexpected error occurred.')}
        </p>
        <button
          onClick={() => {
            if (stale) recoverFromStaleChunk({ storage: window.sessionStorage, reload: () => window.location.reload() });
            else window.location.reload();
          }}
          style={{
            padding: '0.6rem 1.4rem',
            border: '1px solid #00ff41',
            color: '#00ff41',
            background: 'transparent',
            borderRadius: 6,
            cursor: 'pointer',
            fontFamily: 'monospace',
            fontSize: '0.9rem',
          }}
        >
          {stale ? 'Load the new version' : 'Reload'}
        </button>
        {stale && (
          // The technical detail is kept, one line down, for a bug report — but it is no longer the
          // headline the operator is left to interpret.
          <p style={{ fontSize: '0.7rem', opacity: 0.4, margin: 0, maxWidth: 520 }}>
            {this.state.error?.message}
          </p>
        )}
      </div>
    );
  }
}
