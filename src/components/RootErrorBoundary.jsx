import { Component } from 'react';

// Rob, 2026-09-17: "the above blanking out needed a refresh... page
// transitions system wide need to be looked at" — traced one real cause
// (a Date object where Command Deck's Murbah date field expected a string,
// crashing the whole render tree on the very next paint) but the deeper
// problem is that nothing in this app ever caught a render error at all:
// ANY uncaught error anywhere below this point took the entire page to a
// blank white screen, with no way back except a manual reload. This is the
// generic safety net — it doesn't fix a bug's root cause, but it turns
// "blank page, no idea what happened" into a real, recoverable screen.
export default class RootErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[RootErrorBoundary] caught a render error:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
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
        <p style={{ fontSize: '1.1rem', margin: 0 }}>Something broke on this screen.</p>
        <p style={{ fontSize: '0.85rem', opacity: 0.65, margin: 0, maxWidth: 420 }}>
          {this.state.error?.message || 'An unexpected error occurred.'}
        </p>
        <button
          onClick={() => window.location.reload()}
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
          Reload
        </button>
      </div>
    );
  }
}
