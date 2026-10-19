import { useEffect, useState } from 'react';

export default function SelfdevHello() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="space-y-2">
      <p className="text-xs font-mono text-ink-strong font-bold">SHIPPED THROUGH SELF-DEV</p>
      <p className="text-[11px] font-mono text-ink-max">{now.toISOString().slice(11, 23)} UTC</p>
    </div>
  );
}
