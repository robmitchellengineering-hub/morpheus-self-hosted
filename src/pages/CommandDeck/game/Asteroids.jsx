// Retro Asteroids — the reward you play when you tick a task off.
//
// PORTED from the old base44 Command Deck (`valiant-command-deck`, src/pages/Play.jsx), which Rob built
// there before this repo existed: "If you look at the original base 44 site it might even have that code
// in there." It did. The physics, wave spawning, asteroid splitting, respawn invulnerability, scoring and
// palette all come from that file unchanged; what is new here is only the seams — it is a COMPONENT now,
// driven by props, so the deck can open it in a popup instead of routing to a page.
//
// Two seams replaced the old page's own machinery:
//   - `running` (was the page's `overRef`) — the parent owns the clock and freezes the game when the
//     earned time is spent.
//   - `onScore` (was a `setScore` React state inside the loop) — reported out so the parent can
//     submit the final score, and kept in a ref so a new callback identity never restarts the game.
//
// Controls: arrow keys + space on a keyboard, the joystick + FIRE on a phone. The Deck is mostly used on
// a phone, which is why the old repo's Pointer-Events joystick came across with it.
import { useEffect, useRef, useState } from 'react';
import { C } from '../deckConstants';
import Joystick from './Joystick';

// The play surface is deliberately darker than the deck's walnut — the original used this literal, and
// the rest of the palette below is the deck's own so the game still looks like part of the Deck.
const SPACE = '#0f0c08';

