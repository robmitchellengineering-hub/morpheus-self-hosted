import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { getApiBase } from '@/api/base44Client';

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
    // Use the resolved API base from the shared client instead of a
    // relative '/api' path. On the production frontend a relative path
    // resolves to the SPA fallback (HTTP 200 with index.html), which made
    // this card show success while talking to nothing. getApiBase() uses
    // the same runtime resolution the rest of the app already trusts.
    fetch(`${getApiBase()}/health`)
      .then(async (res) => {
        const contentType = res.headers.get('content-type') || '';
        const isJson = contentType.includes('application/json');
        const text = await res.text();
        if (!alive) return;
        if (!isJson) {
          setState({
            status: 'error',
            message: `Expected JSON from the API but received "${contentType}" — this is the app's fallback page, not the backend.`,
          });
          return;
        }
        try {
          JSON.parse(text); // validate before reporting success
          setState({ status: 'ok', code: res.status, url: res.url, body: text.slice(0, 160) });
        } catch {
          setState({ status: 'error', message: 'The API returned a 200 but the body is not valid JSON — likely the single-page-app fallback page.' });
        }
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
