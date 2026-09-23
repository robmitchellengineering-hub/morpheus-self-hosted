import { useState, useEffect } from 'react';
import { X, Sliders, Save, Loader2, Check } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Distro customisation UI for the Raspberry Pi distro target. Settings are
// saved to a `morpheus-distro.json` file in the project tree; the rpi-distro
// compile target reads that file at build time and applies them to the pi-gen
// image (hostname, timezone, locale, SSH key, first-user password, extra
// packages, custom commands) — so users can customise the image without
// hand-editing pi-gen stage files.
//
// Inputs are validated against known-good lists (not just format) so mistakes
// surface here, not after a ~10-minute pi-gen build.

const RE_HOSTNAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RE_PKG = /^[a-z0-9][a-z0-9.+-]*$/;
const RE_PASS = /^[A-Za-z0-9]{1,40}$/;

// Curated lists validated against the tz database / common glibc locales.
// Restricting to these guarantees the value actually exists in the image, so a
// typo can't create a dangling symlink or fail locale-gen mid-build.
const COMMON_TIMEZONES = [
  'UTC',
  'Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Perth', 'Australia/Adelaide', 'Australia/Hobart', 'Australia/Darwin',
  'Pacific/Auckland', 'Pacific/Honolulu',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Vancouver', 'America/Sao_Paulo', 'America/Mexico_City', 'America/Buenos_Aires', 'America/Bogota', 'America/Lima', 'America/Santiago',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Brussels', 'Europe/Stockholm', 'Europe/Oslo', 'Europe/Copenhagen', 'Europe/Helsinki', 'Europe/Warsaw', 'Europe/Athens', 'Europe/Lisbon', 'Europe/Dublin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/Moscow', 'Europe/Istanbul',
  'Asia/Tokyo', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Seoul', 'Asia/Bangkok', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Jakarta', 'Asia/Manila', 'Asia/Kuala_Lumpur', 'Asia/Taipei', 'Asia/Ho_Chi_Minh', 'Asia/Tehran', 'Asia/Karachi', 'Asia/Dhaka',
  'Africa/Johannesburg', 'Africa/Cairo', 'Africa/Lagos', 'Africa/Nairobi',
];

const COMMON_LOCALES = [
  'en_AU.UTF-8', 'en_US.UTF-8', 'en_GB.UTF-8', 'en_CA.UTF-8', 'en_NZ.UTF-8', 'en_IE.UTF-8', 'en_ZA.UTF-8', 'en_IN.UTF-8', 'en_SG.UTF-8', 'en_PH.UTF-8', 'en_HK.UTF-8',
  'de_DE.UTF-8', 'de_AT.UTF-8', 'de_CH.UTF-8',
  'fr_FR.UTF-8', 'fr_CA.UTF-8', 'fr_BE.UTF-8',
  'es_ES.UTF-8', 'es_MX.UTF-8', 'es_AR.UTF-8',
  'it_IT.UTF-8', 'nl_NL.UTF-8', 'pt_BR.UTF-8', 'pt_PT.UTF-8', 'ru_RU.UTF-8', 'pl_PL.UTF-8', 'sv_SE.UTF-8', 'da_DK.UTF-8', 'fi_FI.UTF-8', 'nb_NO.UTF-8',
  'ja_JP.UTF-8', 'ko_KR.UTF-8', 'zh_CN.UTF-8', 'zh_HK.UTF-8', 'zh_TW.UTF-8', 'th_TH.UTF-8', 'vi_VN.UTF-8', 'id_ID.UTF-8', 'ms_MY.UTF-8', 'tr_TR.UTF-8', 'el_GR.UTF-8', 'cs_CZ.UTF-8', 'he_IL.UTF-8', 'ar_SA.UTF-8',
];

