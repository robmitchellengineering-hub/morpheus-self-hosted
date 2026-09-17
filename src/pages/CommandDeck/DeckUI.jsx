import { useState } from 'react';
import { ChevronDown, ChevronRight, Mic, Search, X } from 'lucide-react';
import { C } from './deckConstants';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';

// Small presentational primitives shared across every Command Deck tab page
// (DeckHome, DeckJarvis, DeckTools, DeckSettings) — moved out of the old
// single-file CommandDeck.jsx unchanged.

function collapseKey(title) {
  return `deck-section-open:${String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

// 2026-09-17 (Rob: "I need all of those fields that the deck creates
// collapsible and searchable"): every section on the Deck is one of these
// Card wrappers, so both features live here once instead of being rebuilt
// per section. Collapse state persists per-title in localStorage (best-effort
// — a private window or blocked storage just falls back to "always open",
// never breaks the page) so a section someone collapses stays collapsed
// across visits. Search is opt-in: pass `search={{value, onChange,
// placeholder}}` and the caller does its own filtering of what it renders as
// children — Card only owns the input UI, since every section's data shape
// (tasks, notes, jobs...) is different.
export function Card({ title, sub, children, style = {}, titleColor = C.walnut, subColor, collapsible = true, search }) {
  const [open, setOpen] = useState(() => {
    if (!collapsible) return true;
    try {
      const stored = localStorage.getItem(collapseKey(title));
      return stored === null ? true : stored === '1';
    } catch { return true; }
  });

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(collapseKey(title), next ? '1' : '0'); } catch {}
      return next;
    });
  };

  return (
    <section style={{ background: C.paper, border: `1.5px solid ${C.line}`, borderRadius: 16, padding: '1rem 1rem 1.1rem', marginTop: '0.9rem', boxShadow: '0 2px 0 rgba(28,19,11,0.06)', ...style }}>
      <button
        onClick={collapsible ? toggle : undefined}
        disabled={!collapsible}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem',
          background: 'transparent', border: 'none', padding: 0, margin: 0, cursor: collapsible ? 'pointer' : 'default', textAlign: 'left',
        }}
      >
        <h2 style={{ fontWeight: 600, fontSize: '1.08rem', margin: 0, color: titleColor }}>{title}</h2>
        {collapsible && (open ? <ChevronDown size={17} color={subColor || C.walnutSoft} /> : <ChevronRight size={17} color={subColor || C.walnutSoft} />)}
      </button>
      {sub && open && <p style={{ margin: '0.2rem 0 0.8rem', fontSize: '0.78rem', color: subColor || C.walnutSoft, opacity: subColor ? 1 : 0.85 }}>{sub}</p>}
      {!sub && open && search && <div style={{ marginTop: '0.5rem' }} />}
      {open && search && (
        <div style={{ position: 'relative', marginBottom: '0.75rem' }}>
          <Search size={14} color={C.walnutSoft} style={{ position: 'absolute', left: '0.6rem', top: '50%', transform: 'translateY(-50%)', opacity: 0.6, pointerEvents: 'none' }} />
          <input
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder || 'Search…'}
            style={{
              width: '100%', boxSizing: 'border-box', padding: '0.45rem 2rem 0.45rem 2rem', borderRadius: 8,
              border: `1px solid ${C.line}`, background: C.tweedDark, color: C.ink, fontSize: '0.8rem',
            }}
          />
          {search.value && (
            <button
              onClick={() => search.onChange('')}
              style={{ position: 'absolute', right: '0.4rem', top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', padding: '0.15rem' }}
              title="Clear search"
            >
              <X size={13} color={C.walnutSoft} />
            </button>
          )}
        </div>
      )}
      {open && children}
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

// 2026-09-17 (Rob: "all text input fields need a stt button" + "brain dump,
// when i press enter it needs to send") — the exact pattern brain dump
// (DeckHome.jsx) and the Jarvis chat input (DeckJarvis.jsx) already used,
// pulled out once so every other genuine free-text field gets both for
// free instead of two separate ad-hoc passes. Not for numeric/date/email/
// phone fields, read-only fields, or <select> — dictation adds error risk
// there without real value (see this session's field audit).
export function MicField({ value, onChange, onSubmit, placeholder, style = inputStyle, micColor = C.walnutSoft, disabled, wrapperStyle }) {
  const { listening, start, stop, supported } = useSpeechRecognition({
    onResult: (transcript) => onChange(value?.trim() ? `${value.trim()} ${transcript}` : transcript),
  });
  return (
    <div style={{ display: 'flex', gap: '0.5rem', flex: 1, ...wrapperStyle }}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && onSubmit) onSubmit(); }}
        placeholder={placeholder}
        disabled={disabled}
        style={style}
      />
      {supported && (
        <IconButton onClick={() => (listening ? stop() : start())} color={listening ? C.alert : micColor} disabled={disabled}>
          <Mic size={18} color={C.paper} />
        </IconButton>
      )}
    </div>
  );
}

// Textarea counterpart — Enter is left alone (newlines are the point in a
// note/instruction field), so there's no onSubmit here; the mic button sits
// underneath rather than beside, since a multi-line field is tall enough
// that a side-by-side button looks stranded at the top.
export function MicTextarea({ value, onChange, placeholder, rows = 2, style = miniInput, micColor = C.walnutSoft, disabled }) {
  const { listening, start, stop, supported } = useSpeechRecognition({
    onResult: (transcript) => onChange(value?.trim() ? `${value.trim()} ${transcript}` : transcript),
  });
  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        style={{ ...style, width: '100%', boxSizing: 'border-box', resize: 'vertical', display: 'block' }}
      />
      {supported && (
        <button
          onClick={() => (listening ? stop() : start())}
          disabled={disabled}
          style={{ ...ghostBtn, marginTop: '0.25rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.72rem', color: listening ? C.alert : C.walnutSoft }}
        >
          <Mic size={13} color={listening ? C.alert : C.walnutSoft} /> {listening ? 'Listening…' : 'Dictate'}
        </button>
      )}
    </div>
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
