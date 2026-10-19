// The task runner: client-driven loops that survive the tab switch.
//
// WHY THIS EXISTS
//
// Rob, 2026-09-24: "whenever you switch tabs in the plugin the tasks stop running
// or atleast apear to". Both, and the second one is the honest half — a running
// loop lived inside the tab component, and WebsitePanel and Embed render tabs
// conditionally (`{tab === 'seo' && <SeoTab … />}`), so switching tabs UNMOUNTED
// the component and destroyed its state:
//
//   * the remaining slices of an SEO batch were never sent — the job genuinely
//     stopped and could be left half-done,
//   * the slice already in flight was not aborted, so it finished server-side and
//     the answer was thrown away,
//   * the progress state was gone, which is why coming back showed nothing.
//
// So the loop and its state move ABOVE the tab switch. A tab now hands the runner
// a worker function; the runner owns the promise, the progress, the ETA and the
// result, and renders a strip in the panel chrome. Unmounting a tab runs React's
// cleanup on the tab, not on the work.
//
// WHAT OWNS WHAT (the guard asserts this, so it is written down rather than implied)
//
//   * THIS MODULE owns the state: one provider per surface, mounted OUTSIDE the
//     conditional render, in WebsitePanel and in Embed.
//   * THIS MODULE renders the strip (`TaskRunStrip`), so progress is visible from
//     any tab and is not something a tab has to remember to draw.
//   * A TAB owns only the presentation of its own RESULT (the review list), which
//     it rebuilds from the runner's stored result when it mounts again.
//
// RELOAD IS A DIFFERENT FAILURE, AND IS NOT COVERED THE SAME WAY
//
// Navigation is fully covered. A reload is not: a client-driven loop cannot
// survive one, and pretending otherwise would be worse than saying so. What IS
// cheap is honesty afterwards — a run in flight leaves a one-line marker, and the
// next mount reports "interrupted by a reload" instead of showing a clean panel
// that implies nothing happened. That is a report, not a resume.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, X, Check, AlertTriangle, Ban } from 'lucide-react';
import EtaTimer from './website/EtaTimer';

const TaskRunnerContext = createContext(null);

const MARKER_PREFIX = 'morpheus.task.';

// localStorage is not always there (SSR, a locked-down browser). A run that cannot
// leave a marker is still a working run — it just cannot report an interruption.
const store = {
  get(key) { try { return window.localStorage.getItem(MARKER_PREFIX + key); } catch { return null; } },
  set(key, value) { try { window.localStorage.setItem(MARKER_PREFIX + key, value); } catch { /* no storage */ } },
  clear(key) { try { window.localStorage.removeItem(MARKER_PREFIX + key); } catch { /* no storage */ } },
};

/**
 * The provider, and the strip it renders.
 *
 * `children` are the tab bar and the tab body, so mounting this around them is
 * what puts the runner outside the conditional render — the guard checks the
 * mount site rather than trusting this comment.
 *
 * The strip is rendered HERE, above the children, and not by any tab: a tab that
 * had to draw its own progress is a tab that stops drawing it the moment it
 * unmounts, which is the bug.
 */
