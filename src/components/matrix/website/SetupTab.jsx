import { useState } from 'react';
import { Loader2, Plug, Check, Download, ExternalLink } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// SETUP tab of the WEBSITE panel — install the Morpheus plugin on your
// WordPress site and connect this project to it. One connection per project
// (construct); it's private to your account. The plugin ZIP is served
// static from the app (packed on every build from wp-plugin/morpheus).

const PLUGIN_ZIP = '/morpheus-wordpress-plugin.zip';
const inputCls = 'w-full bg-black/30 border border-primary/20 px-2.5 h-[42px] text-[13px] text-primary focus:outline-none focus:border-primary/50';

function Step({ n, title, children }) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 w-6 h-6 rounded-full border border-primary/40 text-primary/70 text-[11px] flex items-center justify-center font-mono">{n}</div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="text-[12px] text-primary/85">{title}</div>
        {children}
      </div>
    </div>
  );
}

export default function SetupTab({ store, projectId, onChanged }) {
  const [siteUrl, setSiteUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [err, setErr] = useState(null);

  const connected = store?.connected;

  const connect = async () => {
    setConnecting(true); setErr(null);
    try {
      await base44.functions.invoke('connectWordPress', {
        projectId,
        siteUrl: siteUrl.trim(),
        webhookSecret: secret.trim(),
      });
      setSecret('');
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
        <p className="text-[11px] text-primary/45 leading-relaxed">
          Use the <span className="text-primary/70">Deploy</span> tab to ship code changes to the site, and the <span className="text-primary/70">Shop</span> tab to manage products. This connection is private to your account.
        </p>
        <button onClick={disconnect} className="text-[11px] text-primary/40 hover:text-red-400">Disconnect this site</button>
        {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}
      </div>
    );
  }

  return (
    <div className="p-4 space-y-5">
      <p className="text-[11px] text-primary/50 leading-relaxed">
        The Morpheus plugin lets this project control your WordPress site — deploy code and run your shop — from here. Install it once:
      </p>

      <div className="space-y-4">
        <Step n={1} title="Download the plugin">
          <a href={PLUGIN_ZIP} download
            className="inline-flex items-center gap-1.5 text-[11px] px-3 py-2 border border-primary/40 text-primary/80 hover:border-primary hover:text-primary">
            <Download size={12} /> morpheus-wordpress-plugin.zip
          </a>
        </Step>
        <Step n={2} title="Install it on WordPress">
          <div className="text-[10px] text-primary/45 leading-relaxed">
            wp-admin → Plugins → Add New → <span className="text-primary/60">Upload Plugin</span> → choose the zip → Install → Activate.
          </div>
        </Step>
        <Step n={3} title="Set a signing secret">
          <div className="text-[10px] text-primary/45 leading-relaxed">
            wp-admin → Settings → Morpheus → <span className="text-primary/60">Deploy secret</span>: paste any random string, 12+ characters. It’s the shared key that signs every request — store it somewhere safe.
          </div>
        </Step>
        <Step n={4} title="Connect this project">
          <div className="space-y-2 pt-1">
            <input className={inputCls} placeholder="https://yoursite.com" value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)} autoCapitalize="off" autoCorrect="off" />
            <input className={inputCls} type="password" placeholder="the same signing secret" value={secret}
              onChange={(e) => setSecret(e.target.value)} autoCapitalize="off" autoCorrect="off" />
            <button onClick={connect}
              disabled={connecting || !siteUrl.trim() || secret.trim().length < 12}
              className="w-full flex items-center justify-center gap-2 h-[44px] bg-primary text-black font-bold text-[13px] hover:bg-[#39ff14] disabled:opacity-40 transition-colors">
              {connecting ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
              {connecting ? 'CONNECTING…' : 'CONNECT'}
            </button>
          </div>
        </Step>
      </div>

      <div className="text-[10px] text-primary/40 leading-relaxed border-t border-primary/10 pt-3">
        For the Deploy tab you’ll also point the plugin at your site’s GitHub repo (Settings → Morpheus) and connect this project to the same repo via Share → Export to GitHub.
        <a href="https://wordpress.org/documentation/article/manage-plugins/#upload-via-wordpress-admin" target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 text-primary/55 hover:text-primary ml-1">install help <ExternalLink size={9} /></a>
      </div>

      {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}
    </div>
  );
}