export default function DistroConfigDialog({ open, onClose, projectId }) {
  const [hostname, setHostname] = useState('');
  const [timezone, setTimezone] = useState('');
  const [locale, setLocale] = useState('');
  const [firstUserPass, setFirstUserPass] = useState('morpheus');
  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [wifiCountry, setWifiCountry] = useState('');
  const [sshEnabled, setSshEnabled] = useState(true);
  const [sshPublicKey, setSshPublicKey] = useState('');
  const [extraPackages, setExtraPackages] = useState('');
  const [extraRunCommands, setExtraRunCommands] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [existingId, setExistingId] = useState(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    base44.entities.ProjectFile.filter({ project_id: projectId })
      .then(files => {
        if (cancelled) return;
        const f = files.find(x => x.path === 'morpheus-distro.json');
        if (f) {
          setExistingId(f.id);
          try {
            const cfg = JSON.parse(f.content || '{}');
            setHostname(cfg.hostname || '');
            setTimezone(cfg.timezone || '');
            setLocale(cfg.locale || '');
            setFirstUserPass(cfg.firstUserPass || 'morpheus');
            setWifiSsid(cfg.wifiSsid || '');
            setWifiPassword(cfg.wifiPassword || '');
            setWifiCountry(cfg.wifiCountry || '');
            setSshEnabled(cfg.sshEnabled !== false);
            setSshPublicKey(cfg.sshPublicKey || '');
            setExtraPackages(Array.isArray(cfg.extraPackages) ? cfg.extraPackages.join(', ') : '');
            setExtraRunCommands(Array.isArray(cfg.extraRunCommands) ? cfg.extraRunCommands.join('\n') : '');
          } catch {}
        }
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [open, projectId]);

  if (!open) return null;

  const pkgTokens = extraPackages.split(',').map(s => s.trim()).filter(Boolean);
  const errors = {};
  if (hostname && !RE_HOSTNAME.test(hostname)) errors.hostname = 'lowercase letters, digits, hyphens only; max 63 chars';
  if (timezone && !COMMON_TIMEZONES.includes(timezone)) errors.timezone = 'unknown timezone — choose a value from the list';
  if (locale && !COMMON_LOCALES.includes(locale)) errors.locale = 'unknown locale — choose a value from the list';
  if (!firstUserPass || !RE_PASS.test(firstUserPass)) errors.firstUserPass = 'letters and digits only; 1–40 chars (needed for a shell-safe pi-gen config)';
  if (wifiCountry && !/^[A-Z]{2}$/.test(wifiCountry)) errors.wifiCountry = '2-letter country code (e.g. AU)';
  if (wifiSsid && wifiPassword && (wifiPassword.length < 8 || wifiPassword.length > 63)) errors.wifiPassword = 'WPA password must be 8–63 chars (leave empty for an open network)';
  if (sshPublicKey && !/^(ssh-rsa|ssh-ed25519|ssh-dss|ecdsa-|sk-)/.test(sshPublicKey)) errors.sshPublicKey = 'must start with ssh-rsa / ssh-ed25519 / ecdsa- / sk-';
  if (pkgTokens.some(p => !RE_PKG.test(p))) errors.extraPackages = 'one or more package names look invalid (lowercase, digits, . + -)';
  const hasErrors = Object.keys(errors).length > 0;

  const handleSave = async () => {
    if (hasErrors) return;
    setSaving(true);
    try {
      const cfg = {
        hostname: hostname.trim(),
        timezone: timezone.trim(),
        locale: locale.trim(),
        firstUserPass: firstUserPass.trim(),
        wifiSsid: wifiSsid.trim(),
        wifiPassword: wifiPassword,
        wifiCountry: wifiCountry.trim().toUpperCase(),
        sshEnabled,
        sshPublicKey: sshPublicKey.trim(),
        extraPackages: pkgTokens,
        extraRunCommands: extraRunCommands.split('\n').map(s => s.trim()).filter(Boolean),
      };
      const content = JSON.stringify(cfg, null, 2);
      if (existingId) {
        await base44.entities.ProjectFile.update(existingId, { content });
      } else {
        const created = await base44.entities.ProjectFile.create({ project_id: projectId, path: 'morpheus-distro.json', content, language: 'json' });
        setExistingId(created.id);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const errClass = 'text-[10px] text-red-500 mt-1';
  const inputClass = 'w-full bg-background text-primary border border-primary/30 px-2.5 py-2 text-sm outline-none placeholder:text-primary/20';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto scrollbar-matrix border border-primary/40 bg-background shadow-[0_0_20px_rgba(0,255,65,0.2)]">
        <div className="flex items-center justify-between border-b border-primary/20 px-4 py-3 sticky top-0 bg-background">
          <div className="flex items-center gap-2">
            <Sliders size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider neon-glow">DISTRO CONFIG</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>
        <div className="p-4 space-y-4">
          <p className="text-xs text-ink-strong">
            // Customise the bootable image. Settings are saved to <span className="text-ink-strong">morpheus-distro.json</span> in your
            project and applied at build time — no manual pi-gen stage files needed.
          </p>
          <p className="text-[10px] text-ink-max border border-primary/20 bg-primary/5 p-2">
            // Default user: <span className="text-ink-max">pi</span>. Set a password below; if you add an SSH key, password login is
            automatically disabled for security (key-only).
          </p>
          {loading ? (
            <div className="flex items-center gap-2 text-ink text-sm"><Loader2 size={14} className="animate-spin" /> Loading config...</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div className="col-span-2">
                  <label className="block text-[10px] text-primary/60 uppercase tracking-wider mb-1">Hostname</label>
                  <input value={hostname} onChange={e => setHostname(e.target.value)} placeholder="morpheus" className={inputClass} />
                  {errors.hostname && <p className={errClass}>// {errors.hostname}</p>}
                </div>
                <div>
                  <label className="block text-[10px] text-primary/60 uppercase tracking-wider mb-1">Timezone</label>
                  <input list="tz-list" value={timezone} onChange={e => setTimezone(e.target.value)} placeholder="Australia/Sydney" className={inputClass} />
                  <datalist id="tz-list">{COMMON_TIMEZONES.map(tz => <option key={tz} value={tz} />)}</datalist>
                  {errors.timezone && <p className={errClass}>// {errors.timezone}</p>}
                </div>
                <div>
                  <label className="block text-[10px] text-primary/60 uppercase tracking-wider mb-1">Locale</label>
                  <input list="locale-list" value={locale} onChange={e => setLocale(e.target.value)} placeholder="en_AU.UTF-8" className={inputClass} />
                  <datalist id="locale-list">{COMMON_LOCALES.map(l => <option key={l} value={l} />)}</datalist>
                  {errors.locale && <p className={errClass}>// {errors.locale}</p>}
                </div>
              </div>

              <div>
                <label className="block text-[10px] text-primary/60 uppercase tracking-wider mb-1">First user password (user: `pi`)</label>
                <input value={firstUserPass} onChange={e => setFirstUserPass(e.target.value)} placeholder="morpheus" className={inputClass} />
                {errors.firstUserPass && <p className={errClass}>// {errors.firstUserPass}</p>}
              </div>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={sshEnabled} onChange={e => setSshEnabled(e.target.checked)} className="accent-primary w-4 h-4" />
                <span className="text-xs text-ink-strong">Enable SSH on first boot</span>
              </label>

              <div>
                <label className="block text-[10px] text-primary/60 uppercase tracking-wider mb-1">SSH public key (injected into the `pi` user; disables password login)</label>
                <textarea value={sshPublicKey} onChange={e => setSshPublicKey(e.target.value)} rows={2} placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI..." className="w-full bg-background text-ink-strong border border-primary/30 px-2.5 py-2 text-xs outline-none placeholder:text-ink-strong resize-y" />
                {errors.sshPublicKey && <p className={errClass}>// {errors.sshPublicKey}</p>}
              </div>

              <div className="border border-primary/20 p-3 space-y-2">
                <div className="text-[10px] text-primary/70 uppercase tracking-wider">WiFi (headless first-boot networking)</div>
                <input value={wifiSsid} onChange={e => setWifiSsid(e.target.value)} placeholder="SSID (network name)" className={inputClass} />
                <input value={wifiPassword} onChange={e => setWifiPassword(e.target.value)} type="text" placeholder="PSK password (leave empty for open network)" className={inputClass} />
                <input value={wifiCountry} onChange={e => setWifiCountry(e.target.value.toUpperCase())} placeholder="Country code (e.g. AU)" className={inputClass} />
                {errors.wifiCountry && <p className={errClass}>// {errors.wifiCountry}</p>}
                {errors.wifiPassword && <p className={errClass}>// {errors.wifiPassword}</p>}
                <p className="text-[10px] text-ink-max">// Bakes wpa_supplicant.conf into the boot partition so the Pi joins WiFi on first boot.</p>
              </div>

              <div>
                <label className="block text-[10px] text-primary/60 uppercase tracking-wider mb-1">Extra apt packages (comma-separated)</label>
                <input value={extraPackages} onChange={e => setExtraPackages(e.target.value)} placeholder="vim, git, htop, i2c-tools" className={inputClass} />
                {errors.extraPackages && <p className={errClass}>// {errors.extraPackages}</p>}
              </div>

              <div>
                <label className="block text-[10px] text-primary/60 uppercase tracking-wider mb-1">Custom run commands (one per line, run inside the image at build time)</label>
                <textarea value={extraRunCommands} onChange={e => setExtraRunCommands(e.target.value)} rows={3} placeholder="echo built-by-morpheus > /etc/morpheus-build" className="w-full bg-background text-ink-strong border border-primary/30 px-2.5 py-2 text-xs outline-none placeholder:text-ink-strong resize-y font-mono" />
                <p className="text-[10px] text-ink-max mt-1">// Advanced: arbitrary shell commands baked into the image. A failing line is logged but won't abort the build.</p>
              </div>

              <button onClick={handleSave} disabled={saving || hasErrors} className="flex items-center justify-center gap-2 w-full py-2.5 border border-primary text-primary hover:bg-primary hover:text-black transition-colors text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed">
                {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
                {saving ? 'SAVING' : saved ? 'SAVED' : hasErrors ? 'FIX ERRORS TO SAVE' : 'SAVE DISTRO CONFIG'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}