export default function Asteroids({ running = true, onScore }) {
  const canvasRef = useRef(null);
  const joyRef = useRef({ x: 0, y: 0, active: false });
  const fireRef = useRef(false);
  const runningRef = useRef(running);
  const onScoreRef = useRef(onScore);
  const rafRef = useRef(null);
  const [score, setScore] = useState(0);

  // Refs, not effect dependencies: the game loop is started once and must survive the parent
  // re-rendering with a fresh callback or toggling `running`.
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { onScoreRef.current = onScore; });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = { w: 0, h: 0 };
    const inited = { v: false };

    const ship = { x: 0, y: 0, angle: -Math.PI / 2, vx: 0, vy: 0, alive: true, invUntil: 0 };
    let bullets = [];
    let asteroids = [];
    let scoreVal = 0;
    let lastTs = performance.now();
    let lastFire = 0;

    const randAsteroid = (r, x, y) => {
      const verts = 8 + Math.floor(Math.random() * 4);
      const shape = [];
      for (let i = 0; i < verts; i++) shape.push(0.7 + Math.random() * 0.5);
      const speed = 0.4 + Math.random() * 0.8;
      const dir = Math.random() * Math.PI * 2;
      return {
        x: x != null ? x : Math.random() * size.w,
        y: y != null ? y : Math.random() * size.h,
        vx: Math.cos(dir) * speed, vy: Math.sin(dir) * speed,
        r, rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 0.04, shape,
      };
    };
    const spawnWave = (n) => { for (let i = 0; i < n; i++) asteroids.push(randAsteroid(42)); };

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const r = parent.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      canvas.style.width = r.width + 'px';
      canvas.style.height = r.height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      size.w = r.width;
      size.h = r.height;
      if (!inited.v && r.width > 0) {
        inited.v = true;
        ship.x = r.width / 2; ship.y = r.height / 2;
        spawnWave(4);
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement);
    resize();

    const wrap = (o) => {
      const { w, h } = size;
      if (o.x < -o.r) o.x += w; if (o.x > w + o.r) o.x -= w;
      if (o.y < -o.r) o.y += h; if (o.y > h + o.r) o.y -= h;
    };

    const fire = () => {
      const now = performance.now();
      if (now - lastFire < 220) return;
      lastFire = now;
      bullets.push({ x: ship.x, y: ship.y, vx: Math.cos(ship.angle) * 6, vy: Math.sin(ship.angle) * 6, life: 70 });
    };

    const step = (dt) => {
      const k = dt / 16;
      const j = joyRef.current;
      if (j.active) {
        const mag = Math.hypot(j.x, j.y);
        if (mag > 0.05) {
          ship.angle = Math.atan2(j.y, j.x);
          const t = mag * 0.26;
          ship.vx += j.x * t * k;
          ship.vy += j.y * t * k;
        }
      }
      ship.vx *= 0.992; ship.vy *= 0.992;
      ship.x += ship.vx * k; ship.y += ship.vy * k;
      wrap(ship);
      if (fireRef.current) fire();
      bullets.forEach((b) => { b.x += b.vx * k; b.y += b.vy * k; b.life -= k; });
      bullets = bullets.filter((b) => b.life > 0);
      bullets.forEach(wrap);
      asteroids.forEach((a) => { a.x += a.vx * k; a.y += a.vy * k; a.rot += a.vr * k; wrap(a); });

      for (let i = asteroids.length - 1; i >= 0; i--) {
        const a = asteroids[i];
        for (let bi = bullets.length - 1; bi >= 0; bi--) {
          const b = bullets[bi];
          if (Math.hypot(b.x - a.x, b.y - a.y) < a.r) {
            bullets.splice(bi, 1);
            asteroids.splice(i, 1);
            scoreVal += 10;
            setScore(scoreVal);
            if (onScoreRef.current) onScoreRef.current(scoreVal);
            if (a.r > 22) {
              const nr = a.r * 0.55;
              asteroids.push(randAsteroid(nr, a.x, a.y));
              asteroids.push(randAsteroid(nr, a.x, a.y));
            }
            break;
          }
        }
      }
      if (ship.alive && performance.now() > ship.invUntil) {
        for (const a of asteroids) {
          if (Math.hypot(ship.x - a.x, ship.y - a.y) < a.r * 0.8) {
            ship.alive = false;
            setTimeout(() => {
              ship.x = size.w / 2; ship.y = size.h / 2; ship.vx = 0; ship.vy = 0;
              ship.angle = -Math.PI / 2; ship.alive = true; ship.invUntil = performance.now() + 2000;
            }, 800);
            break;
          }
        }
      }
      if (asteroids.length === 0) spawnWave(4 + Math.floor(scoreVal / 100));
    };

    const drawPoly = (cx, cy, r, rot, shape) => {
      ctx.beginPath();
      shape.forEach((s, i) => {
        const a = (i / shape.length) * Math.PI * 2 + rot;
        const x = cx + Math.cos(a) * r * s, y = cy + Math.sin(a) * r * s;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
    };

    const draw = () => {
      const { w, h } = size;
      ctx.fillStyle = SPACE;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = C.brass; ctx.lineWidth = 2;
      asteroids.forEach((a) => { drawPoly(a.x, a.y, a.r, a.rot, a.shape); ctx.stroke(); });
      ctx.fillStyle = C.gold;
      bullets.forEach((b) => { ctx.beginPath(); ctx.arc(b.x, b.y, 2.5, 0, Math.PI * 2); ctx.fill(); });
      if (ship.alive) {
        const inv = performance.now() < ship.invUntil;
        if (!inv || Math.floor(performance.now() / 100) % 2 === 0) {
          ctx.save();
          ctx.translate(ship.x, ship.y); ctx.rotate(ship.angle);
          ctx.beginPath();
          ctx.moveTo(12, 0); ctx.lineTo(-8, -7); ctx.lineTo(-4, 0); ctx.lineTo(-8, 7); ctx.closePath();
          ctx.strokeStyle = C.paper; ctx.lineWidth = 2; ctx.stroke();
          ctx.restore();
        }
      }
    };

    const loop = (ts) => {
      const dt = Math.min(ts - lastTs, 40); lastTs = ts;
      if (runningRef.current) step(dt);
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    const kd = (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); joyRef.current = { x: -1, y: 0, active: true }; }
      if (e.key === 'ArrowRight') { e.preventDefault(); joyRef.current = { x: 1, y: 0, active: true }; }
      if (e.key === 'ArrowUp') { e.preventDefault(); joyRef.current = { x: 0, y: -1, active: true }; }
      if (e.key === ' ') { e.preventDefault(); fireRef.current = true; }
    };
    const ku = (e) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp'].includes(e.key)) joyRef.current = { x: 0, y: 0, active: false };
      if (e.key === ' ') fireRef.current = false;
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    };
  }, []);

  return (
    <>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: 0 }}>
        <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      </div>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '1rem', padding: '0.8rem 1.2rem calc(0.6rem + env(safe-area-inset-bottom))' }}>
        <Joystick inputRef={joyRef} color={C.brass} />
        <button
          type="button"
          aria-label="Fire"
          onTouchStart={(e) => { e.preventDefault(); fireRef.current = true; }}
          onTouchEnd={(e) => { e.preventDefault(); fireRef.current = false; }}
          onMouseDown={() => { fireRef.current = true; }}
          onMouseUp={() => { fireRef.current = false; }}
          onMouseLeave={() => { fireRef.current = false; }}
          style={{ width: 96, height: 96, borderRadius: '50%', background: C.alert, border: `3px solid ${C.gold}`, color: C.paper, fontSize: '0.8rem', fontWeight: 700, letterSpacing: '0.05em', touchAction: 'none', userSelect: 'none', cursor: 'pointer', flexShrink: 0 }}
        >
          FIRE
        </button>
      </div>
      {/* The score is reported out through onScore; this keeps it in the DOM for the parent's HUD only
          if it wants it, and costs nothing when it does not. */}
      <span style={{ display: 'none' }} data-asteroids-score={score} />
    </>
  );
}
