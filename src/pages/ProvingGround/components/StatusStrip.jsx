// src/pages/ProvingGround/components/StatusStrip.jsx
import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';

export default function StatusStrip() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    base44.functions.invoke('getProvingGroundStatus', {})
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || 'Failed to load status');
      });
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <div className="bg-card border border-border rounded-md p-3 text-sm text-muted-foreground">
        Status unavailable: {error}
      </div>
    );
  }

  if (!status) {
    return (
      <div className="bg-card border border-border rounded-md p-3 text-sm text-muted-foreground animate-pulse">
        Loading proving-ground status…
      </div>
    );
  }

  const stats = [
    { label: 'Container memory', value: status.memory || '—' },
    { label: 'Self-dev runs', value: status.runCount != null ? String(status.runCount) : '—' },
    { label: 'Release branch', value: status.branch || '—' },
  ];

  return (
    <div className="flex flex-wrap gap-2 sm:gap-3 mb-4">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="flex-1 min-w-[120px] bg-card border border-border rounded-md p-3"
        >
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
            {stat.label}
          </div>
          <div className="text-sm font-mono text-ink break-words">
            {stat.value}
          </div>
        </div>
      ))}
    </div>
  );
}
