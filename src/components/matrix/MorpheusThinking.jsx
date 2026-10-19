import { useEffect, useRef, useState } from 'react';

// Custom animated "Morpheus is working" indicator (2026-09-02) — replaces
// the old static "decoding reality" pulsing text with a cycling set of
// Matrix-flavoured status phrases, each one revealed through a hacker-style
// character-scramble effect (classic "text scramble" decrypt animation:
// random glyphs settle into the real text left-to-right) rather than just
// fading/pulsing in place. No external animation library — plain
// requestAnimationFrame + component state, so it drops in anywhere loading
// needs a bit of personality (currently just ChatPanel.jsx).
const PHRASES = [
  'decoding reality',
  'parsing intent',
  'tracing the code',
  'compiling thought',
  'bending the spoon',
  'walking the path',
  'reading between the lines',
  'following the white rabbit',
];

const SCRAMBLE_CHARS = '!<>-_\\/[]{}=+*^?#01';
const FRAMES_PER_REVEAL = 18;
const HOLD_MS = 1700;

export default function MorpheusThinking() {
  const [display, setDisplay] = useState(PHRASES[0]);
  const rafRef = useRef(null);
  const timeoutRef = useRef(null);
  const phraseIdxRef = useRef(0);
  const prevLenRef = useRef(PHRASES[0].length);

  useEffect(() => {
    let cancelled = false;

    const scrambleTo = (target) => new Promise((resolve) => {
      const length = Math.max(prevLenRef.current, target.length);
      let frame = 0;
      const tick = () => {
        if (cancelled) return resolve();
        frame++;
        const revealCount = Math.floor((frame / FRAMES_PER_REVEAL) * length);
        let out = '';
        for (let i = 0; i < length; i++) {
          if (i < revealCount) out += target[i] || '';
          else if (i < target.length || i < prevLenRef.current) out += SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
        }
        setDisplay(out);
        if (frame < FRAMES_PER_REVEAL) {
          rafRef.current = requestAnimationFrame(tick);
        } else {
          prevLenRef.current = target.length;
          setDisplay(target);
          resolve();
        }
      };
      tick();
    });

    const loop = async () => {
      while (!cancelled) {
        await new Promise((resolve) => { timeoutRef.current = setTimeout(resolve, HOLD_MS); });
        if (cancelled) break;
        phraseIdxRef.current = (phraseIdxRef.current + 1) % PHRASES.length;
        await scrambleTo(PHRASES[phraseIdxRef.current]);
      }
    };
    loop();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <span className="inline-flex items-center gap-2">
      <span className="flex gap-0.5" aria-hidden="true">
        <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }} />
      </span>
      <span className="font-mono tabular-nums">{display}</span>
      <span className="animate-pulse">_</span>
    </span>
  );
}
