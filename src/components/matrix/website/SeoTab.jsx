import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Loader2, RefreshCw, Check, ExternalLink, ChevronLeft, Wand2, Search, AlertTriangle,
  FileText, Plus, Save, X, Sparkles, Eye, Settings2, Link2,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import SearchConsolePanel from './SearchConsolePanel';
import { useTaskRunner, useTaskResult } from '../TaskRunner';
import { serpPreview } from '@/lib/serpPreview';
import { TEMPLATE_TOKENS, TOKEN_HELP, resolveTemplate, insertToken } from '@/lib/seoTemplate';
import { sliceForRequests, mergeBatchResults, estimateRemainingMs, SEO_BATCH_MAX } from '@/lib/seoBatch';

// SEO tab of the WEBSITE panel — every SEO field on every page, post and
// product on the operator's own site, operable from here, plus AI generation
// for the ones that have nothing set.
//
// Two facts drive the whole design, and both are reported by the plugin rather
// than assumed here:
//
//   * WHO OWNS THE HEAD. With no third-party SEO plugin, Morpheus emits the
//     title/description/canonical/OG/schema tags itself. With Yoast, Rank Math,
//     AIOSEO or SEOPress active, Morpheus drives THAT plugin's own fields so
//     two plugins never emit competing tags. The same controls work either way;
//     the banner says which is happening, because "who is producing this tag"
//     is the first thing the operator needs to know when a title doesn't change.
//   * GENERATION PROPOSES, THE OPERATOR DISPOSES. Generated titles and
//     descriptions go straight into search results, so a batch is reviewed
//     field-by-field before anything is written. Nothing is published by AI
//     without a tap.

const inputCls = 'w-full bg-black/30 border border-primary/20 px-2.5 h-[38px] text-[12px] text-primary focus:outline-none focus:border-primary/50';
const areaCls = 'w-full bg-black/30 border border-primary/20 px-2.5 py-2 text-[12px] text-primary focus:outline-none focus:border-primary/50';
const DEFAULT_LIMITS = { title_min: 15, title_max: 60, desc_min: 70, desc_max: 160 };

const call = (projectId, action, data) =>
  base44.functions.invoke('wordPressSeoAction', { projectId, action, data }).then((r) => r.data);

// Per-action measured durations, so a single-call action's ETA comes from what it
// actually took last time rather than a hardcoded guess. The batch doesn't need
// this — it measures its own slices as it goes.
const RUN_MS_KEY = 'morpheus_seo_run_ms';
function readLastMs(key) {
  try {
    const v = Number((JSON.parse(localStorage.getItem(RUN_MS_KEY) || '{}'))[key]);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}
function writeLastMs(key, ms) {
  try {
    const all = JSON.parse(localStorage.getItem(RUN_MS_KEY) || '{}');
    all[key] = ms;
    localStorage.setItem(RUN_MS_KEY, JSON.stringify(all));
  } catch { /* storage is a convenience */ }
}

function Btn({ onClick, disabled, children, kind = 'ghost', title }) {
  const cls = kind === 'primary'
    ? 'bg-primary text-black font-bold hover:bg-[#39ff14]'
    : kind === 'danger'
      ? 'border border-red-500/30 text-red-400/80 hover:border-red-500/60 hover:text-red-400'
      : 'border border-primary/30 text-primary/75 hover:border-primary hover:text-primary';
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`h-[38px] px-3 text-[11px] disabled:opacity-40 flex items-center justify-center gap-1.5 shrink-0 ${cls}`}>
      {children}
    </button>
  );
}

function Counter({ value, min, max }) {
  const n = (value || '').length;
  const state = n === 0 ? 'text-primary/30' : n > max ? 'text-red-400' : n < min ? 'text-yellow-500/80' : 'text-primary/60';
  return <span className={`text-[9px] ${state}`}>{n}/{max}</span>;
}

function Field({ label, hint, right, children }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-1 gap-2">
        <span className="text-[10px] text-primary/45 uppercase tracking-wider">{label}</span>
        {right}
      </div>
      {children}
      {hint && <div className="text-[9px] text-ink-max mt-0.5">{hint}</div>}
    </label>
  );
}

