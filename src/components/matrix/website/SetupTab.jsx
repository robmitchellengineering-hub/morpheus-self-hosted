import { useEffect, useState } from 'react';
import {
  Loader2, Plug, Check, Download, ExternalLink, ArrowUpCircle, Globe, KeyRound,
  RefreshCw, ShieldCheck, Settings,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';

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

const PLUGIN_ZIP = '/morpheus-wordpress-plugin.zip';
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

  useEffect(() => {
    fetch(PLUGIN_MANIFEST).then((r) => (r.ok ? r.json() : null)).then((m) => setLatestVersion(m?.version || null)).catch(() => {});
  }, []);

  const connected = store?.connected;
  const updateAvailable = connected && store.online && isNewer(latestVersion, store.version);

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
                  Update it from WordPress itself: <span className="text-primary/70">wp-admin → Plugins</span> — the Morpheus row shows
                  “update now”. One tap, no zip, no upload, and the download is checksum-verified before it installs.
                </p>
                <OpenButton href={`${store.siteUrl?.replace(/\/+$/, '')}/wp-admin/plugins.php`} tone="primary">
                  <ArrowUpCircle size={12} /> Open your Plugins screen
                </OpenButton>
              </>
            ) : (
              <>
                <p className="text-[10px] text-primary/50 leading-relaxed">
                  This build ({store.version}) predates the update channel, so it has to be replaced by hand — once. After that,
                  WordPress updates it for you. Download the zip and re-upload it on WordPress — Plugins → Add New → Upload Plugin →
                  pick the zip → <span className="text-primary/70">Replace current with uploaded</span>.
                </p>
                <a href={PLUGIN_ZIP} download
                  className="inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 border border-yellow-500/50 text-yellow-500/90 hover:border-yellow-500 hover:text-yellow-400">
                  <Download size={12} /> morpheus-wordpress-plugin.zip
                </a>
              </>
            )}
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
          <div className="space-y-2">
            <div className="text-[10px] text-primary/50 leading-relaxed">
              {probe.is_wordpress
                ? 'Your site answered — WordPress is there, the Morpheus plugin is not (yet).'
                : 'That address answered, but not as a WordPress site Morpheus recognises.'}
            </div>
            <div className="text-[10px] text-primary/45 leading-relaxed">
              Download the plugin, then upload it: <span className="text-primary/65">Plugins → Add New → Upload Plugin → Install → Activate</span>.
            </div>
            <div className="flex flex-wrap gap-2">
              <a href={PLUGIN_ZIP} download
                className="inline-flex items-center gap-1.5 text-[11px] px-3 py-2 border border-primary/60 text-primary hover:border-primary">
                <Download size={12} /> Download the plugin
              </a>
              <OpenButton href={probe.install_url}>Upload it on your site</OpenButton>
            </div>
            <div className="text-[9px] text-primary/35 leading-relaxed">
              WordPress only lets an administrator install a plugin, so this one step is yours — it cannot be done from here.
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
