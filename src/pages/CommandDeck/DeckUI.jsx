import { C } from './deckConstants';

// Small presentational primitives shared across every Command Deck tab page
// (DeckHome, DeckJarvis, DeckTools, DeckSettings) — moved out of the old
// single-file CommandDeck.jsx unchanged.

export function Card({ title, sub, children, style = {}, titleColor = C.walnut, subColor }) {
  return (
    <section style={{ background: C.paper, border: `1.5px solid ${C.line}`, borderRadius: 16, padding: '1rem 1rem 1.1rem', marginTop: '0.9rem', boxShadow: '0 2px 0 rgba(28,19,11,0.06)', ...style }}>
      <h2 style={{ fontWeight: 600, fontSize: '1.08rem', margin: 0, color: titleColor }}>{title}</h2>
      {sub && <p style={{ margin: '0.2rem 0 0.8rem', fontSize: '0.78rem', color: subColor || C.walnutSoft, opacity: subColor ? 1 : 0.85 }}>{sub}</p>}
      {children}
    </section>
  );
}

export function RhythmRow({ day, what, tone }) {
  return (
    <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: tone, marginTop: '0.4rem', flexShrink: 0 }} />
      <div>
        <div style={{ fontSize: '0.68rem', fontWeight: 600, color: tone, letterSpacing: '0.03em' }}>{day}</div>
        <div style={{ fontSize: '0.83rem', color: C.ink }}>{what}</div>
      </div>
    </div>
  );
}

export function IconButton({ children, onClick, color, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{ width: 40, height: 40, borderRadius: 10, background: color, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: disabled ? 'default' : 'pointer', flexShrink: 0, opacity: disabled ? 0.6 : 1 }}
    >
      {children}
    </button>
  );
}

export function EmptyNote({ text }) {
  return <span style={{ fontSize: '0.78rem', color: C.walnutSoft, opacity: 0.6 }}>{text}</span>;
}

export const inputStyle = {
  flex: 1, padding: '0.6rem 0.75rem', borderRadius: 10, border: `1px solid ${C.line}`,
  background: C.paper, fontSize: '0.88rem', color: C.ink, outline: 'none',
};
export const miniInput = {
  padding: '0.45rem 0.6rem', borderRadius: 8, border: `1px solid ${C.line}`,
  background: C.paper, fontSize: '0.8rem', color: C.ink, outline: 'none',
};
export const rowBox = {
  display: 'flex', alignItems: 'center', gap: '0.5rem', background: C.paper,
  border: `1px solid ${C.line}`, borderRadius: 10, padding: '0.5rem 0.6rem',
};
export const ghostBtn = { background: 'transparent', border: 'none', cursor: 'pointer', padding: '0.2rem', display: 'flex' };

export function pillBtn(color) {
  return { background: color, color: C.paper, border: 'none', borderRadius: 999, padding: '0.35rem 0.65rem', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' };
}
export function checkBtn(done, color) {
  return { width: 20, height: 20, borderRadius: 6, border: `1.5px solid ${done ? color : C.line}`, background: done ? color : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, padding: 0 };
}
export function chipBtn(active, color) {
  return {
    padding: '0.3rem 0.6rem', borderRadius: 999, fontSize: '0.7rem', fontWeight: 600,
    border: `1.5px solid ${active ? color : C.line}`, background: active ? color : 'transparent',
    color: active ? C.paper : C.walnutSoft, cursor: 'pointer',
  };
}
