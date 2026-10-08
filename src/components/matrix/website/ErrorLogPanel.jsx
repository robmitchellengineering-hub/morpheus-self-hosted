import { useState } from 'react';
import { Loader2, Check, FileWarning, RefreshCw, Copy } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { errorLogAsText } from '@/lib/errorLogText';

// ERROR LOG — the site's PHP error log, READ rather than merely measured.
//
// WHY THIS EXISTS. CLEAN MY SITE has always opened `wp-content/debug.log`, but only
// to decide whether the web server is SERVING it — it compares the file's bytes with
// the URL's. So the plugin could tell an owner "your log is a leak" and never "your
// site is throwing this every time someone opens the shop". This is the read half.
//
// IT RUNS ONLY WHEN ASKED, and that is asserted rather than hoped (see
// scripts/verify-site-health.mjs): a log tail is the one thing on this tab that can
// be megabytes, so nothing is fetched when the panel opens — the same rule CLEAN MY
// SITE follows, and the reason the plugin bounds the read and reports every bound
// that bit (`truncated`, `lines_seen`, `groups_total`).
//
// IT NEVER CLAIMS "no errors" FROM SOMETHING IT DID NOT READ. A missing file, an
// unreadable one, an empty one and a healthy one are four different answers, and the
// plugin names which — the panel renders that reason in the site's own words instead
// of showing an empty list, because an empty list reads as "all clear".

const LEVEL_TONE = {
  fatal: 'text-red-400 border-red-500/40',
  warning: 'text-yellow-500/90 border-yellow-500/40',
  notice: 'text-ink-max border-primary/30',
  deprecated: 'text-ink-max border-primary/30',
  other: 'text-ink-max border-primary/25',
};

const LEVEL_ORDER = ['fatal', 'warning', 'notice', 'deprecated', 'other'];

// The plugin's own reasons, turned into one sentence each. It sends the reason so
// the panel never has to invent one — this only expands it.
const NOT_READ = {
  missing: 'There is no wp-content/debug.log on this site. WordPress only writes one while WP_DEBUG_LOG is switched on, so there is nothing to read yet — not "nothing wrong".',
  unreadable: 'wp-content/debug.log exists but the site could not open it. That is a file-permission problem on the server, and Morpheus will not guess at the contents.',
  empty: 'wp-content/debug.log exists and is empty — no errors have been written to it.',
};

const btn = 'inline-flex items-center justify-center gap-1.5 px-3 h-[32px] border border-primary/30 text-[10px] uppercase tracking-wider text-primary/80 hover:text-primary hover:border-primary disabled:opacity-40 shrink-0';

function Counts({ counts }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] uppercase tracking-wider">
      {LEVEL_ORDER.filter((l) => counts[l] > 0).map((l) => (
        <span key={l} className={`border px-1.5 py-0.5 ${LEVEL_TONE[l]}`}>{counts[l]} {l}</span>
      ))}
      {LEVEL_ORDER.every((l) => !counts[l]) && (
        <span className="text-ink-max normal-case tracking-normal">No errors in the lines that were read.</span>
      )}
    </div>
  );
}

