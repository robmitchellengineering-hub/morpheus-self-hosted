// The popup you get for ticking a task off: the clock, the game, and the Morpheus-wide board.
//
// Rob, 2026-10-02: "when you tick off a task i want a pop up window with retro asteroids that you can
// play with a morpheus wide points score board, when you complete a task you can play asteroids for
// 1 min or choose to bank the time to play more later."
//
// This owns the CLOCK and the session; Asteroids owns the canvas and the gameplay, and reports its
// score out. You play for whatever you have banked — that is what "bank the time to play more later"
// means — and when the clock runs out the score is submitted once and the board is shown.
import { useCallback, useEffect, useRef, useState } from 'react';
import { C } from '../deckConstants';
import Asteroids from './Asteroids';
import { formatClock, normalizeInitials, leaderboard } from './playBank';

const SPACE = '#0f0c08';

function pill(color, extra = {}) {
  return {
    background: color, color: C.paper, border: 'none', borderRadius: 999,
    padding: '0.6rem 1.1rem', fontSize: '0.8rem', fontWeight: 600,
    cursor: 'pointer', minHeight: 44, display: 'inline-flex',
    alignItems: 'center', justifyContent: 'center', ...extra,
  };
}

export default function PlayModal({ seconds, initials, scores, meId, onClose, onSubmitScore }) {
  const [timeLeft, setTimeLeft] = useState(seconds);
  const [score, setScore] = useState(0);
  const [over, setOver] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(initials || '');
  const scoreRef = useRef(0);
  const overRef = useRef(false);

  // The game reports every hit; keep the latest in a ref so the submit below always has the final
  // score even though the tick that reaches zero runs in a different closure.
  const onScore = useCallback((s) => { scoreRef.current = s; setScore(s); }, []);

  useEffect(() => {
    const t = window.setInterval(() => {
      if (overRef.current) return;
      setTimeLeft((prev) => {
        if (prev <= 1) { overRef.current = true; setOver(true); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  // Submitting once is the whole point: the credit was spent when the session opened, and a second
  // submit would file a second score for the same game.
  const submit = async () => {
    if (submitted || saving) return;
    const clean = normalizeInitials(draft);
    setSaving(true);
    try {
      // The initials ride along with the score rather than being saved separately: the player's
      // current initials are simply those of their most recent score, so there is no second place
      // for them to disagree with the board.
      await onSubmitScore({ score: scoreRef.current, seconds_played: seconds, initials: clean || initials });
      setSubmitted(true);
    } finally {
      setSaving(false);
    }
  };

  const needsInitials = !normalizeInitials(draft);
  const board = leaderboard(scores, { limit: 5, meId });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Asteroids break"
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: SPACE, color: C.paper, display: 'flex', flexDirection: 'column', fontFamily: "'Lexend', sans-serif" }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: 'calc(0.7rem + env(safe-area-inset-top)) 1rem 0.6rem', borderBottom: `3px solid ${C.gold}`, flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '1.4rem', fontWeight: 600, letterSpacing: '-0.01em' }}>{formatClock(timeLeft)}</div>
          <div style={{ fontSize: '0.72rem', color: 'rgba(246,240,223,0.6)' }}>Score {score} · you earned {formatClock(seconds)}</div>
        </div>
        <button type="button" onClick={onClose} style={pill(C.walnutSoft)}>{over ? 'Done' : 'Bank the rest'}</button>
      </header>

      <Asteroids running={!over} onScore={onScore} />

      {over && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(15,12,8,0.9)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.9rem', padding: '1.2rem', overflowY: 'auto' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 600 }}>Break&apos;s up</div>
          <div style={{ fontSize: '0.9rem', color: 'rgba(246,240,223,0.75)' }}>You scored {score}.</div>

          {!submitted && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
              <label htmlFor="arcade-initials" style={{ fontSize: '0.75rem', color: 'rgba(246,240,223,0.7)' }}>
                Three characters for the board
              </label>
              <input
                id="arcade-initials"
                value={draft}
                onChange={(e) => setDraft(e.target.value.toUpperCase().slice(0, 3))}
                maxLength={3}
                autoComplete="off"
                style={{ width: 110, textAlign: 'center', fontSize: '1.3rem', letterSpacing: '0.3em', fontFamily: 'monospace', background: 'rgba(251,246,233,0.08)', border: `2px solid ${needsInitials ? C.alert : C.brass}`, borderRadius: 10, color: C.paper, padding: '0.35rem 0.4rem' }}
              />
              <button type="button" onClick={submit} disabled={needsInitials || saving} style={pill(needsInitials ? C.walnutSoft : C.sage, { opacity: needsInitials || saving ? 0.55 : 1 })}>
                {saving ? 'Saving…' : 'Put it on the board'}
              </button>
            </div>
          )}

          {submitted && (
            <div style={{ width: 'min(360px, 100%)' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: C.brassLight, marginBottom: '0.4rem' }}>MORPHEUS-WIDE — TOP 5</div>
              {board.length === 0 && <div style={{ fontSize: '0.8rem', color: 'rgba(246,240,223,0.6)' }}>Nobody has played yet. You are first.</div>}
              {board.map((row) => (
                <div key={row.created_by_id} style={{ display: 'flex', gap: '0.6rem', fontSize: '0.85rem', padding: '0.25rem 0', color: row.isMe ? C.gold : C.paper }}>
                  <span style={{ width: '1.4rem', opacity: 0.7 }}>{row.rank}</span>
                  <span style={{ fontFamily: 'monospace', letterSpacing: '0.15em', flex: 1 }}>{row.initials}</span>
                  <span>{row.score}</span>
                </div>
              ))}
            </div>
          )}

          <button type="button" onClick={onClose} style={pill(C.walnutSoft)}>Back to the deck</button>
        </div>
      )}
    </div>
  );
}
