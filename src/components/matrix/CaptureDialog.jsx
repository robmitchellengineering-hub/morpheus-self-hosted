import { useState, useEffect, useRef } from 'react';
import { Activity, X, Upload, Check, AlertTriangle, Download } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Capture: record your own amp, and find out whether it can be trained on BEFORE you spend an hour of GPU time.
//
// WHY THIS PANEL EXISTS. Every NAM user has met the failure where a model comes out wrong — a misaligned take,
// a clipped one, a re-amp signal too quiet to have driven the amp, a knob that moved mid-recording — and the
// only instrument anyone has is listening to it and guessing. All of those are measurable, and the measurement
// says WHICH one it is. That is what this runs: the trainer's own pre-flight, reproduced from its source, so
// the verdict here is the verdict the trainer will reach rather than a second opinion.
//
// IT RUNS ON THE SERVER AND STORES NOTHING. The two recordings are ~27 MB each and they are the user's; the
// endpoint reads a verdict out of the bytes and drops them. Nothing is written to the project, which is also
// why the model — not the recording — is the artefact this pathway produces.
//
// WHAT IT DOES NOT DO, said plainly rather than discovered: it does not train. Training a NAM model is PyTorch
// on a GPU, hours of it, and it happens on the user's own machine. This is the part before and after it.
const ACCEPT = '.wav,audio/wav,audio/x-wav,audio/*';

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : String(v));

function Row({ label, value, tone = 'ink' }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="text-[10px] text-primary/50 tracking-widest font-display w-24 shrink-0">{label}</span>
      <span className={tone === 'bad' ? 'text-red-400' : 'text-ink-strong'}>{value}</span>
    </div>
  );
}

function Pick({ which, label, hint, file, onPick, inputRef, about }) {
  return (
    <div className="border border-primary/25 p-3 space-y-2">
      <p className="text-[10px] text-primary/50 tracking-widest font-display">{label}</p>
      <p className="text-xs text-ink-strong leading-snug">{hint}</p>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => onPick(which, e.target.files?.[0])}
      />
      <button
        onClick={() => inputRef.current?.click()}
        className="w-full flex items-center justify-center gap-2 py-1.5 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary transition-colors text-xs"
      >
        {file ? <Check size={12} /> : <Upload size={12} />} {file ? file.name : `CHOOSE ${which.toUpperCase()} WAV`}
      </button>
      {/* The re-amp signal has to be ONE SPECIFIC FILE — the trainer identifies its input by MD5 and refuses
          anything else — so the link and the hash are both here. A user who records against a signal they
          cannot train on has wasted an afternoon, and nothing in the trainer's error says so. */}
      {which === 'input' && about?.inputUrl && (
        <div className="text-[10px] text-ink-max leading-snug border-t border-primary/20 pt-2">
          <a href={about.inputUrl} target="_blank" rel="noreferrer" className="text-primary/70 hover:text-primary inline-flex items-center gap-1">
            <Download size={10} /> Download the re-amp signal NAM's trainer accepts
          </a>
          <span className="block font-mono mt-1 break-all">MD5 {about.inputMd5}</span>
          <span className="block mt-1">
            Play it through your amp, record the amp at {about.inputFilename ? 'the same sample rate and length' : 'the same rate and length'},
            then put both files here. It has to be this file — the trainer refuses any other input by hash.
          </span>
        </div>
      )}
    </div>
  );
}