function Group({ g, openKey, setOpenKey, path }) {
  const open = openKey === `${g.level}|${g.file}|${g.message}`;
  return (
    <div className="border border-primary/15 px-2.5 py-2 space-y-1">
      <button className="w-full text-left space-y-1" onClick={() => setOpenKey(open ? null : `${g.level}|${g.file}|${g.message}`)}>
        <div className="flex items-start gap-2">
          <span className={`shrink-0 border px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${LEVEL_TONE[g.level] || LEVEL_TONE.other}`}>{g.level}</span>
          {/* select-text: index.css turns selection OFF on every button (the Android
              highlight menu on controls), and this row IS a button — so the evidence sat
              inside a control and could not be copied. Re-enabled on the text itself, which
              is where selection belongs; the row still toggles anywhere. */}
          <span className="select-text min-w-0 flex-1 text-[11px] text-ink-max break-words">{g.message}</span>
          <span className="shrink-0 text-[10px] text-ink-max">×{g.count}</span>
        </div>
        {(g.file || g.last_at) && (
          <div className="select-text text-[10px] text-ink-max break-all">
            {g.file ? <span className="font-mono">{g.file}{g.line ? `:${g.line}` : ''}</span> : null}
            {g.file && g.last_at ? ' · ' : null}
            {g.last_at ? `last ${g.last_at}` : null}
          </div>
        )}
      </button>
      {open && (
        <div className="space-y-1 pt-1 border-t border-primary/10">
          {(g.samples || []).map((s, i) => (
            <div key={i} className="select-text text-[10px] text-ink-max font-mono break-all whitespace-pre-wrap">{s}</div>
          ))}
          {g.count > (g.samples || []).length && (
            // The path, not the old hard-coded default: since the log can be MOVED out of
            // the web root, telling an operator it is in wp-content/debug.log would send
            // them looking in a file that no longer exists.
            <div className="text-[9px] text-ink-max">{g.count - (g.samples || []).length} more like this in {g.file ? 'the same file' : (path || 'the log')} — Morpheus reads a bounded tail, it does not hold the whole file.</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ErrorLogPanel({ projectId }) {
  const [log, setLog] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [openKey, setOpenKey] = useState(null);
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(null);

  // The press is the only thing that calls the server — no useEffect, deliberately.
  const run = async () => {
    setLoading(true); setErr(null); setOpenKey(null); setShowRaw(false); setCopied(null);
    try {
      const { data } = await base44.functions.invoke('siteHealth', { projectId, action: 'logs' });
      setLog(data);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setLoading(false); }
  };

  // COPY ALL — the readout as text, because a screen that shows evidence has to let you
  // take it away. Selection works too (see the markup), but on a phone dragging across
  // forty groups is not a thing anyone can do, and the operator's real next move is to
  // paste this into a ticket, a host's support form, or another session.
  //
  // Two paths on purpose: the async clipboard API needs a SECURE CONTEXT, and the dock is
  // embedded in other people's pages — some of them http. The fallback is the deprecated
  // execCommand, which is the only thing that works there.
  const copyAll = async () => {
    const text = errorLogAsText(log);
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch { /* permission denied or insecure context — try the fallback */ }
    if (!ok) {
      try {
        const el = document.createElement('textarea');
        el.value = text;
        el.setAttribute('readonly', '');
        el.style.position = 'fixed';
        el.style.top = '-1000px';
        document.body.appendChild(el);
        el.select();
        ok = document.execCommand('copy');
        document.body.removeChild(el);
      } catch { ok = false; }
    }
    setCopied(ok ? 'ok' : 'failed');
    setTimeout(() => setCopied(null), 2500);
  };

  return (
    <div className="space-y-2">
      <div className="text-[10px] text-ink-max leading-relaxed">
        What the site has actually been writing to its PHP error log — grouped so the same fault repeated two
        hundred times is one line, not two hundred. Reading it changes nothing on the site, and Morpheus never
        clears or rotates it.
      </div>

      {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-3 py-2 break-words">{err}</div>}

      {!log && !loading ? (
        <button className={`${btn} w-full`} onClick={run}>
          <FileWarning size={12} /> READ ERROR LOG
        </button>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 text-[11px] text-ink-max">
          <Loader2 size={12} className="animate-spin" /> Reading the log on the site…
        </div>
      ) : null}

      {log && !loading ? (
        <div className="space-y-2">
          {log.not_read ? (
            <div className="border border-primary/20 px-3 py-2 text-[11px] text-ink-max leading-relaxed">
              {NOT_READ[log.not_read] || 'The log could not be read.'}
            </div>
          ) : (
            <>
              <Counts counts={log.counts || {}} />

              {log.truncated ? (
                <div className="text-[10px] text-ink-max leading-relaxed">
                  Showing the newest {log.lines_read} line{log.lines_read === 1 ? '' : 's'} of a file that is
                  {' '}{Math.round((log.bytes || 0) / 1024)} KB. {log.lines_in_tail} lines were in the part Morpheus
                  {' '}read, so there is more on the server than this — nothing has been removed.
                </div>
              ) : (
                <div className="text-[10px] text-ink-max">{log.lines_read} line{log.lines_read === 1 ? '' : 's'} read{log.bytes ? ` (${Math.round(log.bytes / 1024)} KB)` : ''}{log.modified ? ` · last written ${log.modified}` : ''}.</div>
              )}

              {log.configured ? (
                <div className="text-[10px] text-yellow-500/85 leading-relaxed">
                  WordPress writes its log to <span className="font-mono">{log.path}</span> rather than its default
                  {' '}<span className="font-mono">wp-content/debug.log</span> — which is what you want if it is
                  outside the site, and is what this panel reads either way.
                </div>
              ) : null}

              {(log.groups || []).length ? (
                <div className="space-y-1.5">
                  {log.groups.map((g) => (
                    <Group key={`${g.level}|${g.file}|${g.message}`} g={g} openKey={openKey} setOpenKey={setOpenKey} path={log.path} />
                  ))}
                  {log.groups_total > log.groups.length ? (
                    <div className="text-[10px] text-ink-max">
                      Showing the {log.groups.length} most frequent of {log.groups_total} distinct problems in these lines.
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-[11px] text-ink-max">
                  <Check size={12} className="text-primary" /> Nothing in the lines that were read looks like a PHP error.
                </div>
              )}

              {(log.entries || []).length ? (
                <div>
                  <button className="text-[10px] uppercase tracking-wider text-primary/60 hover:text-primary" onClick={() => setShowRaw((v) => !v)}>
                    {showRaw ? 'HIDE' : 'SHOW'} THE NEWEST LINES ({log.entries.length})
                  </button>
                  {showRaw && (
                    <div className="mt-1 max-h-56 overflow-y-auto scrollbar-matrix border border-primary/15 p-2 space-y-0.5">
                      {log.entries.map((l, i) => (
                        <div key={i} className="select-text text-[10px] text-ink-max font-mono break-all whitespace-pre-wrap">{l}</div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </>
          )}

          <div className="flex items-center gap-2">
            <button className={btn} onClick={run} disabled={loading}>
              <RefreshCw size={12} /> READ AGAIN
            </button>
            {!log.not_read ? (
              <button className={btn} onClick={copyAll} disabled={loading}>
                {copied === 'ok'
                  ? <><Check size={12} /> COPIED</>
                  : copied === 'failed'
                    ? <><Copy size={12} /> SELECT THE TEXT</>
                    : <><Copy size={12} /> COPY ALL</>}
              </button>
            ) : null}
          </div>
          {copied === 'failed' ? (
            <div className="text-[10px] text-yellow-500/85 leading-relaxed">
              This browser would not let Morpheus reach the clipboard. The text is selectable — drag over it
              and copy, or open the same page outside the embed.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
