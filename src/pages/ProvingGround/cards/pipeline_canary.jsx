import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';

// The seed card, and the template for every card after it.
//
// It is deliberately trivial and deliberately honest: it asserts nothing about
// the product, only that this page rendered and that the browser can actually
// reach the backend from wherever it is being viewed. Both are load-bearing
// facts for a surface whose whole job is "look at this and tell me if it works"
// — a card that silently fails to fetch would look exactly like a card that
// rendered fine.
//
// If this card is red, the problem is the page or the API, not the change under
// test. That distinction is the point of having it first.
export default function PipelineCanary() {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    // A relative path on purpose: the deployed app proxies /api to the backend,
    // so this works on morpheus.nz and under the Vite dev proxy without needing
    // to resolve the API base. `res.url` then reports where it actually landed,
    // which is the useful half — it catches the ?api_base= trap by showing the
    // real endpoint rather than the one we assumed.
    fetch('/api/health')
      .then(async (res) => {
        const text = await res.text();
        if (alive) setState({ status: 'ok', code: res.status, url: res.url, body: text.slice(0, 160) });
      })
      .catch((err) => {
        if (alive) setState({ status: 'error', message: err.message });
      });
    return () => { alive = false; };
  }, []);

  return (
    <div className="space-y-3">
      <p className="text-xs font-mono text-ink-strong font-bold">PROVING GROUND CANARY — ok</p>

      {state.status === 'loading' && (
        <p className="flex items-center gap-2 text-xs text-ink-strong"><Loader2 size={12} className="animate-spin" /> checking the backend…</p>
      )}

      {state.status === 'ok' && (
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-xs text-ink-strong">
            <CheckCircle2 size={12} className="text-primary" /> GET /api/health → HTTP {state.code}
          </p>
          <p className="text-[11px] font-mono text-ink-max break-all">{state.url}</p>
          <pre className="text-[11px] font-mono text-ink-max whitespace-pre-wrap break-all">{state.body}</pre>
        </div>
      )}

      {state.status === 'error' && (
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-xs text-ink-strong">
            <XCircle size={12} className="text-red-400" /> the backend could not be reached
          </p>
          <p className="text-[11px] font-mono text-ink-max break-all">{state.message}</p>
        </div>
      )}
    </div>
  );
}