export default function CaptureDialog({ open, onClose }) {
  const [files, setFiles] = useState({ input: null, recorded: null });
  const [about, setAbout] = useState(null);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const recRef = useRef(null);

  // The constants come from the server rather than being typed here, so the download link and the MD5 the
  // trainer recognises cannot drift from the module that enforces them. A failure is not fatal: the panel
  // still works without the link, it just cannot say where to get the signal, so it shows nothing rather than
  // an empty box. Loaded on open, once, and never during a render.
  useEffect(() => {
    if (!open || about) return;
    let live = true;
    base44.functions.captureAbout().then((a) => { if (live) setAbout(a); }).catch(() => { if (live) setAbout({}); });
    return () => { live = false; };
  }, [open, about]);

  if (!open) return null;

  const reset = () => { setResult(null); setErr(null); };

  const pick = (which, file) => {
    reset();
    if (file) setFiles((f) => ({ ...f, [which]: file }));
  };

  const run = async () => {
    reset();
    if (!files.input || !files.recorded) { setErr('Both files are needed — the signal you played, and the recording of the amp.'); return; }
    setBusy(true);
    try {
      // Through the client wrapper, which adds the bearer token and leaves FormData alone. A multipart body
      // sent with a JSON content-type is the classic way an upload arrives empty.
      const form = new FormData();
      form.append('input', files.input);
      form.append('recorded', files.recorded);
      setResult(await base44.functions.checkCapture(form));
    } catch (e) {
      setErr(e?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const f = result?.facts;
  const fails = (result?.issues || []).filter((i) => i.level === 'fail');
  const warns = (result?.issues || []).filter((i) => i.level !== 'fail');

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto scrollbar-matrix border border-primary/40 bg-background shadow-[0_0_20px_rgba(0,255,65,0.2)]">
        <div className="flex items-center justify-between border-b border-primary/20 px-4 py-3 sticky top-0 bg-background">
          <div className="flex items-center gap-2">
            <Activity size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider neon-glow">CAPTURE CHECK</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>

        <div className="p-4 space-y-4 text-xs text-ink-strong leading-relaxed">
          <p>
            Play the re-amp signal through your amp, record what comes out, and put both files here. The check
            runs NAM&apos;s trainer&apos;s own rules — sample rate, length, whether the amp held still for the whole
            take, and the delay it will be aligned at — plus the things it does not look at and a capture still
            dies of: clipping, DC, and a take too quiet to have driven the amp.
          </p>
          <p className="text-[10px] text-ink-max">
            Nothing is uploaded anywhere it is kept: the two files are read for a verdict and dropped. And this
            does not train — training runs on your own machine, with a GPU.
          </p>

          <Pick which="input" label="// 1. THE SIGNAL YOU PLAYED" hint="The re-amp signal itself, as a .wav."
            file={files.input} onPick={pick} inputRef={inputRef} about={about} />
          <Pick which="recorded" label="// 2. THE AMP" hint="Your recording of the amp's output — same sample rate, and no shorter."
            file={files.recorded} onPick={pick} inputRef={recRef} about={about} />

          <button
            onClick={run}
            disabled={busy || !files.input || !files.recorded}
            className="w-full flex items-center justify-center gap-2 py-2 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary disabled:opacity-30 transition-colors text-xs"
          >
            {busy ? <Activity size={14} className="animate-pulse" /> : <Activity size={14} />} {busy ? 'READING BOTH FILES…' : 'CHECK THIS CAPTURE'}
          </button>

          {err && (
            <p className="text-yellow-500/90 border border-yellow-500/30 px-2 py-2">{err}</p>
          )}

          {result && (
            <div className="border-t border-primary/20 pt-3 space-y-2">
              <p className={`text-sm font-display tracking-wider ${result.ok ? 'text-primary' : 'text-red-400'}`}>
                {result.ok ? 'THIS PAIR WILL TRAIN' : 'THIS PAIR WILL NOT TRAIN AS IT IS'}
              </p>

              <div className="space-y-1">
                <Row label="INPUT" value={`${f.inputVersion ? `NAM v${f.inputVersion}` : 'unrecognised'} · ${f.inputRate} Hz · ${f.inputFrames.toLocaleString()} frames`}
                  tone={f.inputVersion ? 'ink' : 'bad'} />
                <Row label="RECORDED" value={`${f.recordedRate} Hz · ${f.recordedFrames.toLocaleString()} frames${f.recordedRate === f.inputRate ? ` · ${f.deltaSeconds >= 0 ? '+' : ''}${fmt(f.deltaSeconds, 3)} s` : ''}`} />
                {f.recordedPeakDb !== undefined && (
                  <Row label="LEVEL" value={`peak ${fmt(f.recordedPeakDb, 2)} dBFS · rms ${fmt(f.recordedRmsDb, 1)} dBFS · ${f.clippedSamples} clipped`}
                    tone={f.clippedSamples > 0 ? 'bad' : 'ink'} />
                )}
                {f.replicateEsr !== undefined && (
                  <Row label="HELD STILL" value={`replicate ESR ${f.replicateEsr.toExponential(3)} (limit 0.01)`} tone={f.replicateEsr <= 0.01 ? 'ink' : 'bad'} />
                )}
                {f.latency && (
                  <Row label="DELAY" value={f.latency.detected
                    ? `${f.latency.delay} samples (${fmt((f.latency.delay / f.inputRate) * 1000, 3)} ms) — what the trainer will align at`
                    : `not detected — nothing beat the trigger of ${f.latency.threshold.toExponential(2)}`}
                  tone={f.latency.detected ? 'ink' : 'bad'} />
                )}
              </div>

              {result.issues.length === 0 && <p className="text-xs text-ink-strong">Nothing to fix. Record it again at these settings and train.</p>}

              {[...fails, ...warns].map((i) => (
                <div key={i.what} className={`border px-2 py-2 ${i.level === 'fail' ? 'border-red-500/40' : 'border-yellow-500/30'}`}>
                  <p className={`flex items-center gap-1.5 ${i.level === 'fail' ? 'text-red-400' : 'text-yellow-500/90'}`}>
                    {i.level === 'fail' ? <X size={12} /> : <AlertTriangle size={12} />}
                    <span className="font-display tracking-wider">{i.what}</span>
                  </p>
                  <p className="text-ink-strong mt-1">{i.detail}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
