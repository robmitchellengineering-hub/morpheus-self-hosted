import { useEffect, useState } from 'react';

// 2026-09-03 (Rob: "stream the progress with an eta time and what its doin
// step by step in the chat window") — replaces the old cycling decorative
// status phrases (MorpheusThinking) with the REAL build pipeline steps as
// they actually happen: Planning -> Writing the code -> Reviewing -> etc
// (see chatWithMorpheus.js's streamed {type:'stage',...} events, threaded
// through here via useWorkspace.js's pipelineStages). Each stage shows a
// live countdown against an ETA computed from this deployment's own recent
// call latency (server/src/lib/timingStats.js) — a real, self-correcting
// estimate, not a made-up number, though it's still just an average and can
// run over on an unusually large step.
//
// `stages` is the ordered array ChatPanel passes straight from
// useWorkspace().pipelineStages: [{ stage, label, status: 'active'|'done',
// etaSeconds, elapsedSeconds, startedAt }]. Ticks its own 1s interval purely
// to force a re-render for the live countdown — it doesn't own any of the
// actual stage state.
export default function MorpheusPipelineStatus({ stages }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!stages || stages.length === 0) return null;

  const totalElapsedSeconds = Math.max(0, Math.round((Date.now() - stages[0].startedAt) / 1000));

  return (
    <div className="flex items-start gap-3">
      {/* 2026-09-03 (Rob: "add a larger animation that looks like its
          thinking rotating around") — a big, unmissable spinning ring next
          to the step list, distinct from the small 12px Loader2 icons used
          elsewhere in this panel (voice button, revert confirm). Pure CSS
          border-spin, no extra asset/library. */}
      <div
        className="h-11 w-11 shrink-0 rounded-full border-[3px] border-primary/15 border-t-primary animate-spin shadow-[0_0_14px_rgba(0,255,65,0.45)]"
        aria-hidden="true"
      />
      <div className="space-y-1 flex-1 min-w-0">
        {stages.map((s, i) => {
          const isActive = s.status === 'active';
          const remaining = isActive ? Math.round(s.etaSeconds - (Date.now() - s.startedAt) / 1000) : null;
          return (
            <div key={`${s.stage}-${i}`} className="flex items-baseline gap-2">
              <span className={isActive ? 'text-primary animate-pulse' : 'text-primary/50'} aria-hidden="true">
                {isActive ? '>' : '✓'}
              </span>
              <span className={isActive ? 'text-primary' : 'text-primary/50'}>{s.label}</span>
              {isActive && (
                <span className="text-ink/60 text-xs tabular-nums">
                  {remaining > 0 ? `~${formatDuration(remaining)} remaining` : 'finishing up...'}
                </span>
              )}
              {!isActive && s.elapsedSeconds != null && (
                <span className="text-ink/35 text-xs tabular-nums">{formatDuration(s.elapsedSeconds)}</span>
              )}
            </div>
          );
        })}
        <div className="text-ink/40 text-[10px] pt-0.5">total elapsed: {formatDuration(totalElapsedSeconds)}</div>
      </div>
    </div>
  );
}

function formatDuration(totalSeconds) {
  const clamped = Math.max(0, totalSeconds);
  if (clamped < 60) return `${clamped}s`;
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}m ${s}s`;
}
