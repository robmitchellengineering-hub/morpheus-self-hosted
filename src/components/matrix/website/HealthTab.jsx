import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Loader2, RefreshCw, ExternalLink, AlertTriangle, Check, ShieldCheck, Server, Package, Clock,
  Save, CalendarClock, X, Wrench, ListChecks, Zap, ArrowDown,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';

// SITE HEALTH tab — what WordPress's own Site Health screen and Morpheus's own
// checks say about the operator's live site, in one place.
//
// Provenance is never blurred: each finding carries the server's own
// `sourceLabel`, so WordPress's verdict and Morpheus's checks stay distinct. An
// absent test is not a pass either, so `async_not_run` is shown quietly.
//
// The server derives everything judgeable (`summary`, `attention`, `freshness`,
// `can_apply`, `update_plan`); this file renders those values and never recounts
// a severity. The scan itself stays read-only; changing the live site is a
// separate, twice-confirmed APPLY NOW below, and every outcome it reports is
// rendered as sent.
//
// A finding may also carry ONE `fix`. The control is built only from `fix.kind`
// and the payload's own words, so a finding with no fix (or `kind: 'none'`) gets
// no button rather than a dead one; a fix never becomes a "Done" the site did not
// report, and a fix that reported `verified: false` is never shown as done.

const micro = 'text-[9px] text-primary/35 uppercase tracking-wider';
const faint = 'text-[9px] text-primary/30';
const btn = 'inline-flex items-center justify-center gap-1.5 px-3 h-[32px] border border-primary/30 text-[10px] uppercase tracking-wider text-primary/80 hover:text-primary hover:border-primary disabled:opacity-40 shrink-0';
const kvRow = 'grid grid-cols-[1fr_auto] gap-2 border-b border-primary/10 py-1.5 last:border-b-0';

const statusChip = (s) => (s === 'critical' ? 'text-red-400 border-red-500/30'
  : s === 'recommended' ? 'text-yellow-500/85 border-yellow-500/30' : 'text-primary/45 border-primary/20');
const statusWord = (s) => (s === 'critical' ? 'needs attention' : s === 'recommended' ? 'recommended' : s);

// core_minor / core_major are WordPress settings, not booleans: the literal
// "unset" means no override, so it must never be shown to the operator raw.
const coreSetting = (v) => (v === 'unset' || v === null || v === undefined ? 'WordPress default'
  : v === true ? 'On' : v === false ? 'Off' : String(v));
const plain = (v) => (typeof v === 'string' ? v : v?.label || v?.description || v?.id);

// --- scheduled checks --------------------------------------------------------
// Every derived value in `policy` is the server's and is shown as sent.
// `allow_core_major_manual` is NOT editable: it records that a human may be
// OFFERED a major update, which is not permission to apply one.
const EDITABLE = ['scan_enabled', 'day_of_month', 'hour_utc', 'apply_plugins', 'apply_themes', 'apply_core_minor'];
const editableOf = (p) => EDITABLE.reduce((o, k) => { o[k] = p[k]; return o; }, {});
const sameEditable = (a, b) => !!a && !!b && EDITABLE.every((k) => a[k] === b[k]);
const DAYS_OF_MONTH = Array.from({ length: 28 }, (_, i) => i + 1);
const HOURS_UTC = Array.from({ length: 24 }, (_, h) => h);
const pad2 = (n) => String(n).padStart(2, '0');
const ORD = (d) => `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const sel = 'mt-1 w-full bg-transparent border border-primary/20 px-1.5 py-1 text-[11px] text-primary/85 outline-none focus:border-primary/50 disabled:opacity-40';
// The schedule runs in UTC, so its own date is shown in UTC too — rendering it in
// the visitor's local time would make the two disagree.
const utcStamp = (ms) => {
  const d = new Date(Number(ms));
  return !(Number(ms) > 0) || Number.isNaN(d.getTime()) ? null
    : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} at ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
};
const KIND_WORD = { plugin: 'plugin', theme: 'theme', core_minor: 'minor WordPress', core_major: 'major WordPress' };
const wordList = (k) => { const w = k.map((x) => KIND_WORD[x] || x); return w.length > 1 ? `${w.slice(0, -1).join(', ')} and ${w.at(-1)}` : w[0]; };

/** A switch that says, under its own label, what it would do. */
function Toggle({ label, hint, on, onChange, disabled }) {
  return (
    <button type="button" onClick={() => onChange(!on)} disabled={disabled}
      className={`w-full text-left flex items-start gap-2 border px-2.5 py-2 disabled:opacity-40 ${on ? 'border-primary/40' : 'border-primary/15'}`}>
      <span className={`mt-[3px] shrink-0 w-[26px] h-[14px] border relative ${on ? 'border-primary/60 bg-primary/20' : 'border-primary/30'}`}>
        <span className={`absolute top-[2px] w-[8px] h-[8px] ${on ? 'right-[2px] bg-primary/80' : 'left-[2px] bg-primary/35'}`} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] text-primary/85 break-words">{label}</span>
        {hint ? <span className="block text-[9px] text-primary/40 leading-relaxed">{hint}</span> : null}
      </span>
      <span className={`shrink-0 text-[9px] uppercase tracking-wider ${on ? 'text-primary/80' : 'text-primary/35'}`}>{on ? 'On' : 'Off'}</span>
    </button>
  );
}

function KV({ k, v }) {
  return (
    <div className={kvRow}>
      <div className="text-[10px] text-primary/45">{k}</div>
      <div className="text-[11px] text-primary/80 text-right break-words">{v}</div>
    </div>
  );
}

function Section({ icon, title, children }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className={micro}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function UpdateRow({ name, kind, from, to, strong }) {
  return (
    <div className={`border px-3 py-2 ${strong ? 'border-primary/30' : 'border-primary/15'}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] text-primary/85 break-words">{name}</span>
        {kind ? <span className={`${faint} shrink-0`}>{kind}</span> : null}
      </div>
      <div className="text-[10px] text-primary/55">{from || '—'} → {to || '—'}</div>
    </div>
  );
}

