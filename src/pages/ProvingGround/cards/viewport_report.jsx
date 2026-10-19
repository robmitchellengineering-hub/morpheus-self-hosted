import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

export default function ViewportReport() {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const location = useLocation();

  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <div className="space-y-2">
      <p className="text-xs font-mono text-ink-strong font-bold">VIEWPORT</p>
      <p className="text-[11px] font-mono text-ink-max">{size.width} x {size.height}</p>
      <p className="text-[11px] font-mono text-ink-max">{location.pathname}</p>
      {size.width < 480 && (
        <p className="text-[11px] font-mono text-amber-400">Phone width — check for layout breakage.</p>
      )}
    </div>
  );
}
