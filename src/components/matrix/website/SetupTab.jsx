import { useEffect, useState } from 'react';
import {
  Loader2, Plug, Check, Download, ExternalLink, ArrowUpCircle, Globe, KeyRound,
  RefreshCw, ShieldCheck, Settings, FolderPlus, Copy, Upload, UserCog,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import GithubGate from '@/components/matrix/GithubGate';

// SETUP tab of the WEBSITE panel — install the Morpheus plugin on your
// WordPress site and connect this project to it. One connection per project
// (construct); it's private to your account. The plugin ZIP is served static
// from the app (packed on every build from wp-plugin/morpheus).
//
// STEPPED ON PURPOSE. This used to show four instructions at once and then ask
// for a signing secret the operator had to invent and paste into two different
// screens — with a single "Connection failed" as the only feedback when
// anything was wrong. Now the panel asks one thing at a time, and the server
// looks at the site to decide what to ask next (probeWordPress): install the
// plugin, update it, or paste the one-time code from wp-admin. The wizard
// follows what the site actually says, not what the operator assumes.

// The plugin file. Two forms on purpose:
//   PLUGIN_ZIP     — same-origin, served by THIS build, so the download button
//                    always hands over the zip that matches the running app
//                    (including in development, where morpheus.nz is not this
//                    build);
//   PLUGIN_ZIP_URL — absolute, because a WP-CLI command and a message to
//                    someone else's developer travel off this page.
// One constant derives the other, so the two can never name different files.
const PLUGIN_ZIP = '/morpheus-wordpress-plugin.zip';
const PLUGIN_ZIP_URL = `https://morpheus.nz${PLUGIN_ZIP}`;
const PLUGIN_MANIFEST = '/plugin-manifest.json';

// The version that first registers WordPress's own update channel (0.5.3). A
// site on anything older cannot hear about an update except through this panel,
// so the two cases need different instructions — telling someone on 0.4.5 to
// "just use Update now" would be a dead end.
const UPDATE_CHANNEL_VERSION = '0.5.3';

// "0.4.10" > "0.4.9" — a plain string compare gets that wrong once any part
// hits double digits, so compare numerically part by part.
function isNewer(a, b) {
  if (!a || !b) return false;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da !== db) return da > db;
  }
  return false;
}
const inputCls = 'w-full bg-black/30 border border-primary/20 px-2.5 h-[42px] text-[13px] text-primary focus:outline-none focus:border-primary/50';

function Step({ n, title, children, done }) {
  return (
    <div className="flex gap-3">
      <div className={`shrink-0 w-6 h-6 rounded-full border text-[11px] flex items-center justify-center font-mono ${done ? 'border-primary bg-primary/15 text-primary' : 'border-primary/40 text-primary/70'}`}>
        {done ? <Check size={12} /> : n}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="text-[12px] text-primary/85">{title}</div>
        {children}
      </div>
    </div>
  );
}

/**
 * One line about what was copied. Deliberately mirrors server/src/lib/
 * siteWorkingCopy.js's describeWorkingCopy() so the panel and the API cannot
 * describe the same result differently.
 */
function copySummary({ files = 0, bytes = 0, reused = false, theme = {} } = {}) {
  const size = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const parts = [`${files} file${files === 1 ? '' : 's'} (${size})`];
  if (theme?.name) parts.push(theme.name);
  if (reused) parts.push('added to the repo you already had with that name');
  return parts.join(' · ');
}

/**
 * What the forced update check found, said plainly.
 *
 * Every branch ends in an action — a button, a link, or an exact instruction —
 * and the branch that matters most is the one where the site could not reach the
 * update server. Answering "no update available" to that question is what hid
 * this problem for hours: the operator pressed the only button there was, was
 * told nothing, and had no way to tell a current site from an unreachable one.
 */
