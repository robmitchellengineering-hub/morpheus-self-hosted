import { useState, useEffect, useCallback } from 'react';
import {
  Loader2, RefreshCw, ExternalLink, AlertTriangle, Check, ShieldCheck, Server, Package, Clock,
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
// a severity. Read-only by design — applying updates is not built yet.

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

/** One finding, rendered so the server's own source label is unmissable. */
function Finding({ t, quiet = false }) {
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
    </div>
  );
}

export default function HealthTab({ projectId }) {
  const [scan, setScan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const run = useCallback(async (force) => {
    // The previous scan stays on screen while this one runs. Blanking the tab
    // would hide exactly the findings the operator is reading.
    setLoading(true); setErr(null);
    try {
      const res = await base44.functions.invoke('siteHealth', { projectId, action: 'scan', force: !!force });
      if (!res?.data) throw new Error('The scan came back empty — try again.');
      setScan(res.data);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { run(false); }, [run]);

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
              ) : attention.map((t, i) => <Finding key={`${t.id}-${i}`} t={t} />)}
            </Section>

            {rest.length > 0 && (
              <div className="space-y-2">
                <button className={btn} onClick={() => setShowAll((v) => !v)}>
                  Everything else · {rest.length} {showAll ? 'HIDE' : 'SHOW'}
                </button>
                {showAll && rest.map((t, i) => <Finding key={`${t.id}-${i}`} t={t} quiet />)}
              </div>
            )}

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
                  {/* Applying updates is not built. One line saying so is honest;
                      a button that cannot work would be a dead end. */}
                  <div className={faint}>Applying these from Morpheus is coming next.</div>
                </div>
              )}
            </Section>

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
      </div>
    </div>
  );
}