export function TaskRunner({ children }) {
  const [tasks, setTasks] = useState({});
  const [interrupted, setInterrupted] = useState([]);
  const cancels = useRef(new Map());

  // Any marker left behind by a previous page load is a run that was cut off.
  // Reported once, then cleared — a marker that outlives its report would nag
  // forever about something the operator cannot act on.
  useEffect(() => {
    const found = [];
    try {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i);
        if (!k || !k.startsWith(MARKER_PREFIX)) continue;
        try {
          const meta = JSON.parse(window.localStorage.getItem(k) || '{}');
          found.push({ key: k.slice(MARKER_PREFIX.length), label: meta.label || 'A task', done: meta.done ?? 0, total: meta.total ?? 0 });
        } catch { /* unreadable marker */ }
        window.localStorage.removeItem(k);
      }
    } catch { /* no storage */ }
    if (found.length) setInterrupted(found);
  }, []);

  /**
   * Run a worker above the tabs.
   *
   * The worker gets `{ progress, cancelled }`. The runner keeps the promise, so
   * unmounting the tab that started it changes nothing about the work. It never
   * rejects: the outcome is recorded and returned, because the caller may not
   * exist any more and the NEXT mount has to be able to read what happened.
   */
  const startTask = useCallback(async ({ key, label, total = 0, estimateMs = null }, worker) => {
    cancels.current.set(key, false);
    store.set(key, JSON.stringify({ label, startedAt: Date.now() }));
    const startedAt = Date.now();
    const set = (patch) => setTasks((t) => (t[key] ? { ...t, [key]: { ...t[key], ...patch } } : t));
    setTasks((t) => ({
      ...t,
      [key]: { key, label, status: 'running', startedAt, estimateMs, done: 0, total, detail: '', result: null, error: null },
    }));

    const api = {
      // `done`/`total`/`estimateMs`/`detail` are the caller's to shape; the runner
      // does not guess them, because only the loop knows what a slice is.
      progress: (patch) => {
        set({ ...patch, status: 'running' });
        const cur = { label, done: patch.done ?? 0, total: patch.total ?? total };
        store.set(key, JSON.stringify({ label, startedAt, ...cur }));
      },
      cancelled: () => cancels.current.get(key) === true,
    };

    try {
      const result = await worker(api);
      const cancelled = cancels.current.get(key) === true;
      store.clear(key);
      set({ status: cancelled ? 'cancelled' : 'done', result, error: null, ...(cancelled ? {} : { done: total || undefined }) });
      return { status: cancelled ? 'cancelled' : 'done', result, error: null };
    } catch (err) {
      // A streamed failure arrives as the terminal event, and the API client
      // turns that into an error whose `.data` is the event — so read the same
      // wording the tab used to.
      const message = err?.data?.error || err?.data?.message || err?.message || 'The task failed.';
      store.clear(key);
      set({ status: 'error', error: message });
      return { status: 'error', result: null, error: message };
    } finally {
      // ONLY cleanup here. This block used to end with `if (!alive.current) return;`, and a `return`
      // inside `finally` OVERRIDES whatever the `try` or `catch` returned — so a task that failed
      // while the panel was unmounted reported `undefined` instead of its error, and the operator saw
      // nothing. `no-unsafe-finally` found it the moment the frontend lint config started running
      // eslint's recommended set (2026-10-04); React 18 does not warn about a state update on an
      // unmounted component, so the guard it was meant to be had nothing to do anyway.
      cancels.current.delete(key);
    }
  }, []);

  const cancelTask = useCallback((key) => {
    cancels.current.set(key, true);
    setTasks((t) => (t[key] ? { ...t, [key]: { ...t[key], detail: 'Stopping…' } } : t));
  }, []);

  const dismissTask = useCallback((key) => {
    setTasks((t) => { const next = { ...t }; delete next[key]; return next; });
  }, []);

  const dismissInterrupted = useCallback(() => setInterrupted([]), []);

  const value = useMemo(() => ({ tasks, startTask, cancelTask, dismissTask }), [tasks, startTask, cancelTask, dismissTask]);

  return (
    <TaskRunnerContext.Provider value={value}>
      <TaskRunStrip tasks={tasks} interrupted={interrupted}
        onCancel={cancelTask} onDismiss={dismissTask} onDismissInterrupted={dismissInterrupted} />
      {children}
    </TaskRunnerContext.Provider>
  );
}