/** What the site said it did with one fix, rendered as sent and never embellished. */
function FixResult({ result }) {
  if (!result || result.state !== 'settled') return null;
  const f = result.fix || {};

  // A 200 with ok:false is the SITE declining (a guided finding, or nothing
  // registered for that id) — an answer to render as information, not a crash.
  if (result.ok !== true) {
    return (
      <div className="border border-primary/15 px-2.5 py-2 space-y-1">
        <div className="text-[10px] text-primary/70 leading-relaxed break-words">
          {f.error || 'The site did not carry this out, and said nothing was changed.'}
        </div>
        <div className={faint}>
          The site&apos;s own answer{f.code ? ` (${f.code})` : ''} — the request reached it, it declined.
        </div>
      </div>
    );
  }

  // `verified === false` outranks `ok`: the write was attempted and did not hold,
  // so "Done" would be a lie even though the site called the run a success.
  const didNotVerify = f.verified === false;
  if (didNotVerify || f.error) {
    return (
      <div className="border border-red-500/30 bg-red-500/5 px-2.5 py-2 space-y-1">
        <div className="flex items-center gap-1.5">
          <AlertTriangle size={11} className="shrink-0 text-red-300" />
          <span className="text-[9px] uppercase tracking-wider text-red-300/90">
            {didNotVerify ? 'Did not verify' : 'Failed'}
          </span>
        </div>
        <div className="text-[10px] text-red-300/90 leading-relaxed break-words">
          {didNotVerify
            ? 'The change did not verify, so it cannot be counted as done.'
            : (f.error || 'The site reported that this failed.')}
        </div>
        {didNotVerify && f.error ? (
          <div className="text-[10px] text-red-300/80 leading-relaxed break-words">{f.error}</div>
        ) : null}
        {f.did ? <div className={faint}>The site said it did: {f.did}</div> : null}
        {f.restored === true ? (
          <div className="text-[10px] text-yellow-500/85 leading-relaxed">
            The previous state was put back, so nothing was left changed this time.
          </div>
        ) : null}
        {f.note ? <div className={`${faint} leading-relaxed break-words`}>{f.note}</div> : null}
      </div>
    );
  }

  return (
    <div className="border border-green-500/30 bg-green-500/5 px-2.5 py-2 space-y-1">
      <div className="flex items-center gap-1.5">
        <Check size={11} className="shrink-0 text-green-400/90" />
        <span className="text-[9px] uppercase tracking-wider text-green-400/90">Done</span>
      </div>
      <div className="text-[10px] text-primary/70 leading-relaxed break-words">
        {f.did || 'The site carried this out.'}
      </div>
      {f.restored === true ? (
        <div className="text-[10px] text-yellow-500/85 leading-relaxed">The previous state was put back.</div>
      ) : null}
      {f.note ? <div className={`${faint} leading-relaxed break-words`}>{f.note}</div> : null}
      <div className={faint}>RESCAN above re-reads the site, so this line is checked rather than assumed.</div>
    </div>
  );
}

/**
 * The one control a finding may carry, built only from `fix.kind`.
 *
 *   auto    — FIX, with the payload's `does` above it and a two-step inline
 *             confirm (never window.confirm) whenever `warning` is set
 *   guided  — GUIDE ME: expands the payload's own numbered steps in place and
 *             ends with RE-CHECK, so Morpheus confirms the result itself
 *   updates — no fix button: the work belongs to the Updates section, so the
 *             control goes there and says why
 *
 * `none`, an unknown kind or an absent fix render nothing at all.
 */
