// Analog touch joystick. Writes a normalized vector {x,y,active} into the parent's ref.
//
// Ported from the old base44 Command Deck (`valiant-command-deck`,
// src/components/play/Joystick.jsx) when the Asteroids reward was brought across — this is the part
// that makes the game playable on a phone, which is where the Deck is mostly used, so it comes over
// as-is rather than being rewritten. Two adaptations only: the React default import is unnecessary
// under this repo's JSX transform, and the catch bindings are optional.
//
// It uses native Pointer Events with pointer capture, so the stick keeps tracking when the finger
// drifts outside the base — no dropped moves and no React-event lag.
import { useRef, useEffect } from 'react';

export default function Joystick({ inputRef, color = '#B0793C' }) {
  const baseRef = useRef(null);
  const knobRef = useRef(null);
  const st = useRef({ active: false, cx: 0, cy: 0, pid: null });
  const radius = 58;

  const setKnob = (dx, dy) => {
    if (knobRef.current) knobRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
  };

  const update = (clientX, clientY) => {
    let dx = clientX - st.current.cx;
    let dy = clientY - st.current.cy;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) { dx = (dx / dist) * radius; dy = (dy / dist) * radius; }
    setKnob(dx, dy);
    if (inputRef) inputRef.current = { x: dx / radius, y: dy / radius, active: true };
  };

  const reset = () => {
    st.current.active = false;
    st.current.pid = null;
    setKnob(0, 0);
    if (inputRef) inputRef.current = { x: 0, y: 0, active: false };
  };

  useEffect(() => {
    const el = baseRef.current;
    if (!el) return;

    const down = (e) => {
      e.preventDefault();
      const b = el.getBoundingClientRect();
      st.current.cx = b.left + b.width / 2;
      st.current.cy = b.top + b.height / 2;
      st.current.active = true;
      st.current.pid = e.pointerId;
      try { el.setPointerCapture(e.pointerId); } catch { /* capture is a nicety, not a requirement */ }
      update(e.clientX, e.clientY);
    };
    const move = (e) => {
      if (!st.current.active || e.pointerId !== st.current.pid) return;
      e.preventDefault();
      update(e.clientX, e.clientY);
    };
    const up = (e) => {
      if (e.pointerId !== st.current.pid) return;
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      reset();
    };

    el.addEventListener('pointerdown', down, { passive: false });
    el.addEventListener('pointermove', move, { passive: false });
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
  }, []);

  return (
    <div
      ref={baseRef}
      style={{
        position: 'relative',
        width: 130,
        height: 130,
        borderRadius: '50%',
        background: 'rgba(28,19,11,0.35)',
        border: `2px solid ${color}`,
        touchAction: 'none',
        userSelect: 'none',
        flexShrink: 0,
      }}
    >
      <div
        ref={knobRef}
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: 56,
          height: 56,
          marginLeft: -28,
          marginTop: -28,
          borderRadius: '50%',
          background: color,
          boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