/**
 * Read a task's RESULT back out, once per result.
 *
 * This is the half that is easy to miss. Moving the WORK into the runner keeps it
 * alive across a tab switch; if the result stays in the tab, the work finishes
 * while the operator is elsewhere and the answer is still gone when they come
 * back — the worst of both. So every migrated loop hands its result to the runner
 * and rebuilds its view from here, which is what makes a remount show the answer
 * rather than a blank.
 *
 * `apply` is called once per distinct result (the ref), not on every render, so a
 * selection the operator has since changed is not overwritten.
 *
 * `watch` is for the loops whose result lands on something the TAB controls — the
 * per-item ones carry an item id, and reopening that page is a state change this
 * effect has to see. Without it the effect never re-runs when the item is opened
 * and the result is never placed: found by watching the merged code do exactly
 * that, not by reading it.
 */
export function useTaskResult(key, apply, watch = []) {
  const { tasks } = useTaskRunner();
  const task = tasks[key];
  const applied = useRef(null);
  const fn = useRef(apply);
  fn.current = apply;
  useEffect(() => {
    const r = task?.result;
    if (task?.status !== 'done' || !r || applied.current === r) return;
    // An apply that returns FALSE could not place the result yet — the per-item
    // loops carry an item id, and on a remount the tab is on the list with no item
    // open, so there is nothing to apply to. Consuming the result then would spend
    // the one application this hook gets on a tab that could not use it, and the
    // answer would be silently lost: exactly the failure this hook exists to stop.
    // So the result stays unconsumed until an apply actually takes it.
    if (fn.current(r) === false) return;
    applied.current = r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, task?.status, task?.result, ...watch]);
  return task;
}

/** The runner's own hook. A tab uses this; nothing else owns the state. */
export function useTaskRunner() {
  const ctx = useContext(TaskRunnerContext);
  if (!ctx) throw new Error('useTaskRunner must be used inside <TaskRunner> — the runner is mounted by the panel, not by a tab.');
  return ctx;
}

/**
 * The strip. Rendered by the provider rather than by a tab, so it is on screen
 * whichever tab is open — including the one the work does not belong to.
 */
export function TaskRunStrip({ tasks, interrupted, onCancel, onDismiss, onDismissInterrupted }) {
  const list = Object.values(tasks || {});
  const hasInterrupted = (interrupted || []).length > 0;
  if (list.length === 0 && !hasInterrupted) return null;

  return (
    <div className="border-b border-primary/15 bg-primary/5 px-3 py-2 space-y-1.5 shrink-0">
      {hasInterrupted && (
        <div className="flex items-start gap-2 text-[10px] text-ink-max">
          <AlertTriangle size={12} className="text-yellow-500 shrink-0 mt-0.5" />
          <span className="flex-1">
            {interrupted.map((i) => `${i.label}${i.total ? ` (${i.done} of ${i.total})` : ''}`).join(', ')} was interrupted by a page reload and cannot resume — start it again when you are ready.
          </span>
          <button onClick={onDismissInterrupted} className="text-primary/50 hover:text-primary shrink-0" title="Dismiss"><X size={12} /></button>
        </div>
      )}

      {list.map((t) => {
        const running = t.status === 'running';
        return (
          <div key={t.key} className="flex items-center gap-2 text-[10px]">
            {running
              ? <Loader2 size={12} className="animate-spin text-cyan-400 shrink-0" />
              : t.status === 'done' ? <Check size={12} className="text-primary shrink-0" />
                : t.status === 'cancelled' ? <Ban size={12} className="text-primary/50 shrink-0" />
                  : <AlertTriangle size={12} className="text-red-400 shrink-0" />}
            <span className="text-ink-max shrink-0">{t.label}</span>
            {running ? (
              <EtaTimer startedAt={t.startedAt} estimateMs={t.estimateMs} detail={t.detail} onCancel={() => onCancel(t.key)} className="flex-1" />
            ) : (
              <span className="flex-1 text-ink-max truncate">
                {t.status === 'done' ? 'done' : t.status === 'cancelled' ? 'stopped' : t.error}
              </span>
            )}
            {!running && (
              <button onClick={() => onDismiss(t.key)} className="text-primary/50 hover:text-primary shrink-0" title="Dismiss"><X size={12} /></button>
            )}
          </div>
        );
      })}
    </div>
  );
}