function UpdateCheckReport({ upd, version, zipHref }) {
  if (upd.phase === 'busy') {
    return <div className="text-[10px] text-primary/50">Asking your site to re-read its update channel…</div>;
  }

  if (upd.phase === 'failed') {
    // The bootstrap case: a build that predates the route cannot be asked, so the
    // only thing that works is installing the zip once, by hand.
    const boot = upd.code === 'UPDATES_UNSUPPORTED';
    return (
      <div className="text-[10px] text-primary/60 leading-relaxed space-y-1">
        {boot ? (
          <p>
            v{version} cannot check for its updates yet. Install the current build once by hand — after that WordPress
            updates it for you: download the zip, then Plugins → Add New → Upload Plugin →{' '}
            <span className="text-primary/80">Replace current with uploaded</span>.
          </p>
        ) : (
          <p>{upd.message}</p>
        )}
        {!boot && <p className="text-primary/45">Nothing was changed. The zip always works.</p>}
      </div>
    );
  }

  const r = upd.report || {};
  const installed = r.installed || version;

  if (!r.reachable) {
    return (
      <div className="text-[10px] text-primary/60 leading-relaxed space-y-1">
        <p>
          This site could not read the published version list
          {r.reason ? <> — <span className="text-yellow-500/90">{r.reason}</span></> : '.'}
        </p>
        <p className="text-primary/45">
          That is a fact about this site&rsquo;s outbound requests, not about the update. The zip installs without them.
        </p>
      </div>
    );
  }

  const published = r.manifest?.version || '?';
  if (!r.newer_available) {
    return <div className="text-[10px] text-primary/60">Checked just now: v{installed} is the newest published version.</div>;
  }
  if (r.wordpress_shows) {
    return (
      <div className="text-[10px] text-primary/60 leading-relaxed">
        Checked just now: <span className="text-yellow-500/90">v{published}</span> is published and WordPress is
        offering it. Open your Plugins screen and tap <span className="text-primary/80">update now</span> — the download
        is checksum-verified before it installs.
      </div>
    );
  }
  return (
    <div className="text-[10px] text-primary/60 leading-relaxed">
      v{published} is published, but WordPress is still not offering it after a fresh check. Use{' '}
      <a href={zipHref} download className="text-primary/80 underline">the zip</a> once — that path cannot be cached.
    </div>
  );
}

/**
 * Copy-to-clipboard for a line the operator has to move somewhere else — a
 * terminal, or a message to whoever manages their site. Falls back to a
 * selectable block when the clipboard API is unavailable (it is blocked in
 * some in-app browsers, and a dead Copy button is worse than none).
 */
function CopyLine({ text, label, mono = true }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* the block below stays selectable */ }
  };
  return (
    <div className="space-y-1">
      {label && <div className="text-[9px] text-primary/40 uppercase tracking-wider">{label}</div>}
      <div className="flex items-stretch gap-1.5">
        <code className={`flex-1 bg-black/40 border border-primary/20 px-2 py-2 text-[10px] text-primary/80 break-all select-all ${mono ? 'font-mono' : ''}`}>
          {text}
        </code>
        <button onClick={copy} title="Copy"
          className="shrink-0 px-2 border border-primary/25 text-primary/60 hover:border-primary hover:text-primary flex items-center gap-1 text-[10px]">
          {copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
      </div>
    </div>
  );
}

/** The command for anyone whose host gives them a terminal. */
const WP_CLI_INSTALL = `wp plugin install ${PLUGIN_ZIP_URL} --activate`;

/**
 * A message the operator can send to whoever actually manages their site —
 * their developer, their agency, their host. Rob's own situation: the person
 * who wants the tool is often not the person with wp-admin.
 */