/** One proposal, as generated. Warnings are shown, never silently fixed. */
function SuggestionRow({ s, checked, onToggle }) {
  return (
    <div className={`border px-3 py-2.5 ${checked ? 'border-primary/40 bg-primary/5' : 'border-primary/15 opacity-60'}`}>
      <div className="flex items-start gap-2">
        <button onClick={onToggle} className="mt-0.5 shrink-0"
          title={checked ? 'Skip this one' : 'Include this one'}>
          <span className={`w-[15px] h-[15px] border flex items-center justify-center ${checked ? 'border-primary bg-primary/20 text-primary' : 'border-primary/30 text-transparent'}`}>
            <Check size={11} />
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-ink-max truncate">{s.title || `#${s.id}`}</span>
            {s.type && <span className="text-[9px] text-primary/35 uppercase shrink-0">{s.type}</span>}
            {!s.grounded && <span className="text-[9px] text-yellow-500/70 shrink-0" title="Only the title was read — the model did not see the page text.">title-only</span>}
          </div>
          <div className="text-[11px] text-ink-max mt-1 break-words">{s.seo_title}</div>
          <div className="text-[10px] text-ink-max mt-0.5 break-words">{s.seo_description}</div>
          {s.focus_keyword && <div className="text-[9px] text-ink-max mt-0.5">keyword: {s.focus_keyword}</div>}
          {s.warnings?.length > 0 && (
            <div className="mt-1 text-[9px] text-yellow-500/80 flex items-start gap-1">
              <AlertTriangle size={9} className="mt-[2px] shrink-0" />
              <span>{s.warnings.join(' · ')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// `widget` is true when this renders inside an embed (src/pages/Embed.jsx) with a
// widget token rather than the owner's session. It matters because some actions
// are owner-only by design — connecting a Google account is `blockWidget` on the
// server — and the UI must say so instead of offering a button that 403s.
export default function SeoTab({ projectId, store, widget = false }) {
  const [view, setView] = useState('list'); // list | item | blog
  const [ctx, setCtx] = useState(null);
  const [items, setItems] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);

  const [audit, setAudit] = useState(null); // { issues, counts, scanned }

  const [edit, setEdit] = useState(null); // the item being edited + form
  const [saving, setSaving] = useState(false);
  const [links, setLinks] = useState(null); // { links, dropped, title }
  const [kw, setKw] = useState(null);          // { keywords, competitors, disclosure }
  const [competitors, setCompetitors] = useState('');
  const [linkPlan, setLinkPlan] = useState(null); // dry-run result awaiting APPLY

  const [batch, setBatch] = useState(null); // { suggestions, ... } pending review
  // NO loop in this tab owns its own run or its own result any more. Every one of
  // them lives in the task runner, above the tab switch — the WORK so leaving the
  // tab cannot stop it, and the RESULT so coming back shows the answer instead of
  // a blank. What is left here is presentation.
  const RUN_KEY = 'seo:batch';
  const { tasks, startTask } = useTaskRunner();
  const batchRun = tasks[RUN_KEY];
  const genBatch = batchRun?.status === 'running';

  // Every migrated single-call loop goes through here: it hands the runner a
  // worker, keeps this action's own last duration fresh so the strip's estimate is
  // a measurement rather than a guess (what the old local timer did), and gives
  // every task one shape.
  const task = (key, label, worker) => startTask(
    { key, label, total: 1, estimateMs: readLastMs(key) },
    async (api) => {
      const t0 = Date.now();
      try { return await worker(api); } finally { writeLastMs(key, Date.now() - t0); }
    },
  );

  // Which loops are in flight is the RUNNER's answer, not a second copy of it.
  const running = {
    audit: tasks['seo:audit']?.status === 'running',
    links: tasks['seo:links']?.status === 'running',
    linkWrite: ['seo:linkplan', 'seo:linkapply'].some((k) => tasks[k]?.status === 'running'),
    keywords: tasks['seo:keywords']?.status === 'running',
    one: tasks['seo:one']?.status === 'running',
    blog: tasks['seo:blog']?.status === 'running',
  };

  // The batch's RESULT lives in the runner, so this tab can be unmounted and
  // rebuilt and still show what happened — the review list AND the wording of the
  // note. The ref applies each result once, so a re-render does not overwrite a
  // selection the operator has since changed.
  useTaskResult(RUN_KEY, (r) => {
    if (r.suggestions?.length) {
      setBatch({ ...r, checked: Object.fromEntries(r.suggestions.map((s) => [s.id, true])) });
    }
    if (r.note) setNote(r.note);
  });
  const [applying, setApplying] = useState(false);

  const [defaults, setDefaults] = useState(null); // { enabled, title, description, post_types }
  const [lastField, setLastField] = useState('title'); // which template field a token chip targets
  const titleRef = useRef(null);
  const descRef = useRef(null);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [fillPlan, setFillPlan] = useState(null); // dry-run result awaiting APPLY
  const [filling, setFilling] = useState(false);

  const [blog, setBlog] = useState(null); // { form fields } | { draft }
  const [posting, setPosting] = useState(false);

  const limits = ctx?.limits || DEFAULT_LIMITS;
  const issuesById = useMemo(() => {
    const m = {};
    for (const i of audit?.issues || []) m[i.id] = [...(m[i.id] || []), i];
    return m;
  }, [audit]);

  const load = useCallback(async (opts = {}) => {
    setLoading(true); setErr(null);
    try {
      const [c, list] = await Promise.all([
        call(projectId, 'context', {}),
        call(projectId, 'list_content', { limit: 60, search: (opts.search ?? search).trim() || undefined }),
      ]);
      if (c?.ok === false || list?.ok === false) throw new Error(c?.message || list?.message || 'The site rejected the request.');
      setCtx(c); setItems(list?.items || []);
      if (c?.defaults) setDefaults(c.defaults);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setLoading(false); }
  }, [projectId, search]);

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectId]);

  // Competitor addresses are per project and remembered — they are the same
  // three shops every time, and retyping them is the kind of friction that
  // stops a feature being used.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`morpheus_seo_competitors_${projectId}`);
      if (saved) setCompetitors(saved);
    } catch { /* storage is a convenience */ }
  }, [projectId]);

  const rememberCompetitors = (value) => {
    setCompetitors(value);
    try { localStorage.setItem(`morpheus_seo_competitors_${projectId}`, value); } catch { /* ignore */ }
  };

  const runAudit = async () => {
    setErr(null); setNote(null);
    await task('seo:audit', 'Site audit', async ({ cancelled }) => {
      if (cancelled()) return null;
      const a = await call(projectId, 'audit', { limit: 100 });
      if (a?.ok === false) throw new Error(a.message || 'The site rejected the audit.');
      return a;
    });
  };
  useTaskResult('seo:audit', (a) => {
    setAudit(a);
    setNote(a.issues?.length
      ? `${a.issues.length} issue${a.issues.length === 1 ? '' : 's'} across ${a.scanned} item${a.scanned === 1 ? '' : 's'}.`
      : `Nothing to fix across ${a.scanned} item${a.scanned === 1 ? '' : 's'}.`);
  });

  const openItem = (it) => {
    setErr(null); setNote(null); setBatch(null); setLinks(null); setLinkPlan(null); setKw(null);
    setEdit({
      id: it.id, title: it.title, type: it.type, url: it.url, status: it.status,
      form: {
        seo_title: it.seo_title || '',
        seo_description: it.seo_description || '',
        focus_keyword: it.focus_keyword || '',
        canonical: '',
        og_image: '',
        noindex: !!it.noindex,
      },
      suggestion: null,
    });
    setView('item');
    // The list row only carries the list fields; the full record (canonical,
    // og:image) comes from get_seo so nothing is shown as empty when it isn't.
    call(projectId, 'get_seo', { id: it.id }).then((r) => {
      const f = r?.item;
      if (!f) return;
      setEdit((cur) => cur && cur.id === it.id ? {
        ...cur,
        form: {
          seo_title: f.seo_title || '',
          seo_description: f.seo_description || '',
          focus_keyword: f.focus_keyword || '',
          canonical: f.canonical || '',
          og_image: f.og_image || '',
          noindex: !!f.noindex,
        },
        effective_title: f.effective_title,
        effective_description: f.effective_description,
        edit_url: f.edit_url || null,
      } : cur);
    }).catch(() => { /* the form still works with what the list gave us */ });
  };

  const suggestLinks = async () => {
    setErr(null); setNote(null); setLinkPlan(null);
    const itemId = edit.id;
    await task('seo:links', 'Internal links', async ({ cancelled }) => {
      if (cancelled()) return null;
      const r = await base44.functions.invoke('suggestInternalLinks', { projectId, id: itemId }).then((x) => x.data);
      if (!r) throw new Error('No suggestion came back — try again.');
      // The ITEM is carried out with the result: this loop belongs to the page that
      // was open, and the tab may be rebuilt with a different one open by the time
      // it lands. Storing the id is what lets the result find its way home — or be
      // ignored honestly rather than applied to the wrong page.
      return { ...r, itemId };
    });
  };
  useTaskResult('seo:links', (r) => {
    if (r.itemId !== edit?.id) return; // the operator has moved to another page
    setLinks({ ...r, checked: Object.fromEntries((r.links || []).map((l, i) => [i, true])) });
    if (r.note) setNote(r.note);
    else if (!r.links?.length) setNote('Nothing worth linking from that page yet.');
  });

  // Dry run first: the plugin shows the exact sentence each link would land in,
  // and refuses anything whose phrase is not really in the text.
  const planLinks = async () => {
    const chosen = (links?.links || []).map((l, i) => ({ l, i })).filter(({ i }) => links.checked[i]).map(({ l }) => l);
    if (!chosen.length) return;
    setErr(null); setNote(null); setLinkPlan(null);
    const itemId = edit.id;
    const payload = chosen.map((l) => ({ id: itemId, anchor: l.anchor, url: l.url }));
    await task('seo:linkplan', 'Checking link placement', async ({ cancelled }) => {
      if (cancelled()) return null;
      const r = await call(projectId, 'bulk_add_links', { dry_run: true, items: payload });
      if (r?.ok === false) throw new Error(r.message || 'The site rejected the request.');
      return { ...r, itemId };
    });
  };
  useTaskResult('seo:linkplan', (r) => {
    if (r.itemId !== edit?.id) return;
    setLinkPlan(r);
  });

  const applyLinks = async () => {
    const chosen = (linkPlan?.added || []).map((a) => ({ id: a.id, anchor: a.anchor, url: a.url }));
    if (!chosen.length) return;
    setErr(null); setNote(null);
    const payload = chosen;
    await task('seo:linkapply', 'Adding links', async ({ cancelled }) => {
      if (cancelled()) return null;
      const r = await call(projectId, 'bulk_add_links', { items: payload });
      if (r?.ok === false) throw new Error(r.message || 'The site rejected the change.');
      return { count: r?.count ?? payload.length };
    });
  };
  useTaskResult('seo:linkapply', (r) => {
    setNote(`Added ${r.count} link${r.count === 1 ? '' : 's'} to this page. WordPress kept a revision, so you can undo it.`);
    setLinkPlan(null); setLinks(null);
  });

  const runKeywords = async () => {
    setErr(null); setNote(null); setKw(null);
    // Eight, matching MAX_COMPETITORS in server/src/lib/keywordResearch.js —
    // scripts/verify-keywords.mjs compares the two, because a UI that caps
    // lower than the server is a limit nobody can see or explain.
    const list = competitors.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
    const itemId = edit.id;
    await task('seo:keywords', 'Keyword research', async ({ cancelled }) => {
      if (cancelled()) return null;
      const r = await base44.functions.invoke('researchKeywords', {
        projectId, id: itemId, competitors: list,
      }).then((x) => x.data);
      return { ...r, itemId };
    });
  };
  useTaskResult('seo:keywords', (r) => {
    if (r.itemId !== edit?.id) return;
    setKw(r);
    if (!r?.keywords?.length) setNote('No keyword signals came back — try again, or add a competitor address.');
  });

  const save = async () => {
    setSaving(true); setErr(null); setNote(null);
    try {
      const r = await call(projectId, 'set_seo', { id: edit.id, ...edit.form });
      if (r?.ok === false) throw new Error(r.message || 'The site rejected the change.');
      setNote('Saved.');
      setItems(null);
      setAudit(null); // the audit is now stale — a stale issue list is worse than none
      const list = await call(projectId, 'list_content', { limit: 60 });
      setItems(list?.items || []);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setSaving(false); }
  };

  const generateOne = async () => {
    setErr(null); setNote(null);
    const itemId = edit.id;
    await task('seo:one', 'Writing metadata', async ({ cancelled }) => {
      if (cancelled()) return null;
      const r = await base44.functions.invoke('generateSeoMeta', { projectId, items: [{ id: itemId }] }).then((x) => x.data);
      const s = r?.suggestions?.[0];
      if (!s) throw new Error('No suggestion came back — try again.');
      // The suggestion belongs to ONE page. Carried with its id so a rebuild can
      // put it back on that page — and leave it alone if a different one is open.
      return { itemId, suggestion: s, titleOnly: !!r.title_only };
    });
  };
  useTaskResult('seo:one', ({ itemId, suggestion, titleOnly }) => {
    if (itemId !== edit?.id) return;
    setEdit((cur) => (cur ? { ...cur, suggestion } : cur));
    if (titleOnly) setNote('Only the title was available to read — check the suggestion against the page before saving.');
  });

  // The batch targets content a human would target: published, and missing
  // either half of its metadata. Rewriting a title someone deliberately wrote
  // is not "fixing" anything.
  const missing = useMemo(
    () => (items || []).filter((it) => it.status === 'publish' && (!it.seo_title || !it.seo_description)),
    [items],
  );

  // Start the batch in the runner. The loop below runs in the RUNNER's scope, not
  // this component's: unmounting the tab runs React's cleanup here, not on the
  // work. Everything the tab needs afterwards — including the wording of the note
  // — is returned as the task's result, so this tab can be destroyed and rebuilt
  // and still show what happened.
  const generateBatch = async () => {
    if (missing.length === 0) { setNote('Every published item already has a title and a description.'); return; }
    setErr(null); setNote(null);
    // Bounded per click: what this generates has to be applyable in one
    // bulk_set_seo (see SEO_BATCH_MAX). The remainder stays counted as missing.
    const work = missing.slice(0, SEO_BATCH_MAX);
    // One request per slice of items, and each request STREAMS its progress.
    //
    // Slicing stays: a request that is one model call is what keeps it inside the
    // platform's request envelope, and it is what makes a partial batch worth
    // keeping. A slice no longer answers in total silence — the server emits a
    // start event with its own measured ETA and an event per completed model call,
    // so bytes are always flowing. An idle connection was what got cut, and a cut
    // before Express answered arrived with no CORS headers, which is why the
    // browser could only say "Failed to fetch".
    const slices = sliceForRequests(work);
    const startedAt = Date.now();

    await startTask(
      { key: RUN_KEY, label: 'SEO metadata', total: slices.length, estimateMs: null },
      async ({ progress, cancelled }) => {
        const results = [];
        let failure = null;
        // Slices that answered nothing, and how many have failed in a row. Both
        // live outside the loop on purpose: "two in a row" is the whole rule, so
        // the counter cannot be per-iteration.
        const failed = [];
        let consecutiveFailures = 0;
        // The server's own ETA for the request in flight, in ms. Kept per request —
        // it is replaced by the next event, and reset when the next slice starts.
        let serverRemainingMs = null;
        let itemsDone = 0;
        for (let i = 0; i < slices.length; i += 1) {
          if (cancelled()) break;
          serverRemainingMs = null;
          itemsDone = 0;
          // Fires as each NDJSON line arrives, so the clock and the ETA move while
          // the model is still working rather than only when a slice lands.
          const onStage = (evt) => {
            if (evt.type !== 'stage') return;
            if (Number.isFinite(evt.etaSeconds)) serverRemainingMs = evt.etaSeconds * 1000;
            if (Number.isFinite(evt.done)) itemsDone = evt.done;
            const elapsedMs = Date.now() - startedAt;
            // What is left for the WHOLE batch: what the server says this request
            // still needs, plus a measured average for the slices not started. The
            // per-slice average comes from slices that actually finished, so before
            // the first one the server's own estimate is the only honest number.
            const sliceMs = i > 0 ? elapsedMs / i : serverRemainingMs;
            const remaining = serverRemainingMs == null && sliceMs == null
              ? null
              : (serverRemainingMs ?? sliceMs) + (slices.length - i - 1) * (sliceMs ?? 0);
            progress({
              done: i, total: slices.length,
              detail: `batch ${i + 1} of ${slices.length}${itemsDone ? ` · ${itemsDone}/${slices[i].length} in this batch` : ''}`,
              estimateMs: remaining == null ? null : elapsedMs + remaining,
            });
          };
          let answered = null;
          for (let attempt = 0; attempt < 2 && answered === null; attempt += 1) {
            if (cancelled()) break;
            try {
              // eslint-disable-next-line no-await-in-loop
              const r = await base44.functions.invokeStream(
                'generateSeoMeta',
                { projectId, items: slices[i].map((it) => ({ id: it.id })), stream: true },
                onStage,
              );
              answered = r.data;
            } catch (e) {
              // A CUT CONNECTION IS USUALLY A MOMENT, NOT A VERDICT.
              //
              // Rob, 2026-09-23, on a 58-item run: "managed to do 10 before a
              // network timeout", and the app said "Connection closed before
              // Morpheus finished responding." The loop below used to break on the
              // first failure, so one hiccup cost every remaining slice — 10 done
              // of 58, with 48 stranded. Retry once; and if it is still failing,
              // carry on with the rest. The slices that answered are kept either
              // way, and the note names the ones that did not.
              failure = e;
              if (attempt === 0) {
                // eslint-disable-next-line no-await-in-loop
                await new Promise((res) => setTimeout(res, 1500));
              }
            }
          }
          if (answered === null) {
            failed.push({ at: i + 1, items: slices[i].length });
            consecutiveFailures += 1;
            // Two in a row is not a hiccup — that is the server or the network
            // being down, and firing the remaining slices at it helps nobody.
            // Stop, keep what answered, and say where it stopped.
            progress({
              done: results.length, total: slices.length,
              detail: `batch ${i + 1} of ${slices.length} failed — ${consecutiveFailures > 1 ? 'stopping' : 'continuing'}`,
              estimateMs: null,
            });
            if (consecutiveFailures >= 2) break;
            continue;
          }
          consecutiveFailures = 0;
          results.push(answered);
          const done = i + 1;
          const elapsedMs = Date.now() - startedAt;
          const remaining = estimateRemainingMs({ done, total: slices.length, elapsedMs });
          progress({
            done, total: slices.length, detail: `batch ${done} of ${slices.length}`,
            estimateMs: remaining == null ? null : elapsedMs + remaining,
          });
        }

        const merged = mergeBatchResults(results);
        writeLastMs('batch', Date.now() - startedAt);
        // A failure that produced NOTHING is the task failing, and the runner
        // carries the reason. A failure with some slices already answered is a
        // partial result, and the note below says where it stopped.
        if (!merged.suggestions.length && failure) throw failure;
        return {
          ...merged,
          // The tail of the note is computed HERE, from the numbers this run
          // actually saw, so the tab can be rebuilt later and still say the truth.
          note: (() => {
            if (!merged.suggestions.length) return cancelled() ? 'Stopped before anything was generated.' : null;
            // `failed` slices did not answer, so they are neither empty nor
            // generated — subtracting them keeps the two counts from describing
            // the same items twice.
            const missed = failed.reduce((n, f) => n + f.items, 0);
            const empty = work.length - merged.generated - missed;
            const capped = missing.length - work.length;
            const tail = [
              missed > 0 ? `${missed} in ${failed.length} batch${failed.length > 1 ? 'es' : ''} did not answer — click again for those` : null,
              empty > 0 ? `${empty} came back empty` : null,
              capped > 0 ? `${capped} still waiting (click again for the next ${SEO_BATCH_MAX})` : null,
            ].filter(Boolean).join(' · ');
            // "Stopped" now means it actually stopped — cancelled, or two slices
            // in a row failed. A failure it carried on past is a gap in the middle,
            // not an ending, and saying "stopped" there would be a lie about a run
            // that is still holding the rest of its slices.
            const stopped = cancelled() || consecutiveFailures >= 2;
            if (stopped && failure) return `Stopped at ${merged.generated} of ${missing.length} — ${failure?.data?.error || failure?.data?.message || failure.message}`;
            if (cancelled()) return `Stopped — ${merged.generated} of ${missing.length} generated. The rest are still listed as missing.`;
            return tail ? `${merged.generated} generated · ${tail}` : null;
          })(),
        };
      },
    );
  };

  const applyBatch = async () => {
    const chosen = (batch?.suggestions || []).filter((s) => batch.checked[s.id]);
    if (chosen.length === 0) return;
    setApplying(true); setErr(null); setNote(null);
    try {
      const r = await call(projectId, 'bulk_set_seo', {
        items: chosen.map((s) => ({ id: s.id, seo_title: s.seo_title, seo_description: s.seo_description, focus_keyword: s.focus_keyword })),
      });
      if (r?.ok === false) throw new Error(r.message || 'The site rejected the change.');
      const failed = r?.failed?.length || 0;
      setNote(`Applied to ${r?.count ?? chosen.length} item${(r?.count ?? chosen.length) === 1 ? '' : 's'}${failed ? ` — ${failed} failed` : ''}.`);
      setBatch(null); setAudit(null);
      const list = await call(projectId, 'list_content', { limit: 60 });
      setItems(list?.items || []);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setApplying(false); }
  };

  const openDefaults = async () => {
    setView('defaults'); setErr(null); setNote(null); setFillPlan(null);
    try {
      const r = await call(projectId, 'get_defaults', {});
      if (r?.defaults) setDefaults(r.defaults);
    } catch (e) { setErr(e?.data?.error || e.message); }
  };

  const saveDefaults = async (next) => {
    const payload = next || defaults;
    setSavingDefaults(true); setErr(null); setNote(null);
    try {
      const r = await call(projectId, 'set_defaults', { defaults: payload });
      if (r?.ok === false) throw new Error(r.message || 'The site rejected the change.');
      setDefaults(r.defaults);
      setNote('Saved.');
      setItems(null); setAudit(null);
      const list = await call(projectId, 'list_content', { limit: 60 });
      setItems(list?.items || []);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setSavingDefaults(false); }
  };

  // Dry run first: the panel shows the exact values that WOULD be written, so
  // nothing lands on a live site that the operator has not seen.
  const planFill = async () => {
    setFilling(true); setErr(null); setNote(null); setFillPlan(null);
    try {
      const r = await call(projectId, 'bulk_apply_defaults', { dry_run: true, limit: 25 });
      if (r?.ok === false) throw new Error(r.message || 'The site rejected the request.');
      setFillPlan(r);
      if (!r.preview?.length) setNote('Every item already has a title and a description — nothing to fill.');
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setFilling(false); }
  };

  const applyFill = async () => {
    setFilling(true); setErr(null); setNote(null);
    try {
      const r = await call(projectId, 'bulk_apply_defaults', { limit: 25 });
      if (r?.ok === false) throw new Error(r.message || 'The site rejected the change.');
      setNote(`Filled ${r.count} item${r.count === 1 ? '' : 's'} from the template${r.failed?.length ? ` — ${r.failed.length} failed` : ''}.`);
      setFillPlan(null); setAudit(null); setItems(null);
      const list = await call(projectId, 'list_content', { limit: 60 });
      setItems(list?.items || []);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setFilling(false); }
  };

  const createBlog = async () => {
    setPosting(true); setErr(null); setNote(null);
    try {
      const d = blog.draft;
      // createSitePost, not wordPressStoreAction: the store dispatcher lives in
      // the `store` widget scope, so an SEO-only embed composed a post and then
      // could not save it. This function does exactly this one write and forces
      // the post to a draft; see server/src/functions/createSitePost.js.
      const created = await base44.functions.invoke('createSitePost', {
        projectId,
        title: d.title, content: d.content, excerpt: d.excerpt, status: 'draft',
      }).then((x) => x.data);
      if (created?.ok === false) throw new Error(created.message || 'The site rejected the post.');
      const postId = created?.post?.id;
      if (postId) {
        await call(projectId, 'set_seo', {
          id: postId, seo_title: d.seo_title, seo_description: d.seo_description, focus_keyword: d.focus_keyword,
        });
      }
      setBlog({ ...blog, created: created?.post, draft: null });
      setItems(null); setAudit(null);
      const list = await call(projectId, 'list_content', { limit: 60 });
      setItems(list?.items || []);
      setNote('Saved as a DRAFT on your site — nothing is public until you publish it.');
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setPosting(false); }
  };

  const generateBlog = async () => {
    setErr(null); setNote(null);
    const form = blog.form;
    await task('seo:blog', 'Writing the draft', async ({ cancelled }) => {
      if (cancelled()) return null;
      const r = await base44.functions.invoke('generateBlogPost', { projectId, ...form }).then((x) => x.data);
      if (!r?.draft) throw new Error('No draft came back — try again.');
      return { form, draft: r.draft, warnings: r.warnings, linkable: r.linkable };
    });
  };
  useTaskResult('seo:blog', (r) => {
    setBlog(r);
    setView('blog'); // the draft is the answer; returning to the tab should show it
  });

  // ── not available on this site's plugin build ────────────────────────────
  if (store && store.connected && store.seo_available === false) {
    return (
      <div className="p-4 space-y-2">
        <div className="text-[12px] text-yellow-500/85 border border-yellow-500/30 px-3 py-2 leading-relaxed">
          This site is running the Morpheus plugin version {store.version || 'older than 0.5'} — it doesn't have the SEO module yet.
        </div>
        <div className="text-[11px] text-ink-max leading-relaxed">
          Reinstall the plugin from the SETUP tab and the SEO tab appears. Your connection and settings are kept.
        </div>
      </div>
    );
  }

  // ── header, shared by the list and the item view ──────────────────────────
  const ownerLine = ctx
    ? ctx.owns_head
      ? 'Morpheus writes the title and description tags for this site.'
      : `${ctx.active_plugin === 'yoast' ? 'Yoast' : ctx.active_plugin === 'rankmath' ? 'Rank Math' : ctx.active_plugin === 'aioseo' ? 'All in One SEO' : ctx.active_plugin === 'seopress' ? 'SEOPress' : ctx.active_plugin} is active, so these fields are written into its own settings — nothing is emitted twice.`
    : null;

  if (view === 'item' && edit) {
    const f = edit.form;
    const set = (k, v) => setEdit((cur) => ({ ...cur, form: { ...cur.form, [k]: v } }));
    const preview = serpPreview({
      title: f.seo_title,
      description: f.seo_description,
      url: edit.url,
      titleFallback: edit.effective_title,
      descriptionFallback: edit.effective_description,
      titleMax: limits.title_max,
      descMax: limits.desc_max,
    });
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 border-b border-primary/15 shrink-0 h-[40px] px-3">
          <button onClick={() => { setView('list'); setEdit(null); setNote(null); setErr(null); }}
            className="flex items-center gap-1 text-[11px] text-primary/60 hover:text-primary">
            <ChevronLeft size={14} /> SEO
          </button>
          <span className="text-[11px] text-ink-max truncate ml-1">{edit.title || `#${edit.id}`}</span>
          {edit.status && (
            <span className={`ml-auto text-[9px] uppercase px-1.5 py-0.5 border shrink-0 ${edit.status === 'publish' ? 'text-primary border-primary/50' : 'text-yellow-500/80 border-yellow-500/40'}`}>
              {edit.status === 'publish' ? 'live' : edit.status}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-matrix p-3 space-y-3">
          {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}
          {note && <div className="text-ink-max text-[11px] border border-primary/40 bg-primary/5 px-3 py-2">{note}</div>}

          {(issuesById[edit.id] || []).length > 0 && (
            <div className="border border-yellow-500/30 px-3 py-2 space-y-1">
              <div className="text-[9px] text-yellow-500/85 uppercase tracking-wider">What the audit found here</div>
              {(issuesById[edit.id] || []).map((i, n) => (
                <div key={n} className="text-[10px] text-ink-max flex items-start gap-1.5">
                  <span className={`uppercase text-[9px] shrink-0 ${i.severity === 'high' ? 'text-red-400' : i.severity === 'medium' ? 'text-yellow-500/85' : 'text-primary/40'}`}>{i.severity}</span>
                  <span>{i.message}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            {edit.url && (
              <a href={edit.url} target="_blank" rel="noreferrer" className="text-[10px] text-primary/50 hover:text-primary flex items-center gap-1">
                <ExternalLink size={10} /> view on site
              </a>
            )}
            {edit.edit_url && (
              <a href={edit.edit_url} target="_blank" rel="noreferrer" className="text-[10px] text-primary/50 hover:text-primary flex items-center gap-1">
                <ExternalLink size={10} /> edit in WordPress
              </a>
            )}
            <button onClick={generateOne} disabled={running.one}
              className="ml-auto h-[32px] px-2.5 text-[10px] border border-primary/40 text-primary hover:border-primary disabled:opacity-40 flex items-center gap-1.5">
              {running.one ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />} WRITE IT FOR ME
            </button>
            <button onClick={suggestLinks} disabled={running.links} title="Which of your other pages this one should link to"
              className="h-[32px] px-2.5 text-[10px] border border-primary/40 text-primary hover:border-primary disabled:opacity-40 flex items-center gap-1.5">
              {running.links ? <Loader2 size={11} className="animate-spin" /> : <Link2 size={11} />} LINK IDEAS
            </button>
            <button onClick={runKeywords} disabled={running.keywords} title="What people actually search for, and what competing pages target"
              className="h-[32px] px-2.5 text-[10px] border border-primary/40 text-primary hover:border-primary disabled:opacity-40 flex items-center gap-1.5">
              {running.keywords ? <Loader2 size={11} className="animate-spin" /> : <Search size={11} />} KEYWORD IDEAS
            </button>
          </div>
          <div className="space-y-1">
            <div className="text-[9px] text-primary/35 uppercase tracking-wider">Competitor pages to compare (optional, up to 8)</div>
            <input className={inputCls} value={competitors} onChange={(e) => rememberCompetitors(e.target.value)}
              placeholder="rival1.com/repairs, rival2.com" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <div className="text-[9px] text-ink-max">
              Morpheus reads what those pages say about themselves — their title, description and headings. When Search Console is
              connected, your site's own queries come first, with Google's real impressions, clicks and average position on them. It
              does not guess at anyone's traffic, and there are no invented search volumes anywhere in this panel.
            </div>
          </div>

          {edit.suggestion && (
            <div className="border border-primary/40 bg-primary/5 p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-[10px] text-primary/60 uppercase tracking-wider">
                <Sparkles size={10} /> suggestion
              </div>
              <SuggestionRow s={edit.suggestion} checked onToggle={() => {}} />
              <div className="flex items-center gap-2">
                <Btn kind="primary" onClick={() => {
                  const s = edit.suggestion;
                  setEdit((cur) => ({
                    ...cur,
                    suggestion: null,
                    form: { ...cur.form, seo_title: s.seo_title, seo_description: s.seo_description, focus_keyword: s.focus_keyword || cur.form.focus_keyword },
                  }));
                  setNote('Loaded into the fields below — read it, then SAVE.');
                }}>
                  <Check size={12} /> USE THIS
                </Btn>
                <Btn onClick={() => setEdit((cur) => ({ ...cur, suggestion: null }))}>
                  <X size={12} /> Discard
                </Btn>
              </div>
            </div>
          )}

          {kw && (
            <div className="border border-primary/30 bg-primary/5 p-3 space-y-2">
              <div className="text-[10px] text-primary/60 uppercase tracking-wider flex items-center gap-1.5">
                <Search size={10} /> keyword ideas · {kw.count}
              </div>

              {/* Competitors, as they describe themselves. Read-only: this is
                  someone else's page, and the point is to see what they target. */}
              {(kw.competitors || []).length > 0 && (
                <div className="space-y-1.5 border border-primary/15 px-2.5 py-2">
                  <div className="text-[9px] text-primary/40 uppercase tracking-wider">What they target</div>
                  {(kw.competitors || []).map((c) => (
                    <div key={c.url} className="text-[10px]">
                      {c.error ? (
                        <span className="text-yellow-500/80">{c.url.replace(/^https?:\/\//, '')} — {c.error}</span>
                      ) : (
                        <>
                          <div className="text-ink-max truncate">{c.title || c.url.replace(/^https?:\/\//, '')}</div>
                          {c.headings?.length > 0 && (
                            <div className="text-ink-max text-[9px] truncate">{c.headings.join(' · ')}</div>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-1 max-h-[40vh] overflow-y-auto scrollbar-matrix">
                {(kw.keywords || []).map((row) => (
                  <div key={row.phrase} className="border border-primary/15 px-2.5 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[11px] text-ink-max break-words">{row.display || row.phrase}</div>
                        <div className="text-[9px] text-ink-max mt-0.5 flex flex-wrap gap-1.5">
                          {/* Labels and provenance come from the payload: the
                              server builds them, so the two surfaces that mount
                              this tab cannot drift apart on what a row is. */}
                          {(row.source_labels || []).map((label) => (
                            <span key={label} className="border border-primary/20 px-1 py-0.5">{label}</span>
                          ))}
                          {row.provenance && <span className="text-ink-max">from: {row.provenance}</span>}
                        </div>
                        {/* Google's own numbers for this query, copied exactly —
                            the only measured figures in this list. */}
                        {row.gsc_summary && (
                          <div className="text-[9px] text-cyan-300/50 mt-0.5">{row.gsc_summary}</div>
                        )}
                      </div>
                      <button onClick={() => {
                        setEdit((cur) => ({ ...cur, form: { ...cur.form, focus_keyword: row.phrase } }));
                        setKw(null);
                        setNote('Loaded as the focus keyword — SAVE to apply it.');
                      }} className="shrink-0 text-[9px] px-2 py-1 border border-primary/40 text-primary/80 hover:border-primary hover:text-primary">
                        USE
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="text-[9px] text-ink-max leading-relaxed border-t border-primary/10 pt-2">{kw.disclosure}</div>
              <div className="flex items-center gap-2">
                <button onClick={() => setKw(null)} className="text-[10px] text-primary/45 hover:text-primary/80">Close</button>
              </div>
            </div>
          )}

          {/* Search Console sits beside keyword research but is the opposite kind of
              number: keyword research shows what people type with no volume, this
              shows Google's own figures for your own property. Both say where they
              came from — see SearchConsolePanel.jsx. */}
          <SearchConsolePanel onNote={setNote} widget={widget} />

          {links && (
            <div className="border border-primary/30 bg-primary/5 p-3 space-y-2">
              <div className="text-[10px] text-primary/60 uppercase tracking-wider flex items-center gap-1.5">
                <Link2 size={10} /> link ideas
              </div>
              {(links.links || []).length === 0 && <div className="text-[10px] text-ink-max">Nothing to suggest for this page.</div>}
              {(links.links || []).map((l, i) => (
                <div key={`${l.url}-${i}`} className={`border px-2.5 py-2 ${links.checked[i] ? 'border-primary/30' : 'border-primary/10 opacity-60'}`}>
                  <div className="flex items-start gap-2">
                    <button onClick={() => setLinks((cur) => ({ ...cur, checked: { ...cur.checked, [i]: !cur.checked[i] } }))}
                      className="mt-0.5 shrink-0" title={links.checked[i] ? 'Skip this link' : 'Include this link'}>
                      <span className={`w-[15px] h-[15px] border flex items-center justify-center ${links.checked[i] ? 'border-primary bg-primary/20 text-primary' : 'border-primary/30 text-transparent'}`}>
                        <Check size={11} />
                      </span>
                    </button>
                    <div className="min-w-0">
                      <div className="text-[11px] text-ink-max">“{l.anchor}”</div>
                      <div className="text-[10px] text-ink-max mt-0.5 break-words">→ {l.target || l.url}</div>
                      {l.why && <div className="text-[9px] text-ink-max mt-0.5">{l.why}</div>}
                    </div>
                  </div>
                </div>
              ))}
              {links.dropped?.length > 0 && (
                <div className="text-[9px] text-yellow-500/80 leading-relaxed">
                  {links.dropped.length} suggestion{links.dropped.length === 1 ? '' : 's'} discarded: {links.dropped.slice(0, 3).map((d) => d.reason).join('; ')}
                  {links.dropped.length > 3 ? '…' : ''}
                </div>
              )}
              {(links.links || []).length > 0 && (
                <div className="flex items-center gap-2">
                  <Btn kind="primary" onClick={planLinks} disabled={running.linkWrite}>
                    {running.linkWrite ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    REVIEW {(links.links || []).filter((_, i) => links.checked[i]).length}
                  </Btn>
                  <Btn onClick={() => setLinks(null)}><X size={12} /> Close</Btn>
                </div>
              )}
            </div>
          )}

          {linkPlan && (
            <div className="border border-primary/40 bg-primary/5 p-3 space-y-2">
              <div className="text-[10px] text-primary/60 uppercase tracking-wider">
                {linkPlan.added?.length || 0} link{(linkPlan.added?.length || 0) === 1 ? '' : 's'} would be added
              </div>
              {(linkPlan.added || []).map((a, i) => (
                <div key={i} className="border border-primary/15 px-2.5 py-2">
                  <div className="text-[11px] text-ink-max">“{a.anchor}”</div>
                  <div className="text-[9px] text-ink-max break-words">{a.url}</div>
                  {a.context && <div className="text-[9px] text-ink-max mt-1 leading-relaxed break-words font-mono">{a.context}</div>}
                </div>
              ))}
              {linkPlan.skipped?.length > 0 && (
                <div className="text-[9px] text-yellow-500/80">
                  {linkPlan.skipped.length} refused: {linkPlan.skipped.map((s) => s.reason).join('; ')}
                </div>
              )}
              <div className="text-[9px] text-ink-max">
                Nothing has been written yet — this is the sentence each link would land in. Your text is never deleted, and WordPress keeps a revision.
              </div>
              <div className="flex items-center gap-2">
                <Btn kind="primary" onClick={applyLinks} disabled={running.linkWrite || !linkPlan.added?.length}>
                  {running.linkWrite ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} ADD LINKS
                </Btn>
                <Btn onClick={() => setLinkPlan(null)}><X size={12} /> Cancel</Btn>
              </div>
            </div>
          )}

          <Field label="SEO title" right={<Counter value={f.seo_title} min={limits.title_min} max={limits.title_max} />}
            hint="what appears as the clickable headline in search results — the site name is added for you">
            <input className={inputCls} value={f.seo_title} onChange={(e) => set('seo_title', e.target.value)} />
          </Field>
          {!f.seo_title && edit.effective_title && (
            <div className="text-[9px] text-ink-max -mt-2">Currently search sees: “{edit.effective_title}”</div>
          )}

          <Field label="Meta description" right={<Counter value={f.seo_description} min={limits.desc_min} max={limits.desc_max} />}
            hint="the blurb under the headline — it doesn't change your ranking, it decides whether people click">
            <textarea className={areaCls} rows={3} value={f.seo_description} onChange={(e) => set('seo_description', e.target.value)} />
          </Field>

          {/* Seeing the result is the point: two titles that differ by ten
              characters look the same in a form and different in a search
              result. Approximate on purpose — Google rewrites snippets and
              measures in pixels — so it says so. */}
          <div className="border border-primary/15 px-3 py-2.5">
            <div className="text-[9px] text-primary/35 uppercase tracking-wider mb-2">Roughly how it will read in a search result</div>
            <div className="text-[13px] text-[#8ab4f8] leading-snug break-words">{preview.title || '(no title)'}</div>
            <div className="text-[10px] text-[#5bb974] mt-0.5 truncate">{preview.breadcrumb || edit.url}</div>
            <div className="text-[11px] text-ink-max mt-1 leading-relaxed break-words">
              {preview.description || 'No description — a search engine will invent one from the page.'}
            </div>
            {preview.titleTruncated && <div className="text-[9px] text-yellow-500/80 mt-1">The title is cut off at this length.</div>}
            {preview.descriptionTruncated && <div className="text-[9px] text-yellow-500/80 mt-0.5">The description is cut off at this length.</div>}
            {preview.usedFallback && <div className="text-[9px] text-ink-max mt-1">Showing what the site would use on its own where a field is empty.</div>}
            <div className="text-[9px] text-ink-max mt-1">An approximation — search engines re-write and re-cut snippets themselves.</div>
          </div>

          <Field label="Focus keyword" hint="the phrase you want this page found for — used by the audit to check it appears in the title">
            <input className={inputCls} value={f.focus_keyword} onChange={(e) => set('focus_keyword', e.target.value)} />
          </Field>

          <Field label="Canonical URL" hint="leave empty unless this content is duplicated elsewhere — then point it at the one true version">
            <input className={inputCls} value={f.canonical} onChange={(e) => set('canonical', e.target.value)} placeholder={edit.url || 'https://…'} />
          </Field>

          <Field label="Social share image" hint="the picture shown when the page is shared — 1200×630 works everywhere">
            <input className={inputCls} value={f.og_image} onChange={(e) => set('og_image', e.target.value)} placeholder="https://…" />
          </Field>

          <label className="flex items-start gap-2 border border-primary/15 px-3 py-2.5 cursor-pointer">
            <input type="checkbox" className="mt-0.5 accent-[color:var(--primary,#4f8cff)]"
              checked={f.noindex} onChange={(e) => set('noindex', e.target.checked)} />
            <span className="text-[11px] leading-relaxed">
              <span className={f.noindex ? 'text-yellow-500/90' : 'text-ink-max'}>Keep this out of search results (noindex)</span>
              <span className="block text-[9px] text-ink-max mt-0.5">
                Use for a thank-you page, a test page, or anything you don't want strangers landing on. It stays live on the site — it just stops being listed.
              </span>
            </span>
          </label>
        </div>

        <div className="p-3 border-t border-primary/20 shrink-0 flex items-center gap-2">
          <Btn kind="primary" onClick={save} disabled={saving}>
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} SAVE SEO
          </Btn>
        </div>
      </div>
    );
  }

  if (view === 'defaults' && defaults) {
    const d = defaults;
    const setD = (k, v) => setDefaults((cur) => ({ ...cur, [k]: v }));
    const setType = (type, k, v) => setDefaults((cur) => ({
      ...cur,
      post_types: { ...cur.post_types, [type]: { ...(cur.post_types?.[type] || {}), [k]: v } },
    }));
    // An example built from real content on this site, so the tokens are shown
    // doing their job rather than described.
    const sample = (items || [])[0] || { title: 'A page title', effective_description: '' };
    const sampleVars = { title: sample.title, siteName: ctx?.site_title || '', tagline: ctx?.tagline || '', excerpt: sample.effective_description || '' };
    const exampleTitle = resolveTemplate(d.title, sampleVars);
    const exampleDesc = resolveTemplate(d.description, sampleVars);
    // A token chip inserts at the caret of whichever field the operator last
    // touched — on a phone there is no "drag to position", so appending to the
    // wrong field would be a dead end.
    const addToken = (token) => {
      const field = lastField;
      const el = field === 'title' ? titleRef.current : descRef.current;
      const cur = d[field] || '';
      if (!el) { setD(field, cur + token); return; }
      const at = el.selectionStart ?? cur.length;
      const end = el.selectionEnd ?? at;
      setD(field, insertToken(cur, token, at, end));
      requestAnimationFrame(() => {
        el.focus();
        try { el.setSelectionRange(at + token.length, at + token.length); } catch { /* not focusable */ }
      });
    };

    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 border-b border-primary/15 shrink-0 h-[40px] px-3">
          <button onClick={() => { setView('list'); setNote(null); setErr(null); setFillPlan(null); }}
            className="flex items-center gap-1 text-[11px] text-primary/60 hover:text-primary">
            <ChevronLeft size={14} /> SEO
          </button>
          <span className="text-[11px] text-ink-max ml-1">Site defaults</span>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-matrix p-3 space-y-3">
          {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}
          {note && <div className="text-ink-max text-[11px] border border-primary/40 bg-primary/5 px-3 py-2">{note}</div>}

          <p className="text-[11px] text-ink-max leading-relaxed">
            What a title and description look like for anything you have not set by hand — new pages included, as they are created.
            {!ctx?.owns_head && (
              <span className="block mt-1 text-yellow-500/85">
                {ctx?.active_plugin === 'yoast' ? 'Yoast' : ctx?.active_plugin === 'rankmath' ? 'Rank Math' : ctx?.active_plugin === 'aioseo' ? 'All in One SEO' : ctx?.active_plugin === 'seopress' ? 'SEOPress' : 'Another SEO plugin'} is producing your tags, so it decides what goes out — use FILL EXISTING below to write these templates into the pages that have nothing set.
              </span>
            )}
          </p>

          <label className="flex items-start gap-2 border border-primary/15 px-3 py-2.5 cursor-pointer">
            <input type="checkbox" className="mt-0.5 accent-[color:var(--primary,#4f8cff)]"
              checked={!!d.enabled} onChange={(e) => setD('enabled', e.target.checked)} />
            <span className="text-[11px] leading-relaxed">
              <span className={d.enabled ? 'text-ink-max' : 'text-ink-max'}>Use these defaults</span>
              <span className="block text-[9px] text-ink-max mt-0.5">
                Off means WordPress's own values are used: the post title, and nothing for the description.
              </span>
            </span>
          </label>

          <div className="space-y-1">
            <div className="text-[10px] text-primary/45 uppercase tracking-wider">Title</div>
            <input ref={titleRef} className={inputCls} value={d.title || ''}
              onFocus={() => setLastField('title')}
              onChange={(e) => setD('title', e.target.value)}
              placeholder="%title% | %sitename%" />
          </div>

          <div className="space-y-1">
            <div className="text-[10px] text-primary/45 uppercase tracking-wider">Meta description</div>
            <textarea ref={descRef} className={areaCls} rows={2} value={d.description || ''}
              onFocus={() => setLastField('description')}
              onChange={(e) => setD('description', e.target.value)}
              placeholder="%excerpt%" />
          </div>

          <div>
            <div className="text-[9px] text-primary/35 uppercase tracking-wider mb-1">
              Tokens — tap to insert into the {lastField} field
            </div>
            <div className="flex flex-wrap gap-1.5">
              {TEMPLATE_TOKENS.map((t) => (
                <button key={t} onClick={() => addToken(t)}
                  title={TOKEN_HELP[t]}
                  className="text-[10px] px-2 py-1 border border-primary/25 text-primary/70 hover:border-primary hover:text-primary font-mono">
                  {t}
                </button>
              ))}
            </div>
            <div className="text-[9px] text-ink-max mt-1">
              {TEMPLATE_TOKENS.map((t) => `${t} = ${TOKEN_HELP[t]}`).join(' · ')}
            </div>
          </div>

          <div className="border border-primary/15 px-3 py-2.5">
            <div className="text-[9px] text-primary/35 uppercase tracking-wider mb-1.5">
              Example — using “{sample.title || 'your first page'}”
            </div>
            <div className="text-[13px] text-[#8ab4f8] leading-snug break-words">{exampleTitle || '(no title)'}</div>
            <div className="text-[11px] text-ink-max mt-1 leading-relaxed break-words">{exampleDesc || 'No description.'}</div>
          </div>

          <div className="border border-primary/15 p-3 space-y-2">
            <div className="text-[10px] text-primary/45 uppercase tracking-wider">Per type — overrides the site-wide one</div>
            {(d.post_types ? Object.keys(d.post_types) : []).map((type) => (
              <div key={type} className="space-y-1">
                <div className="text-[10px] text-primary/60 uppercase">{type}</div>
                <input className={inputCls} value={d.post_types[type]?.title || ''}
                  onChange={(e) => setType(type, 'title', e.target.value)} placeholder="(site-wide title)" />
                <input className={inputCls} value={d.post_types[type]?.description || ''}
                  onChange={(e) => setType(type, 'description', e.target.value)} placeholder="(site-wide description)" />
              </div>
            ))}
          </div>

          {fillPlan && (
            <div className="border border-primary/40 bg-primary/5 p-3 space-y-2">
              <div className="text-[10px] text-primary/60 uppercase tracking-wider">
                {fillPlan.preview?.length || 0} item{(fillPlan.preview?.length || 0) === 1 ? '' : 's'} would be filled
              </div>
              <div className="space-y-1.5 max-h-[35vh] overflow-y-auto scrollbar-matrix">
                {(fillPlan.preview || []).map((r) => (
                  <div key={r.id} className="border border-primary/15 px-2.5 py-2">
                    <div className="text-[11px] text-ink-max truncate">{r.title || `#${r.id}`}</div>
                    {r.seo_title && <div className="text-[10px] text-ink-max mt-0.5 break-words">{r.seo_title}</div>}
                    {r.seo_description && <div className="text-[10px] text-ink-max mt-0.5 break-words">{r.seo_description}</div>}
                  </div>
                ))}
              </div>
              <div className="text-[9px] text-ink-max leading-relaxed">
                Nothing has been written yet — this is exactly what APPLY would save. Items that already have a title or
                description are left alone. These values are saved onto each page, so switching the defaults off later
                will not remove them.
              </div>
              <div className="flex items-center gap-2">
                <Btn kind="primary" onClick={applyFill} disabled={filling}>
                  {filling ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} APPLY
                </Btn>
                <Btn onClick={() => setFillPlan(null)}><X size={12} /> Cancel</Btn>
              </div>
            </div>
          )}
        </div>

        <div className="p-3 border-t border-primary/20 shrink-0 flex items-center gap-2">
          <Btn kind="primary" onClick={() => saveDefaults()} disabled={savingDefaults}>
            {savingDefaults ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} SAVE DEFAULTS
          </Btn>
          <Btn onClick={planFill} disabled={filling}>
            {filling ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />} FILL EXISTING
          </Btn>
        </div>
      </div>
    );
  }

  if (view === 'blog') {
    const b = blog || { form: { topic: '', keywords: '', tone: '', words: 700 } };
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 border-b border-primary/15 shrink-0 h-[40px] px-3">
          <button onClick={() => { setView('list'); setBlog(null); setNote(null); setErr(null); }}
            className="flex items-center gap-1 text-[11px] text-primary/60 hover:text-primary">
            <ChevronLeft size={14} /> SEO
          </button>
          <span className="text-[11px] text-ink-max ml-1">New blog post</span>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-matrix p-3 space-y-3">
          {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}
          {note && <div className="text-ink-max text-[11px] border border-primary/40 bg-primary/5 px-3 py-2">{note}</div>}

          {!b.draft && !b.created && (
            <>
              <p className="text-[11px] text-ink-max leading-relaxed">
                Morpheus writes the post using your business profile and links to pages you already have. It lands as a
                <span className="text-ink-max"> draft</span> — you read it before it goes public.
              </p>
              <Field label="Topic" hint="leave empty and it picks the most useful thing your business could publish">
                <input className={inputCls} value={b.form.topic} onChange={(e) => setBlog({ ...b, form: { ...b.form, topic: e.target.value } })} />
              </Field>
              <Field label="Target phrases" hint="optional — comma separated, used naturally">
                <input className={inputCls} value={b.form.keywords} onChange={(e) => setBlog({ ...b, form: { ...b.form, keywords: e.target.value } })} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Tone">
                  <input className={inputCls} value={b.form.tone} onChange={(e) => setBlog({ ...b, form: { ...b.form, tone: e.target.value } })} placeholder="plain, expert" />
                </Field>
                <Field label="Length (words)">
                  <input type="number" min={300} max={1500} step={50} className={inputCls}
                    value={b.form.words} onChange={(e) => setBlog({ ...b, form: { ...b.form, words: Number(e.target.value) } })} />
                </Field>
              </div>
            </>
          )}

          {b.draft && (
            <>
              <div className="text-[9px] text-primary/40 uppercase tracking-wider flex items-center gap-1.5">
                <Eye size={10} /> draft — edit anything before saving
              </div>
              <Field label="Title">
                <input className={inputCls} value={b.draft.title} onChange={(e) => setBlog({ ...b, draft: { ...b.draft, title: e.target.value } })} />
              </Field>
              <Field label="Excerpt">
                <textarea className={areaCls} rows={2} value={b.draft.excerpt} onChange={(e) => setBlog({ ...b, draft: { ...b.draft, excerpt: e.target.value } })} />
              </Field>
              <Field label="Body (HTML)" hint="basic tags — headings, paragraphs, lists, links">
                <textarea className={areaCls} rows={14} value={b.draft.content} onChange={(e) => setBlog({ ...b, draft: { ...b.draft, content: e.target.value } })} />
              </Field>
              <Field label="SEO title" right={<Counter value={b.draft.seo_title} min={limits.title_min} max={limits.title_max} />}>
                <input className={inputCls} value={b.draft.seo_title} onChange={(e) => setBlog({ ...b, draft: { ...b.draft, seo_title: e.target.value } })} />
              </Field>
              <Field label="Meta description" right={<Counter value={b.draft.seo_description} min={limits.desc_min} max={limits.desc_max} />}>
                <textarea className={areaCls} rows={2} value={b.draft.seo_description} onChange={(e) => setBlog({ ...b, draft: { ...b.draft, seo_description: e.target.value } })} />
              </Field>
              <Field label="Focus keyword">
                <input className={inputCls} value={b.draft.focus_keyword} onChange={(e) => setBlog({ ...b, draft: { ...b.draft, focus_keyword: e.target.value } })} />
              </Field>
              {b.warnings?.length > 0 && (
                <div className="text-[9px] text-yellow-500/80 flex items-start gap-1">
                  <AlertTriangle size={9} className="mt-[2px] shrink-0" />
                  <span>{b.warnings.join(' · ')}</span>
                </div>
              )}
              {b.linkable > 0 && <div className="text-[9px] text-ink-max">Written with {b.linkable} of your existing pages available to link to.</div>}
            </>
          )}

          {b.created && (
            <div className="border border-primary/40 bg-primary/5 px-3 py-2.5 text-[11px] space-y-1.5">
              <div className="flex items-center gap-1.5 text-primary font-bold"><Check size={13} /> Draft created</div>
              <div className="text-ink-max">It's on your site as a draft. Publish it from WordPress when you're happy with it.</div>
              {b.created.edit_url && (
                <a href={b.created.edit_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary/70 hover:text-primary">
                  <ExternalLink size={11} /> Open it in WordPress
                </a>
              )}
            </div>
          )}
        </div>

        <div className="p-3 border-t border-primary/20 shrink-0 flex items-center gap-2">
          {!b.draft && !b.created && (
            <Btn kind="primary" onClick={generateBlog} disabled={running.blog}>
              {running.blog ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} WRITE IT
            </Btn>
          )}
          {b.draft && (
            <>
              <Btn kind="primary" onClick={createBlog} disabled={posting || !b.draft.title.trim() || !b.draft.content.trim()}>
                {posting ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />} SAVE AS DRAFT
              </Btn>
              <Btn onClick={generateBlog} disabled={running.blog}>
                {running.blog ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Rewrite
              </Btn>
            </>
          )}
          {b.created && (
            <Btn kind="primary" onClick={() => { setBlog({ form: { topic: '', keywords: '', tone: '', words: 700 } }); }}>
              <Plus size={12} /> ANOTHER
            </Btn>
          )}
        </div>
        {timerFor('blog')}
      </div>
    );
  }

  // ── the list ─────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto scrollbar-matrix p-3 space-y-2.5">
        {ownerLine && (
          <div className="text-[10px] text-ink-max leading-relaxed border border-primary/15 px-3 py-2">
            {ownerLine}
            {ctx.sitemap_url && (
              <a href={ctx.sitemap_url} target="_blank" rel="noreferrer" className="ml-1 text-primary/70 hover:text-primary inline-flex items-center gap-1">
                sitemap <ExternalLink size={9} />
              </a>
            )}
            {ctx.blog_public === false && (
              <span className="block text-yellow-500/85 mt-1">
                Search engines are blocked site-wide (WordPress → Settings → Reading → "Discourage search engines"). Nothing here will be indexed until that is switched off.
              </span>
            )}
          </div>
        )}

        {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}
        {note && <div className="text-ink-max text-[11px] border border-primary/40 bg-primary/5 px-3 py-2">{note}</div>}

        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-1.5 bg-black/30 border border-primary/20 px-2 h-[34px]">
            <Search size={11} className="text-primary/35 shrink-0" />
            <input className="flex-1 bg-transparent text-[12px] text-ink-strong focus:outline-none min-w-0"
              placeholder="Search content" value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') load(); }} />
          </div>
          <button onClick={() => load()} className="h-[34px] px-2.5 text-primary/60 hover:text-primary border border-primary/20 flex items-center gap-1 shrink-0">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <Btn onClick={runAudit} disabled={running.audit}>
            {running.audit ? <Loader2 size={11} className="animate-spin" /> : <AlertTriangle size={11} />} AUDIT
          </Btn>
          <Btn onClick={generateBatch} disabled={genBatch} kind={missing.length ? 'primary' : 'ghost'}>
            {genBatch ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />} FILL MISSING ({missing.length})
          </Btn>
          <Btn onClick={() => { setView('blog'); setBlog({ form: { topic: '', keywords: '', tone: '', words: 700 } }); setNote(null); setErr(null); }}>
            <Plus size={11} /> POST
          </Btn>
          <Btn onClick={openDefaults} title="What un-set titles and descriptions look like">
            <Settings2 size={11} /> DEFAULTS
          </Btn>
        </div>

        {/* No timer here for the batch: it runs in the task runner, above the tab
            switch, and the runner's strip is on screen from every tab. A timer
            drawn by this component is a timer that stops being drawn the moment
            the operator leaves — which is the bug this replaced. */}

        {audit && (
          <div className="border border-primary/15 px-3 py-2 text-[10px] text-ink-max">
            <div className="flex items-center gap-3">
              <span className="text-red-400">{audit.counts?.high || 0} high</span>
              <span className="text-yellow-500/85">{audit.counts?.medium || 0} medium</span>
              <span>{audit.counts?.low || 0} low</span>
              <span className="ml-auto">{audit.scanned} scanned</span>
            </div>
            <div className="text-ink-max mt-1">
              High = missing or duplicated metadata on something that is live. Tap an item to fix it.
            </div>
          </div>
        )}

        {batch && (
          <div className="border border-primary/40 bg-primary/5 p-3 space-y-2">
            <div className="text-[10px] text-primary/60 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles size={10} /> {batch.generated} to review{batch.missing?.length ? ` · ${batch.missing.length} not generated` : ''}
            </div>
            {batch.title_only > 0 && (
              <div className="text-[9px] text-yellow-500/80">
                {batch.title_only} of these had no page text to read, so they were written from the title alone.
              </div>
            )}
            <div className="space-y-1.5 max-h-[45vh] overflow-y-auto scrollbar-matrix">
              {(batch.suggestions || []).map((s) => (
                <SuggestionRow key={s.id} s={s} checked={!!batch.checked[s.id]}
                  onToggle={() => setBatch((cur) => ({ ...cur, checked: { ...cur.checked, [s.id]: !cur.checked[s.id] } }))} />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Btn kind="primary" onClick={applyBatch} disabled={applying}>
                {applying ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                APPLY {(batch.suggestions || []).filter((s) => batch.checked[s.id]).length}
              </Btn>
              <Btn onClick={() => setBatch(null)}><X size={12} /> Cancel</Btn>
            </div>
          </div>
        )}

        {loading && items == null && (
          <div className="flex items-center gap-2 text-ink-strong text-xs py-3"><Loader2 size={13} className="animate-spin" /> Reading your site…</div>
        )}
        {!loading && items && items.length === 0 && <div className="text-[11px] text-ink-max py-3">No pages, posts or products found.</div>}

        <div className="space-y-1.5">
          {(items || []).map((it) => {
            const issues = issuesById[it.id] || [];
            const worst = issues.some((i) => i.severity === 'high') ? 'high' : issues.some((i) => i.severity === 'medium') ? 'medium' : issues.length ? 'low' : null;
            const badge = worst === 'high' ? 'text-red-400 border-red-500/40' : worst === 'medium' ? 'text-yellow-500/80 border-yellow-500/40' : 'text-primary/50 border-primary/25';
            return (
              <button key={it.id} onClick={() => openItem(it)}
                className="w-full text-left border border-primary/15 hover:border-primary/40 transition-colors px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] text-ink-strong truncate">{it.title || '(untitled)'}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    {worst && <span className={`text-[9px] uppercase px-1.5 py-0.5 border ${badge}`}>{issues.length}</span>}
                    {it.noindex && <span className="text-[9px] uppercase px-1.5 py-0.5 border border-yellow-500/40 text-yellow-500/80">noindex</span>}
                    <span className={`text-[9px] uppercase px-1.5 py-0.5 border ${it.status === 'publish' ? 'text-primary border-primary/50' : 'text-yellow-500/80 border-yellow-500/40'}`}>
                      {it.status === 'publish' ? 'live' : it.status}
                    </span>
                  </span>
                </div>
                <div className="text-[10px] text-ink-max mt-0.5 truncate">{it.effective_title}</div>
                <div className="text-[9px] mt-0.5 flex items-center gap-2">
                  {/* "from default" is a third state: the page HAS a title in
                      search results, it just isn't one anybody wrote on the
                      item — saying "no SEO title" there would be false. */}
                  <span className={it.seo_title ? 'text-ink-max' : it.inherited_title ? 'text-ink-max' : 'text-yellow-500/70'}>
                    {it.seo_title ? 'title set' : it.inherited_title ? 'title from default' : 'no SEO title'}
                  </span>
                  <span className={it.seo_description ? 'text-ink-max' : it.inherited_description ? 'text-ink-max' : 'text-yellow-500/70'}>
                    {it.seo_description ? 'description set' : it.inherited_description ? 'description from default' : 'no description'}
                  </span>
                  {it.type && <span className="text-primary/25 uppercase">{it.type}</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
