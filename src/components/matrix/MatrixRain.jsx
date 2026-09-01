import { useEffect, useRef } from 'react';
import { useTheme } from '@/contexts/ThemeContext';

const CHARS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎ0123456789ABCDEF';

export default function MatrixRain({ opacity = 0.1 }) {
  const canvasRef = useRef(null);
  const { theme } = useTheme();

  // The rain effect paints its own black fade-trail on every frame
  // (see draw() below), which fights the whole point of the Boring theme —
  // a plain, non-terminal, light background. Rather than trying to recolor
  // an animated hacker-rain effect into something "corporate", the Boring
  // theme simply turns it off, matching the backlog spec's "deliberately
  // limited customizability" / plain-look intent. Every page renders this
  // component the same way, so gating it here (one file) covers all of
  // them instead of needing a per-page check.
  const disabled = theme === 'boring';

  useEffect(() => {
    if (disabled) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    let animationId;
    let drops = [];
    const fontSize = 14;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      drops = Array(Math.floor(canvas.width / fontSize)).fill(1);
    };
    resize();
    window.addEventListener('resize', resize);

    // Read the current theme's primary color at draw-start so the rain
    // matches whichever theme (Clear default or Classic Matrix) is active,
    // and updates automatically if the user switches theme mid-session.
    const rainColor = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();

    const draw = () => {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = rainColor ? `hsl(${rainColor})` : '#00ff41';
      ctx.font = fontSize + 'px monospace';
      for (let i = 0; i < drops.length; i++) {
        const text = CHARS[Math.floor(Math.random() * CHARS.length)];
        ctx.fillText(text, i * fontSize, drops[i] * fontSize);
        if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      }
      animationId = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener('resize', resize);
    };
  }, [disabled]);

  // Skip rendering the canvas entirely when disabled, rather than just
  // skipping the draw loop — that also drops whatever black pixels were
  // already painted onto it before the user switched themes mid-session.
  if (disabled) return null;

  return <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none" style={{ opacity, zIndex: 0 }} />;
}