function handOffMessage({ siteUrl, installUrl, settingsUrl }) {
  return [
    'Hi — could you install a plugin on the WordPress site? It is the one that lets me manage the site myself.',
    '',
    `Plugin: ${PLUGIN_ZIP_URL}`,
    `Or with a terminal: ${WP_CLI_INSTALL}`,
    `Or by hand: ${installUrl || `${siteUrl}/wp-admin/plugin-install.php?tab=upload`}`,
    '  → Plugins → Add New → Upload Plugin → choose the .zip → Install → Activate',
    '',
    'Then open Settings → Morpheus on the site and read me the code it shows (it lasts 20 minutes).',
    `That page: ${settingsUrl || `${siteUrl}/wp-admin/options-general.php?page=morpheus`}`,
    '',
    'Nothing else is needed — no passwords, no FTP, and it does not touch the theme or your existing plugins.',
  ].join('\n');
}

/** Opens a wp-admin page on the operator's own site — one tap, no typing. */
function OpenButton({ href, children, tone = 'default' }) {
  const cls = tone === 'primary'
    ? 'border-primary/60 text-primary hover:border-primary'
    : 'border-primary/40 text-primary/80 hover:border-primary hover:text-primary';
  return (
    <a href={href} target="_blank" rel="noreferrer"
      className={`inline-flex items-center gap-1.5 text-[11px] px-3 py-2 border ${cls}`}>
      {children} <ExternalLink size={11} />
    </a>
  );
}

