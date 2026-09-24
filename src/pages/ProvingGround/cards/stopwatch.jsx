import { useEffect, useRef, useState } from 'react';

// A start/stop/reset stopwatch, and the smallest honest test of the two things
// a reasoner writing a React card is most likely to get wrong: state that only
// changes when a person interacts with it, and an interval that must not outlive
// the component. Both are invisible to every gate self-dev has — esbuild bundles
// it, and an HTTP 200 never touches it — so the only way to know is to watch it
// tick here, start it, stop it, reset it, and navigate away mid-run.
//
// The elapsed value is anchored to a wall-clock start point rather than counted
// up in 0.1 steps per tick: a throttled background tab or a slow render would
// otherwise make the displayed time quietly fall behind real time, which is a
// stopwatch that lies. The interval only drives the re-render.
export default function Stopwatch() {
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(false);
  const startedAtRef = useRef(0);
  const elapsedRef = useRef(0);

  useEffect(() => {
    // Not running: no interval is created at all, so there is nothing to leak.
    if (!running) return undefined;

    startedAtRef.current = Date.now() - elapsedRef.current * 1000;
    const timer = setInterval(() => {
      const next = (Date.now() - startedAtRef.current) / 1000;
      elapsedRef.current = next;
      setElapsed(next);
    }, 100);

    // This cleanup is what makes it impossible for the interval to outlive the
    // component — it runs on unmount AND on every stop, because `running` is the
    // only dependency.
    return () => clearInterval(timer);
  }, [running]);

  const reset = () => {
    elapsedRef.current = 0;
    setElapsed(0);
    setRunning(false);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs font-mono text-ink-strong font-bold">STOPWATCH</p>

      <p className="text-2xl font-mono text-ink-strong tabular-nums">{elapsed.toFixed(1)}s</p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setRunning((r) => !r)}
          className="text-[11px] font-mono uppercase tracking-wider border border-primary/40 text-ink-strong hover:border-primary px-2 py-1 transition-colors"
        >
          {running ? 'Stop' : 'Start'}
        </button>
        <button
          type="button"
          onClick={reset}
          className="text-[11px] font-mono uppercase tracking-wider border border-primary/25 text-ink-max hover:border-primary/60 hover:text-ink-strong px-2 py-1 transition-colors"
        >
          Reset
        </button>
        <span className="text-[11px] font-mono text-ink-max">{running ? 'running' : 'stopped'}</span>
      </div>
    </div>
  );
}