function FixBox({
  t, fix, busy = false, paused = false, result, onFix, onRescan, scanning = false,
  onJumpToUpdates, siteName,
}) {
  // Local to this finding: step two of the confirm, and whether the guide is open.
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState(false);

  if (!fix || fix.kind === 'none') return null;

  if (fix.kind === 'updates') {
    return (
      <div className="space-y-1.5 border-t border-primary/10 pt-1.5">
        <div className="text-[10px] text-primary/50 leading-relaxed break-words">
          These are the updates in the Updates section below — apply them there, and each one is snapshotted before it is touched.
        </div>
        {fix.warning ? (
          <div className="border border-yellow-500/30 px-2.5 py-1.5 text-[10px] text-yellow-500/85 leading-relaxed break-words">
            {fix.warning}
          </div>
        ) : null}
        <button className={btn} onClick={onJumpToUpdates}>
          <ArrowDown size={12} /> GO TO UPDATES
        </button>
      </div>
    );
  }

  if (fix.kind === 'guided') {
    return (
      <div className="space-y-1.5 border-t border-primary/10 pt-1.5">
        {/* The payload's own sentence, never a rewritten one. */}
        {fix.does ? <div className="text-[10px] text-primary/50 leading-relaxed break-words">{fix.does}</div> : null}
        {fix.warning ? (
          <div className="border border-yellow-500/30 px-2.5 py-1.5 text-[10px] text-yellow-500/85 leading-relaxed break-words">
            {fix.warning}
          </div>
        ) : null}
        <button className={btn} onClick={() => setOpen((v) => !v)}>
          <ListChecks size={12} /> {open ? 'HIDE STEPS' : 'GUIDE ME'}
        </button>
        {open ? (
          <div className="space-y-2 border border-primary/15 px-2.5 py-2">
            <div className={micro}>Do these, then re-check</div>
            <ol className="space-y-1.5">
              {fix.steps.map((s, i) => (
                <li key={`${s.text}-${i}`} className="flex items-start gap-1.5">
                  <span className="mt-[1px] w-[14px] shrink-0 text-[10px] text-primary/45">{i + 1}.</span>
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="block text-[10px] text-primary/70 leading-relaxed break-words">{s.text}</span>
                    {s.link ? (
                      <a href={s.link} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[10px] text-primary/80 underline break-all hover:text-primary">
                        <ExternalLink size={10} className="shrink-0" /> Open this step
                      </a>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
            <button className={btn} onClick={onRescan} disabled={scanning}>
              {scanning ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} RE-CHECK
            </button>
            <div className={faint}>
              RE-CHECK runs the scan again, so Morpheus confirms this itself instead of taking it on trust.
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  // fix.kind === 'auto'
  return (
    <div className="space-y-1.5 border-t border-primary/10 pt-1.5">
      <div className="text-[10px] text-primary/50 leading-relaxed break-words">{fix.does}</div>
      {fix.warning ? (
        <div className="border border-yellow-500/30 px-2.5 py-1.5 text-[10px] text-yellow-500/85 leading-relaxed break-words">
          {fix.warning}
        </div>
      ) : null}

      {confirming ? (
        // Step two of two. Nothing has been sent: only the button below calls the
        // server, and it is only reached at all because `warning` was set.
        <div className="border border-yellow-500/30 px-2.5 py-2 space-y-2">
          <div className="text-[11px] text-primary/85 leading-relaxed">
            {fix.warning ? 'This one has a real consequence — do it anyway?' : `Do this on ${siteName} now?`}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className={`${btn} border-yellow-500/40`}
              onClick={() => { setConfirming(false); onFix(t); }} disabled={busy}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />} {busy ? 'FIXING' : 'YES, FIX IT'}
            </button>
            <button className={btn} onClick={() => setConfirming(false)} disabled={busy}>
              <X size={12} /> CANCEL
            </button>
          </div>
          <div className={faint}>Nothing has been sent yet.</div>
        </div>
      ) : (
        <button className={btn} onClick={() => (fix.warning ? setConfirming(true) : onFix(t))} disabled={busy || paused}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />} {fix.label || 'FIX'}
        </button>
      )}

      {busy ? (
        <div className={faint}>Sending to {siteName} — the rest of this page stays as it is.</div>
      ) : null}
      {paused && !busy ? (
        <div className={faint}>FIX ALL is running — this button starts again when it has finished.</div>
      ) : null}
      <FixResult result={result} />
    </div>
  );
}

/** One finding, rendered so the server's own source label is unmissable. */
function Finding({
  t, quiet = false, siteName, fixBusy = false, fixPaused = false, fixResult,
  onFix, onRescan, scanning = false, onJumpToUpdates,
}) {
  const links = t.links || [];
  return (
    <div className={`border px-3 py-2.5 space-y-1.5 ${quiet ? 'border-primary/15' : t.status === 'critical' ? 'border-red-500/30' : 'border-yellow-500/30'}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-primary/85 break-words">{t.label}</div>
          <div className={`${micro} mt-0.5`}>{t.sourceLabel || 'Unknown source'}{t.badge ? ` · ${t.badge}` : ''}</div>
        </div>
        <span className={`shrink-0 border px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${statusChip(t.status)}`}>{statusWord(t.status)}</span>
      </div>
      {/* The description is shown in full, not truncated: when a finding carries
          no link, this text is the entire reason it matters. */}
      <p className={`${quiet ? 'text-[10px] text-primary/45' : 'text-[11px] text-primary/65'} leading-relaxed break-words`}>
        {t.description}
      </p>
      {links.map((l, i) => (
        <a key={`${l.url}-${i}`} href={l.url} target="_blank" rel="noreferrer"
          className="flex items-start gap-1.5 text-[11px] text-primary/80 underline break-all hover:text-primary">
          <ExternalLink size={11} className="mt-[2px] shrink-0" />{l.label || l.url}
        </a>
      ))}
      {/* The action, when the payload carries one — and nothing at all when it does not. */}
      {t.fix ? (
        <FixBox t={t} fix={t.fix} busy={fixBusy} paused={fixPaused} result={fixResult}
          onFix={onFix} onRescan={onRescan} scanning={scanning}
          onJumpToUpdates={onJumpToUpdates} siteName={siteName} />
      ) : null}
    </div>
  );
}

// --- what a run actually did ------------------------------------------------
// The server sends the outcome already grouped; this renders those groups as
// sent. `applied` is the only group allowed to say anything was done, a dry run
// is labelled as one wherever it could be mistaken for a change, and an empty
// group is never rendered — a heading with nothing under it reads as a result.
const TONE_BOX = {
  green: 'border-green-500/30 bg-green-500/5',
  yellow: 'border-yellow-500/30',
  red: 'border-red-500/30 bg-red-500/5',
  loud: 'border-red-500/50 bg-red-500/10',
};
const TONE_TEXT = {
  green: 'text-green-400/90',
  yellow: 'text-yellow-500/85',
  red: 'text-red-300/90',
  loud: 'text-red-300',
};

function OutcomeGroup({ tone = 'yellow', title, note, items, icon }) {
  if (!items || items.length === 0) return null;
  return (
    <div className={`border px-3 py-2 space-y-1 ${TONE_BOX[tone] || TONE_BOX.yellow}`}>
      <div className="flex items-center gap-1.5">
        {icon}
        <span className={`text-[9px] uppercase tracking-wider ${TONE_TEXT[tone] || TONE_TEXT.yellow}`}>{title}</span>
      </div>
      {note ? <div className="text-[9px] text-primary/45 leading-relaxed">{note}</div> : null}
      {items.map((it, i) => (
        <div key={`${it}-${i}`} className="flex items-start gap-1.5 text-[11px] text-primary/80">
          <span className="mt-[5px] shrink-0 w-[3px] h-[3px] bg-primary/40" />
          <span className="min-w-0 flex-1 break-words">{it}</span>
        </div>
      ))}
    </div>
  );
}

/** The server's own report of a manual run — every group it sent, and nothing inferred. */
function ApplyReport({ outcome: o }) {
  const dry = o.dryRun === true;
  const applied = o.applied || [];
  const restored = o.restored || [];
  const restoreFailed = o.restoreFailed || [];
  const failed = o.failed || [];
  const skipped = o.skipped || [];
  const nothingHappened = o.attempted !== false && !o.error
    && applied.length === 0 && failed.length === 0 && restored.length === 0 && restoreFailed.length === 0;
  return (
    <div className="border border-primary/15 px-3 py-2.5 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-primary/80">
          {dry ? 'CHECK FIRST · dry run' : 'APPLY NOW · result'}
        </span>
        <span className={`${faint} shrink-0`}>{dry ? 'nothing changed' : 'live site'}</span>
      </div>

      {dry ? (
        <div className="border border-yellow-500/30 px-2.5 py-2 text-[10px] text-yellow-500/85 leading-relaxed">
          Dry run — nothing was changed. Everything below is only what the site said it would do.
        </div>
      ) : null}

      {o.error ? (
        <div className="border border-red-500/30 bg-red-500/5 px-3 py-2 space-y-1">
          <div className="text-[11px] text-red-300/90 leading-relaxed break-words">
            {o.error || o.message}
          </div>
          {o.code ? <div className={faint}>{o.code}</div> : null}
        </div>
      ) : null}

      {o.attempted === false && !o.error ? (
        <div className="border border-primary/15 px-2.5 py-2 text-[10px] text-primary/60 leading-relaxed">
          {o.message || 'There was nothing for Morpheus to apply.'}
        </div>
      ) : null}

      {/* Nothing is put back silently, and a put-back that failed outranks the rest. */}
      <OutcomeGroup tone="loud" items={restoreFailed} icon={<AlertTriangle size={11} className="shrink-0 text-red-300" />}
        title={dry ? 'Would need attention now — could not be put back' : 'Needs attention now — could not be put back'}
        note={dry
          ? 'On a real run these would be left on the new version, so the site could be left in a state that does not work.'
          : 'These are not on the version they were on before this run, and Morpheus could not put them back. Check this site now.'} />

      <OutcomeGroup tone="red" items={failed}
        title={dry ? 'Would fail' : 'Failed'}
        note={dry
          ? 'On a real run these would not install, or would not verify after installing.'
          : 'These did not install, or installed without verifying. They are not updated.'} />

      <OutcomeGroup tone="yellow" items={restored}
        title={dry ? 'Would be put back — the update did not verify' : 'Put back — the update did not verify'}
        note={dry
          ? 'Morpheus would reinstall these from the snapshot taken before they were touched.'
          : 'Morpheus put these back from the snapshot taken before they were touched.'} />

      <OutcomeGroup tone="green" items={applied}
        title={dry ? 'Would update and verify' : 'Done — updated and verified'} />

      {/* The owner's own policy limits, not failures — so they are muted, never red. */}
      {skipped.length > 0 ? (
        <div className="border-t border-primary/10 pt-1.5 space-y-1">
          <div className={micro}>Skipped · your policy, not an error</div>
          {skipped.map((s, i) => (
            <div key={`${s}-${i}`} className="text-[10px] text-primary/45 break-words">{s}</div>
          ))}
        </div>
      ) : null}

      {nothingHappened ? (
        <div className="text-[10px] text-primary/55 leading-relaxed">
          {dry ? 'The site reported no update it would apply.' : 'No updates were applied.'}
        </div>
      ) : null}
    </div>
  );
}

/** The FIX ALL tally in words, with a clause only for what actually happened. */
const fixAllWords = (t) => {
  const said = [];
  if (t.done) said.push(`${t.done} done and verified`);
  if (t.unverified) said.push(`${t.unverified} did not verify`);
  if (t.failed) said.push(`${t.failed} failed`);
  if (t.declined) said.push(`${t.declined} declined by the site`);
  if (t.rejected) said.push(`${t.rejected} could not be sent`);
  return `FIX ALL finished — ${said.join(', ')}. The findings below are from the fresh scan taken after it.`;
};

export default function HealthTab({ projectId }) {
  const [scan, setScan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [policy, setPolicy] = useState(null);       // the saved policy + the server's own wording
  const [draft, setDraft] = useState(null);         // what the owner has changed but not saved
  const [saving, setSaving] = useState(false);
  const [policyErr, setPolicyErr] = useState(null);
  const [policySaved, setPolicySaved] = useState(null);
  const [applying, setApplying] = useState(null);     // null | 'check' | 'apply' — which request is in flight
  const [confirming, setConfirming] = useState(false); // APPLY NOW clicked once; nothing sent yet
  const [outcome, setOutcome] = useState(null);        // the server's own report of the last run
  const [runErr, setRunErr] = useState(null);          // { message, dryRun }
  // Per-finding fixes. `fixingIds` is the finding ids with a request actually in
  // flight, so one finding's button can spin without freezing the page.
  const [fixingIds, setFixingIds] = useState([]);
  const [fixResults, setFixResults] = useState({});     // finding id -> { state, ok, fix } | { state: 'rejected', message, code }
  const [fixAllRunning, setFixAllRunning] = useState(false);
  const [fixAllConfirming, setFixAllConfirming] = useState(false);
  const [fixAllProgress, setFixAllProgress] = useState(null); // { index, total, label }
  const [fixAllReport, setFixAllReport] = useState(null);     // the run's own tally, in words
  // The Updates section, so an `updates` finding can send the operator to it.
  const updatesRef = useRef(null);
  const [updatesFlash, setUpdatesFlash] = useState(false);
  const flashTimer = useRef(null);

  const run = useCallback(async (force) => {
    // The previous scan stays on screen while this one runs. Blanking the tab
    // would hide exactly the findings the operator is reading.
    setLoading(true); setErr(null);
    try {
      const res = await base44.functions.invoke('siteHealth', { projectId, action: 'scan', force: !!force });
      if (!res?.data) throw new Error('The scan came back empty — try again.');
      setScan(res.data);
      // The scan carries the policy, so there is no second round trip to make.
      // It seeds the draft once: a later scan must not overwrite unsaved edits.
      if (res.data.policy) { setPolicy(res.data.policy); setPolicyErr(null); setDraft((d) => d || editableOf(res.data.policy)); }
    } catch (e) {
      setErr(e?.data?.error || e.message);
      // The schedule is Morpheus's own data, not WordPress's, so a failed scan
      // must not take the one writable control down with it. If this read fails
      // too the scan error above is on screen and RESCAN retries both.
      try {
        const res = await base44.functions.invoke('siteHealth', { projectId, action: 'policy' });
        if (res?.data) { setPolicy(res.data); setDraft((d) => d || editableOf(res.data)); }
      } catch { /* the scan error above is the message that matters */ }
    } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { run(false); }, [run]);

  // A manual run, in one of two modes. `confirm: true` is required per
  // invocation — the policy says what MAY happen on a schedule, this says a
  // person asked for it now — and the dry run sends the same call with
  // `dry_run: true`, which asks the site to report without writing.
  const runApply = async (dryRun) => {
    if (applying) return;
    setRunErr(null); setOutcome(null);
    setApplying(dryRun ? 'check' : 'apply');
    try {
      const res = await base44.functions.invoke('siteHealth', {
        projectId, action: 'apply', confirm: true, dry_run: dryRun,
      });
      const out = res?.data?.outcome;
      if (!out) throw new Error('The server returned no result, so nothing can be shown as done.');
      setOutcome(out);
      // A real apply changes the live site, so the update list on screen is now
      // stale. The report stays up while the fresh scan replaces the list.
      if (!dryRun) await run(true);
    } catch (e) {
      setRunErr({ message: e?.data?.error || e.message, dryRun });
    } finally { setApplying(null); setConfirming(false); }
  };

  // One fix, sent to the site and reported exactly as the site answers. A 200
  // with `ok: false` is the site DECLINING (a guided finding, or nothing
  // registered for that id) — an answer to render as information, never a crash.
  // A rejection carries the server's own message; the page stays on screen.
  const applyFix = useCallback(async (finding) => {
    const id = finding?.id;
    if (!id) return { id: '', rejected: true, message: 'This finding has no id, so no fix could be sent.' };
    setFixResults((r) => ({ ...r, [id]: { state: 'busy' } }));
    setFixingIds((s) => (s.includes(id) ? s : [...s, id]));
    try {
      const res = await base44.functions.invoke('siteHealth', { projectId, action: 'fix', finding: id });
      const payload = res?.data;
      if (!payload || !payload.fix) {
        throw new Error('The server returned no result, so nothing can be shown as done.');
      }
      // The policy travels with the fix, so the panel above stays right without
      // a second round trip. Unsaved edits are never overwritten by it.
      if (payload.policy) { setPolicy(payload.policy); setPolicyErr(null); setDraft((d) => d || editableOf(payload.policy)); }
      setFixResults((r) => ({ ...r, [id]: { state: 'settled', ok: payload.ok === true, fix: payload.fix } }));
      return { id, rejected: false, ok: payload.ok === true, fix: payload.fix };
    } catch (e) {
      const message = e?.data?.error || e.message;
      setFixResults((r) => ({ ...r, [id]: { state: 'rejected', message, code: e?.data?.code || null } }));
      return { id, rejected: true, message, code: e?.data?.code || null };
    } finally {
      setFixingIds((s) => s.filter((x) => x !== id));
    }
  }, [projectId]);

  // Take the operator to the Updates section and mark it for a moment, because a
  // scroll with no sign of where you arrived is a dead end of its own.
  const jumpToUpdates = useCallback(() => {
    if (updatesRef.current?.scrollIntoView) updatesRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setUpdatesFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setUpdatesFlash(false), 1800);
  }, []);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  const { site, summary, freshness, host, auto_updates: auto, can_apply: apply, update_plan: plan } = scan || {};
  const attention = scan?.attention || [];
  // The collapsed list is the payload's own findings, filtered to the two non-problem statuses.
  const rest = (scan?.findings || []).filter((f) => f.status === 'good' || f.status === 'unknown');
  const notRun = scan?.async_not_run || [];

  // Counts are read straight off `summary` — never recounted from the lists.
  const countParts = [];
  if (summary?.critical) countParts.push(`${summary.critical} need attention`);
  if (summary?.recommended) countParts.push(`${summary.recommended} recommended`);
  if (summary?.good) countParts.push(`${summary.good} good`);
  if (summary?.unknown) countParts.push(`${summary.unknown} unknown`);

  const coreRows = plan?.core || [];
  const otherRows = [
    ...(plan?.plugins || []).map((p, i) => ({ key: `plugin-${p.file || i}`, kind: 'plugin', name: p.name, from: p.version, to: p.new_version })),
    ...(plan?.themes || []).map((t, i) => ({ key: `theme-${t.stylesheet || i}`, kind: 'theme', name: t.name, from: t.version, to: t.new_version })),
  ];
  const updateTotal = plan ? Math.max(0, plan.total || 0) : null;

  // Dirty covers only the fields this panel can change, never a server-computed value.
  const dirty = !!policy && !!draft && !sameEditable(draft, editableOf(policy));
  const nextRun = policy?.scan_enabled ? utcStamp(policy.next_run_at) : null;
  const canApply = policy?.can_apply_unattended || [];
  const reportOnly = policy?.report_only || [];

  // What a manual run would actually target: the intersection of what the saved
  // policy allows (`can_apply_unattended`) and what the scan found. The server
  // applies exactly that intersection, so counting anything else — the plan
  // total, for instance — would promise more than the run can do.
  const applyTargets = plan
    ? (canApply.includes('plugin') ? (plan.plugins?.length || 0) : 0)
      + (canApply.includes('theme') ? (plan.themes?.length || 0) : 0)
      + (canApply.includes('core_minor') ? (plan.core?.length || 0) : 0)
    : 0;
  // A button the site or the policy would refuse is a dead end, so the control
  // is offered only when there is work AND permission AND a writable site.
  const showApplyControl = updateTotal > 0 && !!policy && applyTargets > 0 && apply?.ok !== false;
  const siteName = site?.name || site?.url || 'this site';

  // Only the attention list carries FIX ALL, and only its `auto` findings: a
  // guided finding needs a person and an `updates` finding belongs to the
  // Updates section. Nothing else may ever be swept into the run.
  const autoFindings = attention.filter((t) => t.fix?.kind === 'auto');
  const anyFixInFlight = fixingIds.length > 0;

  // FIX ALL: every auto finding, one at a time, then ONE fresh scan at the end.
  // Sequential by construction — a for..of with an await — because two writers on
  // one live site is how a rollback gets tangled. Guided and updates findings are
  // never in `autoFindings`, so they can never be included.
  const runFixAll = async () => {
    if (fixAllRunning || anyFixInFlight || autoFindings.length === 0) return;
    setFixAllConfirming(false);
    setFixAllReport(null);
    setFixAllRunning(true);
    const total = autoFindings.length;
    const tally = { done: 0, unverified: 0, failed: 0, declined: 0, rejected: 0 };
    try {
      for (let i = 0; i < autoFindings.length; i += 1) {
        const f = autoFindings[i];
        setFixAllProgress({ index: i + 1, total, label: f.label || f.id });
        const r = await applyFix(f);
        if (r?.rejected) tally.rejected += 1;
        else if (r?.ok !== true) tally.declined += 1;
        else if (r?.fix?.verified === false) tally.unverified += 1;
        else if (r?.fix?.error) tally.failed += 1;
        else tally.done += 1;
      }
    } finally {
      setFixAllRunning(false);
      setFixAllProgress(null);
      setFixAllReport(fixAllWords(tally));
      // One scan at the very end, so what is on screen afterwards is the site as
      // it now is rather than this run's word for it.
      await run(true);
    }
  };

  const setField = (key, value) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setPolicySaved(null); setPolicyErr(null);
  };

  const savePolicyDraft = async () => {
    if (!draft || !dirty || saving) return;
    setSaving(true); setPolicyErr(null); setPolicySaved(null);
    try {
      const res = await base44.functions.invoke('siteHealth', { projectId, action: 'policy', policy: draft });
      if (!res?.data) throw new Error('the server returned no policy, so what was stored cannot be confirmed.');
      setPolicy(res.data); setDraft(editableOf(res.data));
      setPolicySaved('Saved. The description above is what is now stored for this site.');
    } catch (e) {
      setPolicyErr(`Not saved — ${e?.data?.error || e.message}`);
    } finally { setSaving(false); }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-primary/15 px-3 py-2.5 space-y-1.5 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-primary/80 uppercase tracking-wider">Site health</span>
          <button className={`${btn} ml-auto`} onClick={() => run(true)} disabled={loading}>
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {loading && scan ? 'RESCANNING' : 'RESCAN'}
          </button>
        </div>

        {site?.url && (
          <a href={site.url} target="_blank" rel="noreferrer"
            className="flex items-center gap-1 text-[10px] text-primary/50 hover:text-primary break-all">
            <ExternalLink size={10} className="shrink-0" /> {site.name || site.url}
          </a>
        )}

        {scan && (
          <>
            <div className="text-[12px] text-primary/85 break-words">{summary?.headline || 'The scan finished.'}</div>
            <div className="text-[10px] text-primary/50 break-words">
              {countParts.join(' · ')}{countParts.length ? ' · ' : ''}WP {scan.wp_version || '—'} · PHP {scan.php_version || '—'}
            </div>
            {freshness?.message && (
              // Stale freshness is a caution, not trivia: it means a "no updates"
              // answer is old enough that it cannot be trusted.
              <div className={`flex items-start gap-1 ${freshness.stale ? 'text-yellow-500/85' : 'text-primary/45'}`}>
                {freshness.stale
                  ? <AlertTriangle size={10} className="mt-[2px] shrink-0" />
                  : <Clock size={10} className="mt-[2px] shrink-0" />}
                <span className="text-[10px] break-words">{freshness.message}</span>
              </div>
            )}
            {scan.cached && (
              <div className="text-[10px] text-primary/45">From a recent scan — RESCAN for a fresh one.</div>
            )}
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-matrix p-3 space-y-4">
        {err && (
          <div className="border border-red-500/30 bg-red-500/5 px-3 py-2 space-y-1">
            <div className="text-[11px] text-red-300/90 break-words">{err}</div>
            <div className={faint}>
              {scan ? 'Showing the previous scan below.' : 'The site could not be scanned. Tap RESCAN to try again.'}
            </div>
          </div>
        )}
        {!scan && loading && (
          <div className="flex items-center gap-2 text-[11px] text-primary/50">
            <Loader2 size={12} className="animate-spin" /> Scanning the site…
          </div>
        )}

        {scan && (
          <>
            <Section title={`Needs attention · ${summary?.attention ?? attention.length}`}
              icon={<AlertTriangle size={11} className={attention.length ? 'text-red-400' : 'text-primary/35'} />}>
              {summary?.total === 0 ? (
                // "No tests" and "no problems" are different answers, and only one
                // of them means the site is fine.
                <div className="border border-yellow-500/30 px-3 py-2 text-[11px] text-primary/65 leading-relaxed">
                  The scan returned no tests at all. That is not the same as everything being fine — update the
                  Morpheus plugin from the SETUP tab, then rescan.
                </div>
              ) : attention.length === 0 ? (
                <div className="flex items-start gap-1.5 text-[11px] text-primary/60">
                  <Check size={12} className="mt-[2px] shrink-0 text-primary/50" />
                  Nothing in this scan needs attention.
                </div>
              ) : (
                <>
                  {autoFindings.length > 0 ? (
                    <div className="space-y-1.5">
                      {fixAllRunning && fixAllProgress ? (
                        <div className="flex items-start gap-1.5 text-[10px] text-primary/60">
                          <Loader2 size={12} className="mt-[1px] shrink-0 animate-spin" />
                          <span className="break-words">
                            Fixing {fixAllProgress.index} of {fixAllProgress.total} — {fixAllProgress.label}
                          </span>
                        </div>
                      ) : fixAllConfirming ? (
                        // Step two of two, naming exactly what will be fixed and
                        // showing each warned fix's warning BEFORE anything is sent.
                        <div className="border border-yellow-500/30 px-2.5 py-2 space-y-2">
                          <div className="text-[11px] text-primary/85 leading-relaxed">
                            Fix {autoFindings.length} {autoFindings.length === 1 ? 'finding' : 'findings'} on {siteName} now?
                            Morpheus sends them one at a time and re-checks the site when it has finished.
                          </div>
                          <div className="space-y-1">
                            {autoFindings.map((f) => (
                              <div key={`all-${f.id}`} className="text-[10px] text-primary/65 break-words">
                                <span className="text-primary/80">{f.label || f.id}</span>
                                {f.fix?.warning ? (
                                  <span className="block text-[9px] text-yellow-500/85 leading-relaxed">{f.fix.warning}</span>
                                ) : null}
                              </div>
                            ))}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <button className={`${btn} border-yellow-500/40`} onClick={runFixAll} disabled={anyFixInFlight}>
                              <Zap size={12} /> FIX {autoFindings.length}
                            </button>
                            <button className={btn} onClick={() => setFixAllConfirming(false)}>
                              <X size={12} /> CANCEL
                            </button>
                          </div>
                          <div className={faint}>
                            Nothing has been sent yet. Only the fixes listed here run — a guided finding and an update
                            finding are never included.
                          </div>
                        </div>
                      ) : (
                        <>
                          <button className={btn} onClick={() => setFixAllConfirming(true)} disabled={anyFixInFlight}>
                            <Zap size={12} /> FIX ALL · {autoFindings.length}
                          </button>
                          {anyFixInFlight ? (
                            <div className={faint}>A fix is still being sent — FIX ALL starts once it has finished.</div>
                          ) : null}
                        </>
                      )}
                      {fixAllRunning ? (
                        <div className={faint}>
                          One fix at a time, so the site is never written to twice at once — the fix buttons below are
                          paused until this run finishes.
                        </div>
                      ) : null}
                      {fixAllReport && !fixAllRunning ? (
                        <div className="border border-primary/15 px-2.5 py-2 text-[10px] text-primary/65 leading-relaxed break-words">
                          {fixAllReport}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {attention.map((t, i) => (
                    <Finding key={`${t.id}-${i}`} t={t} siteName={siteName}
                      fixBusy={fixingIds.includes(t.id)}
                      fixPaused={fixAllRunning}
                      fixResult={fixResults[t.id]}
                      onFix={applyFix}
                      onRescan={() => run(true)}
                      scanning={loading}
                      onJumpToUpdates={jumpToUpdates} />
                  ))}
                </>
              )}
            </Section>

            {rest.length > 0 && (
              <div className="space-y-2">
                <button className={btn} onClick={() => setShowAll((v) => !v)}>
                  Everything else · {rest.length} {showAll ? 'HIDE' : 'SHOW'}
                </button>
                {showAll && rest.map((t, i) => (
                  <Finding key={`${t.id}-${i}`} t={t} quiet siteName={siteName}
                    fixBusy={fixingIds.includes(t.id)}
                    fixPaused={fixAllRunning}
                    fixResult={fixResults[t.id]}
                    onFix={applyFix}
                    onRescan={() => run(true)}
                    scanning={loading}
                    onJumpToUpdates={jumpToUpdates} />
                ))}
              </div>
            )}

            {/* Where an `updates` finding sends the operator; the brief highlight is
                how they know they arrived. */}
            <div ref={updatesRef}
              className={`transition-colors duration-700 ${updatesFlash ? 'bg-primary/10 ring-1 ring-primary/40' : ''}`}>
            <Section title="Updates" icon={<Package size={11} className="text-primary/45" />}>
              <div className={`text-[11px] break-words ${updateTotal ? 'text-primary/80' : 'text-primary/60'}`}>
                {plan?.message || 'This scan did not report update information.'}
              </div>
              {updateTotal > 0 && (
                <div className="space-y-2">
                  {/* Core is shown on its own: WordPress updating itself is a different decision. */}
                  {plan?.hasCore && coreRows.length > 0 && (
                    <div className="space-y-1">
                      <div className={micro}>WordPress itself</div>
                      {coreRows.map((c, i) => (
                        <UpdateRow key={`core-${i}`} name="WordPress" from={c.current} to={c.version} strong />
                      ))}
                    </div>
                  )}
                  {otherRows.length > 0 && (
                    <div className="space-y-1">
                      <div className={micro}>Plugins and themes</div>
                      {otherRows.map((r) => <UpdateRow key={r.key} name={r.name} kind={r.kind} from={r.from} to={r.to} />)}
                    </div>
                  )}
                  {showApplyControl ? (
                    <>
                      {applying ? (
                        <div className="flex items-center gap-1.5 text-[10px] text-primary/55">
                          <Loader2 size={12} className="animate-spin shrink-0" />
                          {applying === 'check'
                            ? 'Checking what the site would do — nothing is being changed.'
                            : 'Applying updates now — the site is being changed. Leave this panel open.'}
                        </div>
                      ) : null}

                      {confirming ? (
                        // Step two of two. Nothing has been sent: APPLY is the only
                        // thing that calls the server, and the policy's own limits
                        // still apply to what it will actually touch.
                        <div className="border border-yellow-500/30 px-3 py-2.5 space-y-2">
                          <div className="text-[11px] text-primary/85 leading-relaxed">
                            Apply {applyTargets} update{applyTargets === 1 ? '' : 's'} to {siteName}? WordPress will restore anything that fails.
                          </div>
                          <div className="flex items-center gap-2">
                            <button className={`${btn} border-yellow-500/40`} onClick={() => runApply(false)} disabled={!!applying}>
                              {applying === 'apply' ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                              {applying === 'apply' ? 'APPLYING' : 'APPLY'}
                            </button>
                            <button className={btn} onClick={() => setConfirming(false)} disabled={!!applying}>
                              <X size={12} /> CANCEL
                            </button>
                          </div>
                          <div className="text-[9px] text-primary/45 leading-relaxed">
                            Nothing has been sent yet. Morpheus applies only the update kinds this site&apos;s policy allows, and snapshots each one before it starts.
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <button className={btn} onClick={() => runApply(true)} disabled={!!applying}>
                            {applying === 'check' ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />} CHECK FIRST
                          </button>
                          <button className={btn} onClick={() => setConfirming(true)} disabled={!!applying}>
                            <AlertTriangle size={12} /> APPLY NOW
                          </button>
                        </div>
                      )}

                      {runErr ? (
                        <div className="border border-red-500/30 bg-red-500/5 px-3 py-2 space-y-1">
                          <div className="text-[11px] text-red-300/90 break-words">{runErr.message}</div>
                          <div className="text-[9px] text-primary/45 leading-relaxed">
                            {runErr.dryRun
                              ? 'The check did not finish. A check changes nothing, so the site is exactly as it was.'
                              : 'Morpheus cannot say from here whether the site was changed. RESCAN above to see the site as it is now before trying again.'}
                          </div>
                        </div>
                      ) : null}
                      {outcome ? <ApplyReport outcome={outcome} /> : null}
                    </>
                  ) : updateTotal > 0 && !policy ? (
                    <div className={faint}>
                      This scan did not carry the site&apos;s policy, so Morpheus cannot say what it may apply. RESCAN to try again.
                    </div>
                  ) : updateTotal > 0 && apply?.ok === false ? (
                    // The site says it cannot write its own files, so an apply button
                    // could only fail. Say why, and point at the reason.
                    <div className="border border-red-500/30 bg-red-500/5 px-3 py-2 text-[10px] text-red-300/90 leading-relaxed">
                      WordPress says it cannot write to this site&apos;s own files, so Morpheus will not offer to apply these. The section below, Can Morpheus update this site?, says why.
                    </div>
                  ) : (
                    <div className="border border-primary/15 px-3 py-2 text-[10px] text-primary/60 leading-relaxed">
                      {canApply.length === 0
                        ? 'Applying updates is switched off for this site, so the updates above can only be reported. Switch on plugin, theme or minor WordPress updates in SCHEDULED CHECKS below and save the policy.'
                        : 'The updates above are all of a kind this site\u2019s policy only reports, so there is nothing here Morpheus may apply. Change that in SCHEDULED CHECKS below and save the policy.'}
                    </div>
                  )}
                  {/* Said once, here, at the point where applying is offered. */}
                  <div className="text-[9px] text-primary/40 leading-relaxed">
                    Every plugin and theme update is snapshotted before it is touched, and put back automatically if the new version does not install cleanly. A major WordPress update is never applied from here — it is listed in the findings above for you to run from wp-admin.
                  </div>
                </div>
              )}
            </Section>
            </div>

            <Section title="Can Morpheus update this site?" icon={<Server size={11} className="text-primary/45" />}>
              {apply?.ok === false ? (
                <div className="border border-red-500/30 bg-red-500/5 px-3 py-2 space-y-1">
                  <div className="text-[11px] text-red-300/90 leading-relaxed break-words">
                    {apply.message || 'Nothing can update this site from WordPress. This has to be fixed where the site is hosted, or in its file permissions.'}
                  </div>
                  {(apply.reasons || []).map(plain).filter(Boolean).map((r, i) => (
                    <div key={i} className="text-[10px] text-red-300/80 break-words">{r}</div>
                  ))}
                </div>
              ) : apply?.ok === true ? (
                <div className="flex items-center gap-1.5 text-[10px] text-primary/45">
                  <ShieldCheck size={11} className="shrink-0" /> Morpheus can write to this site&apos;s own files.
                </div>
              ) : (
                <div className={faint}>This scan did not say whether the site can update its own files.</div>
              )}
              <div className="border border-primary/15 px-3 py-1">
                <KV k="Filesystem access" v={host?.filesystem_method || '—'} />
                <KV k="HTTPS" v={host?.ssl === true ? 'Yes' : host?.ssl === false ? 'No' : '—'} />
                <KV k="PHP memory limit" v={host?.memory_limit || '—'} />
              </div>
            </Section>

            <Section title="Automatic updates">
              {!auto ? (
                <div className={faint}>This scan did not report the automatic-update settings.</div>
              ) : (
                <div className="border border-primary/15 px-3 py-1">
                  <KV k="Plugins" v={auto.plugins_global ? 'On' : 'Off'} />
                  <KV k="Themes" v={auto.themes_global ? 'On' : 'Off'} />
                  <KV k="Core — minor versions" v={coreSetting(auto.core_minor)} />
                  <KV k="Core — major versions" v={coreSetting(auto.core_major)} />
                  <KV k="The automatic updater" v={auto.automatic_updater_disabled ? 'Disabled entirely' : 'Enabled'} />
                  {auto.core_constant ? <KV k="WP_AUTO_UPDATE_CORE constant" v={String(auto.core_constant)} /> : null}
                </div>
              )}
            </Section>

            {notRun.length > 0 && (
              <div className="space-y-1 border-t border-primary/10 pt-2">
                <div className={micro}>Not checked · {notRun.length}</div>
                <div className={faint}>These tests did not run — that is not the same as passing.</div>
                {notRun.map((a, i) => (
                  <div key={`${a.id}-${i}`} className="text-[10px] text-primary/45 break-words">
                    <span className="text-primary/60">{a.label || a.id}</span>{a.reason ? ` — ${a.reason}` : ''}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Last on purpose: the scan above is read-only; this part changes what Morpheus will do. */}
        {policy && (
          <div className="border-t border-primary/10 pt-3">
            <Section title="SCHEDULED CHECKS" icon={<CalendarClock size={11} className="text-primary/45" />}>
              <Toggle label="Monthly check" on={!!draft?.scan_enabled} disabled={saving}
                hint="Morpheus looks at the site and reports what it finds. On its own this changes nothing."
                onChange={(v) => setField('scan_enabled', v)} />
              {!draft?.scan_enabled ? (
                // Off means off: no day, no hour and no apply switches — they would imply a run that is not scheduled.
                <div className="border border-primary/15 px-2.5 py-2 text-[10px] text-primary/60 leading-relaxed">
                  Monthly checks are off, so Morpheus will only look at this site when you ask it to — with RESCAN above. Nothing runs on a schedule and nothing is changed.
                </div>
              ) : (
                <>
                  <div className="border border-primary/15 px-2.5 py-2 space-y-1.5">
                    <div className={micro}>When it runs · UTC</div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className={`${faint} block`}>Day of the month (1–28)</span>
                        <select className={sel} value={draft?.day_of_month ?? 1} disabled={saving} onChange={(e) => setField('day_of_month', Number(e.target.value))}>
                          {DAYS_OF_MONTH.map((d) => <option key={d} value={d} className="bg-black">{ORD(d)}</option>)}
                        </select>
                      </label>
                      <label className="block">
                        <span className={`${faint} block`}>Hour (UTC)</span>
                        <select className={sel} value={draft?.hour_utc ?? 0} disabled={saving} onChange={(e) => setField('hour_utc', Number(e.target.value))}>
                          {HOURS_UTC.map((h) => <option key={h} value={h} className="bg-black">{pad2(h)}:00 UTC</option>)}
                        </select>
                      </label>
                    </div>
                  </div>
                  <div className="border border-primary/15 px-2.5 py-2">
                    <div className={micro}>Next check{dirty ? ' · from the saved policy' : ''}</div>
                    {nextRun ? <div className="text-[11px] text-primary/85 break-words">{nextRun}</div>
                      : policy.scan_enabled
                        ? <div className="text-[10px] text-primary/50">Not known — the server did not report a next run time for this policy.</div>
                        : <div className="text-[10px] text-primary/55">None yet — the saved policy has the schedule off. Save and the server works out the next run.</div>}
                  </div>
                  {/* Yellow and away from the scan switch: these three change the live site; the scan does not. */}
                  <div className="border border-yellow-500/30 px-2.5 py-2.5 space-y-2">
                    <div className={`${micro} text-yellow-500/85`}>A scheduled check could also change the site</div>
                    <div className="text-[9px] text-primary/45 leading-relaxed">Each switch below changes the live site with nobody watching. Off means it is only reported.</div>
                    <Toggle label="Plugin updates" disabled={saving} on={!!draft?.apply_plugins} onChange={(v) => setField('apply_plugins', v)}
                      hint="Morpheus would install plugin updates on its own, with nobody watching." />
                    <Toggle label="Theme updates" disabled={saving} on={!!draft?.apply_themes} onChange={(v) => setField('apply_themes', v)}
                      hint="Morpheus would install theme updates on its own, with nobody watching." />
                    <Toggle label="Minor WordPress updates" disabled={saving} on={!!draft?.apply_core_minor} onChange={(v) => setField('apply_core_minor', v)}
                      hint="Morpheus would install minor and security WordPress updates on its own, with nobody watching." />
                    {/* A rule, not a setting: there is no switch for it, and a major core update is never applied unattended. */}
                    <div className="flex items-start gap-1.5 border-t border-yellow-500/20 pt-2">
                      <ShieldCheck size={11} className="mt-[1px] shrink-0 text-yellow-500/85" />
                      <span className="text-[9px] text-yellow-500/85 leading-relaxed">Major WordPress updates are reported, never applied.</span>
                    </div>
                  </div>
                </>
              )}
              <div className="border border-primary/15 px-2.5 py-2 text-[10px] text-primary/65 leading-relaxed">
                {canApply.length === 0
                  ? 'Scheduled checks are report-only on this site — Morpheus looks and tells you what it finds, and nothing is changed.'
                  : `With nobody watching, Morpheus may apply ${wordList(canApply)} updates${reportOnly.length ? `, and reports ${wordList(reportOnly)} updates without applying them` : ''}.`}
              </div>
              <div className="border border-primary/15 px-2.5 py-2">
                <div className={micro}>What this policy says{dirty ? ' · from the saved policy' : ''}</div>
                <div className="text-[10px] text-primary/65 leading-relaxed break-words">{policy.description || 'The server sent no description for this policy.'}</div>
              </div>
              {policy.exists === false ? <div className={faint}>No policy saved for this site yet — these are the safe defaults.</div> : null}
              <div className="space-y-1.5">
                <button className={`${btn} w-full`} onClick={savePolicyDraft} disabled={!dirty || saving}>
                  {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} SAVE POLICY
                </button>
                {dirty && !saving ? <div className={faint}>Unsaved changes — the next run and description above still describe the saved policy.</div> : null}
                {policyErr ? <div className="border border-red-500/30 bg-red-500/5 px-2.5 py-2 text-[10px] text-red-300/90 break-words">{policyErr}</div> : null}
                {policySaved ? <div className="flex items-start gap-1.5 text-[10px] text-primary/70"><Check size={11} className="mt-[1px] shrink-0" /> {policySaved}</div> : null}
              </div>
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}