export default function SetupTab({ store, projectId, onChanged }) {
  const [siteUrl, setSiteUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [probe, setProbe] = useState(null);
  const [checking, setChecking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [err, setErr] = useState(null);
  const [latestVersion, setLatestVersion] = useState(null);
  const [manual, setManual] = useState(false); // "use a shared secret instead"
  const [downloaded, setDownloaded] = useState(false); // step 1 of the manual install
  const [handoffOpen, setHandoffOpen] = useState(false); // sending the steps to someone else
  const [copying, setCopying] = useState(false);
  const [copy, setCopy] = useState(null);      // the working-copy result
  const [repoName, setRepoName] = useState(''); // what the repo will be called
  // The force-check result. Kept separate from `err` because a check that cannot
  // reach morpheus.nz is an ANSWER about the site, not a failed action.
  const [upd, setUpd] = useState(null); // { phase: 'busy' | 'done' | 'failed', report, message, code }

  useEffect(() => {
    fetch(PLUGIN_MANIFEST).then((r) => (r.ok ? r.json() : null)).then((m) => setLatestVersion(m?.version || null)).catch(() => {});
  }, []);

  // The name comes from the server's own helper (repoNameForSite) so the panel
  // and the API can never propose different names.
  useEffect(() => {
    if (store?.suggested_repo_name) setRepoName(store.suggested_repo_name);
  }, [store?.suggested_repo_name]);

  const createWorkingCopy = async () => {
    setCopying(true); setErr(null); setCopy(null);
    try {
      const { data } = await base44.functions.invoke('createSiteWorkingCopy', {
        projectId,
        repoName: repoName.trim() || undefined,
      });
      setCopy(data);
    } catch (e) {
      setErr(e?.data?.error || e.message);
    } finally { setCopying(false); }
  };

  const connected = store?.connected;
  const updateAvailable = connected && store.online && isNewer(latestVersion, store.version);

  /**
   * Ask the SITE to re-read its own update channel, then report what it found.
   *
   * WordPress's own "Check again" cannot do this: the plugin caches the
   * published manifest, and that button re-runs the check against the same
   * cached answer — so a site whose cache predates a release is told there is
   * nothing to update, with no way to find out why. This clears both caches
   * (the plugin's and WordPress's) and re-reads.
   *
   * A check that cannot reach the update server comes back with a REASON, and a
   * build too old to have the route comes back as UPDATES_UNSUPPORTED — both are
   * rendered as information with the one action that works, never as a dead end.
   */
  const checkForUpdates = async () => {
    setUpd({ phase: 'busy' });
    try {
      const { data } = await base44.functions.invoke('siteHealth', { projectId, action: 'updates' });
      setUpd({ phase: 'done', report: data?.updates || null });
      const found = data?.updates?.manifest?.version || null;
      if (found) setLatestVersion((v) => (isNewer(found, v) ? found : v));
    } catch (e) {
      setUpd({ phase: 'failed', message: e?.data?.error || e.message, code: e?.data?.code || null });
    }
  };

  const check = async () => {
    setChecking(true); setErr(null); setProbe(null);
    try {
      const { data } = await base44.functions.invoke('probeWordPress', { siteUrl: siteUrl.trim() });
      setProbe(data);
    } catch (e) {
      setErr(e?.data?.error || e.message);
    } finally { setChecking(false); }
  };

  const connect = async () => {
    setConnecting(true); setErr(null);
    try {
      await base44.functions.invoke('connectWordPress', {
        projectId,
        siteUrl: (probe?.siteUrl || siteUrl).trim(),
        // One of these is set, never both: the code path is the friendly one.
        pairingCode: manual ? undefined : code.trim(),
        webhookSecret: manual ? secret.trim() : undefined,
      });
      setSecret(''); setCode('');
      onChanged?.();
    } catch (e) {
      setErr(e?.data?.error || e.message);
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    setErr(null);
    try {
      await base44.functions.invoke('disconnectWordPress', { projectId });
      setProbe(null);
      onChanged?.();
    } catch (e) { setErr(e?.data?.error || e.message); }
  };

  if (connected) {
    return (
      <div className="p-4 space-y-4">
        <div className="border border-primary/30 px-3 py-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-primary text-[12px]"><Check size={13} /> Connected</div>
          <div className="text-[11px] text-primary/60 break-all">{store.siteUrl?.replace(/^https?:\/\//, '')}</div>
          <div className="text-[10px] text-primary/40">
            {store.online ? `plugin v${store.version}` : 'plugin unreachable'}
            {store.woocommerce ? ` · WooCommerce ${store.woocommerce}` : store.store_available === false ? ' · WooCommerce not active' : ''}
          </div>
        </div>
        {updateAvailable && (
          <div className="border border-yellow-500/35 bg-yellow-500/5 px-3 py-2.5 space-y-2">
            <div className="flex items-center gap-1.5 text-yellow-500/90 text-[11px]">
              <ArrowUpCircle size={13} /> Plugin update available — v{store.version} running, v{latestVersion} out
            </div>
            {isNewer(store.version, UPDATE_CHANNEL_VERSION) ? (
              <>
                <p className="text-[10px] text-primary/50 leading-relaxed">
                  WordPress offers this itself once your site has checked. If the Plugins screen shows nothing, that is
                  usually a cached answer rather than a missing update — ask the site to re-read it.
                </p>
                <button type="button" onClick={checkForUpdates} disabled={upd?.phase === 'busy'}
                  className="inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 border border-yellow-500/50 text-yellow-500/90 hover:border-yellow-500 hover:text-yellow-400 disabled:opacity-40">
                  {upd?.phase === 'busy' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  {upd?.phase === 'busy' ? 'Asking your site…' : 'CHECK FOR UPDATES'}
                </button>
              </>
            ) : (
              <>
                <p className="text-[10px] text-primary/50 leading-relaxed">
                  This build ({store.version}) predates the update channel, so it has to be replaced by hand — once. After that,
                  WordPress updates it for you. Download the zip and re-upload it on WordPress — Plugins → Add New → Upload Plugin →
                  pick the zip → <span className="text-primary/70">Replace current with uploaded</span>.
                </p>
              </>
            )}
            {/* Always offered, whatever the check says: this is the one path a
                cache or a blocked outbound request cannot take away. */}
            <div className="flex flex-wrap items-center gap-2">
              <a href={PLUGIN_ZIP} download
                className="inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 border border-primary/30 text-primary/80 hover:border-primary/60">
                <Download size={12} /> morpheus-wordpress-plugin.zip
              </a>
              {isNewer(store.version, UPDATE_CHANNEL_VERSION) && (
                <OpenButton href={`${store.siteUrl?.replace(/\/+$/, '')}/wp-admin/plugins.php`} tone="primary">
                  <ArrowUpCircle size={12} /> Open your Plugins screen
                </OpenButton>
              )}
            </div>
            {upd && <UpdateCheckReport upd={upd} version={store.version} zipHref={PLUGIN_ZIP} />}
          </div>
        )}
        {/* The step that used to be a wall: Morpheus deploys through a GitHub
            repo, and a site that was never in one had nowhere to start. It needs
            a GitHub account first, so that is asked for HERE, as a step — the
            button used to fail with "GitHub not connected" and leave the
            operator to find the connection somewhere else. */}
        {!store?.existing_repo && !copy && (
          <Step n={2} title="Turn on code changes">
          <div className="space-y-2">
            <p className="text-[10px] text-primary/50 leading-relaxed">
              Morpheus ships changes through a GitHub repo — it opens a pull request, checks run, and the plugin applies
              the merged commit. Your site's theme is not in one, so Morpheus can make you a private one to work from.
              Deploy, Code and the AI build loop all start working after this.
            </p>
            <GithubGate showSignup note="Morpheus creates the working copy as a private repo in your own GitHub account.">
            <div className="space-y-1">
              <div className="text-[9px] text-primary/40 uppercase tracking-wider">Repository name</div>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-primary/40 shrink-0">{store?.github_login ? `${store.github_login}/` : ''}</span>
                <input className="flex-1 bg-black/30 border border-primary/20 px-2 h-[36px] text-[12px] text-primary font-mono focus:outline-none focus:border-primary/50"
                  value={repoName} onChange={(e) => setRepoName(e.target.value)}
                  autoCapitalize="off" autoCorrect="off" spellCheck={false} />
              </div>
            </div>
            <button onClick={createWorkingCopy} disabled={copying || !repoName.trim()}
              className="w-full flex items-center justify-center gap-2 h-[42px] bg-primary text-black font-bold text-[12px] hover:bg-[#39ff14] disabled:opacity-40 transition-colors">
              {copying ? <Loader2 size={13} className="animate-spin" /> : <FolderPlus size={13} />}
              {copying ? 'COPYING YOUR THEME…' : `CREATE ${repoName.trim() || 'MY WORKING COPY'}`}
            </button>
            <div className="text-[9px] text-primary/35 leading-relaxed">
              Copies the active theme's code only — never WordPress core, other plugins, or your media. Nothing on your
              site changes.
            </div>
            </GithubGate>
          </div>
          </Step>
        )}

        {copy && (
          <div className="border border-primary/40 bg-primary/5 px-3 py-2.5 space-y-1.5">
            <div className="flex items-center gap-1.5 text-primary text-[12px]"><Check size={13} /> Working copy created</div>
            <a href={copy.url} target="_blank" rel="noreferrer"
              className="text-[10px] text-primary/70 hover:text-primary inline-flex items-center gap-1 break-all">
              <ExternalLink size={10} /> {copy.repo}
            </a>
            <div className="text-[10px] text-primary/55 leading-relaxed">{copySummary(copy)}</div>
            {copy.theme?.is_child && (
              <div className="text-[9px] text-primary/40">
                Child theme copied; its parent ({copy.theme.parent_slug}) is a third-party theme Morpheus leaves alone.
              </div>
            )}
            {copy.skipped_count > 0 && (
              <div className="text-[9px] text-primary/40">
                {copy.skipped_count} image{copy.skipped_count === 1 ? '' : 's'}, font{''} or large file{copy.skipped_count === 1 ? '' : 's'} stayed
                on your site — Morpheus manages code, and WordPress keeps serving those.
              </div>
            )}
            {copy.truncated && (
              <div className="text-[9px] text-yellow-500/80">
                The theme was larger than one copy — the rest is still on your site. Deploy still works for the files that came across.
              </div>
            )}
            <div className="text-[9px] text-primary/40">{copy.next}</div>
          </div>
        )}

        <p className="text-[11px] text-primary/45 leading-relaxed">
          Use the <span className="text-primary/70">Deploy</span> tab to ship code changes to the site, and the{' '}
          <span className="text-primary/70">Shop</span>, <span className="text-primary/70">Pages</span> and{' '}
          <span className="text-primary/70">SEO</span> tabs to run it. This connection is private to your account.
        </p>
        <button onClick={disconnect} className="text-[11px] text-primary/40 hover:text-red-400">Disconnect this site</button>
        {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}
      </div>
    );
  }

  // ── the wizard ────────────────────────────────────────────────────────────
  const step = probe?.step;

  return (
    <div className="p-4 space-y-5">
      <p className="text-[11px] text-primary/50 leading-relaxed">
        Connect this project to your WordPress site. The Morpheus plugin is what lets Morpheus deploy code, run your shop,
        manage content and own your SEO — you install it once, and after that WordPress keeps it up to date.
      </p>

      {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}

      <Step n={1} title="Your site address" done={!!step && step !== 'unreachable'}>
        <div className="space-y-2">
          <input className={inputCls} placeholder="yoursite.com" value={siteUrl}
            inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onChange={(e) => { setSiteUrl(e.target.value); setProbe(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && siteUrl.trim()) check(); }} />
          <button onClick={check} disabled={checking || !siteUrl.trim()}
            className="w-full flex items-center justify-center gap-2 h-[42px] border border-primary/50 text-primary text-[12px] hover:border-primary disabled:opacity-40">
            {checking ? <Loader2 size={13} className="animate-spin" /> : <Globe size={13} />}
            {checking ? 'LOOKING AT YOUR SITE…' : 'CHECK MY SITE'}
          </button>
        </div>
      </Step>

      {step === 'unreachable' && (
        <div className="border border-red-500/30 px-3 py-2.5 space-y-1">
          <div className="text-[11px] text-red-400">Nothing answered at {probe.siteUrl}</div>
          <div className="text-[10px] text-primary/50 leading-relaxed">{probe.guidance}</div>
          {probe.detail && <div className="text-[9px] text-primary/35">{probe.detail}</div>}
        </div>
      )}

      {step === 'behind_login' && (
        <div className="border border-yellow-500/35 bg-yellow-500/5 px-3 py-2.5 space-y-1.5">
          <div className="text-[11px] text-yellow-500/90">Your site is protected</div>
          <div className="text-[10px] text-primary/55 leading-relaxed">{probe.guidance}</div>
          {probe.login_url && <div className="text-[9px] text-primary/35 break-all">landed on {probe.login_url}</div>}
          <button onClick={check} disabled={checking}
            className="inline-flex items-center gap-1.5 text-[11px] px-3 py-2 border border-yellow-500/50 text-yellow-500/90 hover:border-yellow-500 disabled:opacity-40">
            {checking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} CHECK AGAIN
          </button>
        </div>
      )}

      {step === 'install' && (
        <Step n={2} title="Install the Morpheus plugin">
          <div className="space-y-3">
            <div className="text-[10px] text-primary/50 leading-relaxed">
              {probe.is_wordpress
                ? 'Your site answered — WordPress is there, the Morpheus plugin is not (yet).'
                : 'That address answered, but not as a WordPress site Morpheus recognises.'}
            </div>

            {/* WordPress will not let anything install a plugin without an
                administrator, and Morpheus will never ask for a WordPress
                password. So the honest goal is: one step for whoever CAN do it. */}
            {!handoffOpen ? (
              <>
                <div className="space-y-2">
                  <div className="text-[9px] text-primary/40 uppercase tracking-wider">Two taps</div>
                  <div className="flex flex-wrap gap-2">
                    <a href={PLUGIN_ZIP} download onClick={() => setDownloaded(true)}
                      className={`inline-flex items-center gap-1.5 text-[11px] px-3 py-2 border ${downloaded ? 'border-primary/30 text-primary/50' : 'border-primary/60 text-primary hover:border-primary'}`}>
                      {downloaded ? <Check size={12} /> : <Download size={12} />} {downloaded ? '1. Downloaded' : '1. Download the plugin'}
                    </a>
                    <a href={probe.install_url} target="_blank" rel="noreferrer"
                      className={`inline-flex items-center gap-1.5 text-[11px] px-3 py-2 border ${downloaded ? 'border-primary bg-primary/10 text-primary' : 'border-primary/40 text-primary/80 hover:border-primary'}`}>
                      <Upload size={12} /> 2. Upload it on your site <ExternalLink size={11} />
                    </a>
                  </div>
                  <div className="text-[9px] text-primary/40 leading-relaxed">
                    In WordPress: <span className="text-primary/60">Plugins → Add New → Upload Plugin</span> → choose the .zip →
                    Install → <span className="text-primary/60">Activate</span>. The file is in your Downloads.
                  </div>
                </div>

                <div className="border-t border-primary/10 pt-2 space-y-1.5">
                  <div className="text-[9px] text-primary/40 uppercase tracking-wider">Or one command, if you have a terminal</div>
                  <CopyLine text={WP_CLI_INSTALL} />
                  <div className="text-[9px] text-primary/35 leading-relaxed">
                    Works with WP-CLI over SSH — one line, installed and activated.
                  </div>
                </div>

                <button onClick={() => setHandoffOpen(true)}
                  className="text-[10px] text-primary/50 hover:text-primary flex items-center gap-1.5">
                  <UserCog size={11} /> Someone else manages this site? Send them the steps
                </button>
              </>
            ) : (
              <div className="space-y-2 border border-primary/25 px-3 py-2.5">
                <div className="text-[10px] text-primary/70">Send this to whoever runs your site</div>
                <div className="text-[9px] text-primary/40 leading-relaxed">
                  Copy it into a message. It has everything they need — the file, the one-line command, and what to do after —
                  and it asks for no passwords.
                </div>
                <CopyLine label="The message" mono={false} text={handOffMessage({
                  siteUrl: probe.siteUrl || siteUrl,
                  installUrl: probe.install_url,
                  settingsUrl: `${probe.siteUrl || siteUrl}/wp-admin/options-general.php?page=morpheus`,
                })} />
                <button onClick={() => setHandoffOpen(false)} className="text-[10px] text-primary/45 hover:text-primary/80">back to installing it myself</button>
              </div>
            )}

            <div className="text-[9px] text-primary/35 leading-relaxed">
              WordPress only installs plugins for an administrator, and Morpheus never asks for your WordPress password — so this
              one action is the only part that cannot happen from here. It is once per site.
            </div>
            <button onClick={check} disabled={checking}
              className="inline-flex items-center gap-1.5 text-[11px] px-3 py-2 bg-primary text-black font-bold hover:bg-[#39ff14] disabled:opacity-40">
              {checking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} I'VE INSTALLED IT — CHECK AGAIN
            </button>
          </div>
        </Step>
      )}

      {step === 'update' && (
        <Step n={2} title="Update the Morpheus plugin">
          <div className="space-y-2">
            <div className="text-[10px] text-primary/50 leading-relaxed">
              Your site is running plugin v{probe.version}. Connecting with a code needs v0.5.4 or newer.
            </div>
            {probe.self_update ? (
              <>
                <div className="text-[10px] text-primary/45 leading-relaxed">
                  Your build can update itself: open your Plugins screen and tap <span className="text-primary/65">update now</span> on
                  the Morpheus row. No zip, nothing to upload.
                </div>
                <OpenButton href={probe.plugins_url} tone="primary"><ArrowUpCircle size={12} /> Open your Plugins screen</OpenButton>
              </>
            ) : (
              <>
                <div className="text-[10px] text-primary/45 leading-relaxed">
                  This build is too old to update itself, so upload the current zip once — after that WordPress updates it for you:
                  Plugins → Add New → Upload Plugin → pick the zip → <span className="text-primary/65">Replace current with uploaded</span>.
                </div>
                <div className="flex flex-wrap gap-2">
                  <a href={PLUGIN_ZIP} download
                    className="inline-flex items-center gap-1.5 text-[11px] px-3 py-2 border border-primary/60 text-primary hover:border-primary">
                    <Download size={12} /> morpheus-wordpress-plugin.zip
                  </a>
                  <OpenButton href={probe.install_url}>Upload it on your site</OpenButton>
                </div>
              </>
            )}
            <button onClick={check} disabled={checking}
              className="inline-flex items-center gap-1.5 text-[11px] px-3 py-2 bg-primary text-black font-bold hover:bg-[#39ff14] disabled:opacity-40">
              {checking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} UPDATED — CHECK AGAIN
            </button>
          </div>
        </Step>
      )}

      {step === 'pair' && (
        <>
          <Step n={2} title="Get your code from WordPress" done>
            <div className="space-y-2">
              <div className="text-[10px] text-primary/50 leading-relaxed">{probe.guidance}</div>
              <OpenButton href={probe.settings_url} tone="primary">
                <Settings size={12} /> Open Settings → Morpheus
              </OpenButton>
              <div className="text-[9px] text-primary/35 leading-relaxed">
                The code is on that screen, valid for 20 minutes and usable once. Nothing is copied from here into WordPress —
                the plugin makes the secret itself.
              </div>
            </div>
          </Step>

          <Step n={3} title="Paste the code here" done={false}>
            <div className="space-y-2">
              <input
                className={`${inputCls} text-center font-mono text-[18px] tracking-[6px] uppercase`}
                placeholder="XXXX-XXXX" value={code} inputMode="text"
                autoCapitalize="characters" autoCorrect="off" spellCheck={false} maxLength={12}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) connect(); }} />
              <button onClick={connect} disabled={connecting || !code.trim()}
                className="w-full flex items-center justify-center gap-2 h-[46px] bg-primary text-black font-bold text-[13px] hover:bg-[#39ff14] disabled:opacity-40 transition-colors">
                {connecting ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
                {connecting ? 'CONNECTING…' : 'CONNECT'}
              </button>
              <div className="text-[9px] text-primary/35 flex items-start gap-1">
                <ShieldCheck size={10} className="mt-[1px] shrink-0" />
                <span>
                  Exchanging the code sets a shared secret on both sides, used to sign every request. Over https only —
                  the secret is never shown to you or typed by you.
                </span>
              </div>
            </div>
          </Step>
        </>
      )}

      {/* Escape hatch: an older plugin, or a secret already set by hand. */}
      {step === 'pair' && (
        <div className="border-t border-primary/10 pt-3">
          {!manual ? (
            <button onClick={() => setManual(true)} className="text-[10px] text-primary/45 hover:text-primary/80 flex items-center gap-1">
              <KeyRound size={10} /> Use a shared secret instead (older plugin, or a secret already set)
            </button>
          ) : (
            <div className="space-y-2">
              <div className="text-[10px] text-primary/45">Set the same secret in the plugin (Settings → Morpheus → Shared secret) and paste it here.</div>
              <input className={inputCls} type="password" placeholder="shared secret" value={secret}
                autoCapitalize="off" autoCorrect="off"
                onChange={(e) => setSecret(e.target.value)} />
              <button onClick={connect} disabled={connecting || secret.trim().length < 12}
                className="w-full flex items-center justify-center gap-2 h-[42px] border border-primary/50 text-primary text-[12px] hover:border-primary disabled:opacity-40">
                {connecting ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />} CONNECT WITH SECRET
              </button>
              <button onClick={() => setManual(false)} className="text-[10px] text-primary/45 hover:text-primary/80">back to the code</button>
            </div>
          )}
        </div>
      )}

      {!probe && (
        <div className="text-[10px] text-primary/40 leading-relaxed border-t border-primary/10 pt-3">
          Nothing is stored on Morpheus until a connection succeeds. You can disconnect at any time, and removing the plugin
          from WordPress leaves your site's files alone.
        </div>
      )}
    </div>
  );
}
