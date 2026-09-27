import { useState, useEffect, useCallback, useRef } from 'react';
import { Download, Check, XCircle, Loader2, Mail, Calendar, HardDrive, FileText, UploadCloud, DownloadCloud, AlertTriangle, Coins, X, ChevronUp, ChevronDown, Plug, Trash2 } from 'lucide-react';
import { usePwaInstall } from '@/hooks/usePwaInstall';
import { useDeckGoogleConnection } from '@/hooks/useDeckGoogleConnection';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { base44 } from '@/api/base44Client';
import { TOKEN_BLOCKS } from '@/lib/tokenBlocks';
import { startTokenCheckout } from '@/lib/purchaseCredits';
import { DECK_WIDGETS } from './deckWidgets';
import { C, money, DEFAULT_FEE_TIERS, formatFeeRate, parseFeeTierInput, feeTiersFromProfile, commissionFor, consignorProceeds, feeRateLabel } from './deckConstants';
import { Card, pillBtn, miniInput, MicField, MicTextarea } from './DeckUI';

// Install card, the Connections section (Google today, built to grow),
// Widgets (what shows on the Deck home tab, and in what order), Business
// profile (shapes Jarvis/Gmail-filter/brain-dump prompts instead of them
// hardcoding one account's business), Data vault status, and Usage.
// Turns checkDeckVault's reason code into something actionable. A stale
// timestamp looks healthy; that is exactly the failure this is meant to catch.
function vaultStatusMessage(s) {
  const age = s.ageDays;
  const stale = age != null ? ` Last backup was ${age} day${age === 1 ? '' : 's'} ago.` : '';
  switch (s.reason) {
    case 'ok':
      return `Vault reachable — backup file present in Drive.${stale}`;
    case 'folder-empty':
      return `Drive folder "${s.folderName}" is reachable but has no backup file in it yet.${stale}`;
    case 'folder-missing':
      return `Drive folder "${s.folderName}" no longer exists — the vault is gone. Back up again to recreate it.${stale}`;
    case 'folder-trashed':
      return `Drive folder "${s.folderName}" is in the Drive bin. Empty it there, or back up again to recreate it.${stale}`;
    case 'never-backed-up':
      return 'No vault yet — run a backup to create one.';
    case 'not-connected':
      return 'Google is not connected, so there is no vault to check.';
    case 'probe-failed':
      return `Couldn't check the vault: ${s.error || 'Drive returned an error.'}`;
    case 'unreachable':
      return `Vault unreachable: ${s.error || 'Drive could not be reached.'}${stale}`;
    default:
      return 'Vault status unknown.';
  }
}

export default function DeckSettings() {
  const { canInstall, installed, promptInstall } = usePwaInstall();
  const google = useDeckGoogleConnection();
  const {
    driveBackupBusy, driveBackupMsg, driveRestoreBusy, driveRestoreMsg, lastBackupAt,
    driveBackup, driveRestore,
    vaultStatus, vaultBusy, checkVault,
  } = useCommandDeck();
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const backupStamp = lastBackupAt || google.lastBackupAt;

  // Probe once per visit. The whole value of this check is noticing a vault
  // that has quietly become unreachable — nobody clicks a button they have no
  // reason to press.
  useEffect(() => {
    if (google.connected) checkVault();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [google.connected]);

  return (
    <>
      <Card title="Install" sub="Command Deck as its own app — its own icon, opens straight here.">
        {installed ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', color: C.sage, fontWeight: 600 }}>
            <Check size={16} /> Installed
          </div>
        ) : canInstall ? (
          <button onClick={promptInstall} style={{ ...pillBtn(C.brass), width: '100%', padding: '0.6rem', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}>
            <Download size={15} /> Install Command Deck
          </button>
        ) : (
          <p style={{ margin: 0, fontSize: '0.78rem', color: C.walnutSoft }}>
            Not available in this browser yet — on a phone, use "Add to Home Screen" from the browser menu instead.
          </p>
        )}
      </Card>

      <UsageMeter />

      <WidgetManager />

      <BusinessProfileForm />

      <Card title="Connections" sub="Accounts the Deck can draw from. Google today — more to come.">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }}>
          <Plug size={15} color={C.walnutSoft} />
          <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>Google</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
            {google.loading ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', color: C.walnutSoft }}>
                <Loader2 size={13} className="animate-spin" /> Checking…
              </span>
            ) : google.connected ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.78rem', color: C.sage, fontWeight: 600 }}>
                <Check size={14} /> Connected{google.email ? ` · ${google.email}` : ''}
              </span>
            ) : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.78rem', color: C.walnutSoft }}>
                <XCircle size={14} /> Not connected
              </span>
            )}
          </div>
          {google.connected ? (
            <button onClick={google.disconnect} style={{ ...pillBtn(C.oxblood) }}>Disconnect</button>
          ) : (
            <button onClick={google.connect} style={{ ...pillBtn(C.brass) }}>Connect Google</button>
          )}
        </div>

        {google.connected && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.8rem' }}>
            <ScopeRow icon={Mail} label="Gmail" sub="Sync into the Inbox card, draft & send replies." active />
            <ScopeRow icon={Calendar} label="Calendar" sub="Powers the Calendar widget and Signal Chain's Murbah sync." active />
            <ScopeRow icon={HardDrive} label="Drive backup" sub="Below — one-click backup & restore." active />
            <ScopeRow icon={FileText} label="Docs" sub="Jarvis-drafted documents, from the Jarvis tab." active />
          </div>
        )}
      </Card>

      {google.connected && (
        <Card title="Data vault" sub="A full copy of everything on the Deck, mirrored to your own Google Drive.">
          <div style={{ fontSize: '0.75rem', color: C.walnutSoft, marginBottom: '0.5rem' }}>
            {backupStamp ? `Last backed up ${new Date(backupStamp).toLocaleString()}.` : 'No backup yet.'}
          </div>

          {vaultStatus && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4rem', fontSize: '0.75rem', marginBottom: '0.6rem', color: vaultStatus.reachable ? C.walnutSoft : C.alert }}>
              {vaultStatus.reachable
                ? <Check size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                : <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />}
              <span>{vaultStatusMessage(vaultStatus)}</span>
            </div>
          )}

          <button
            onClick={checkVault}
            disabled={vaultBusy}
            style={{ ...pillBtn(C.walnutSoft), width: '100%', padding: '0.5rem', fontSize: '0.8rem', marginBottom: '0.6rem', opacity: vaultBusy ? 0.7 : 1 }}
          >
            {vaultBusy ? 'Checking vault…' : 'Check vault reachability'}
          </button>

          <button
            onClick={driveBackup}
            disabled={driveBackupBusy}
            style={{ ...pillBtn(C.brass), width: '100%', padding: '0.6rem', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', opacity: driveBackupBusy ? 0.7 : 1 }}
          >
            {driveBackupBusy ? <Loader2 size={15} className="animate-spin" /> : <UploadCloud size={15} />}
            {driveBackupBusy ? 'Backing up…' : 'Back up to Drive now'}
          </button>
          {driveBackupMsg && <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: C.walnutSoft }}>{driveBackupMsg}</p>}

          <div style={{ height: 1, background: C.line, margin: '0.9rem 0' }} />

          {!confirmingRestore ? (
            <button
              onClick={() => setConfirmingRestore(true)}
              style={{ ...pillBtn(C.walnutSoft), width: '100%', padding: '0.6rem', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}
            >
              <DownloadCloud size={15} /> Restore from Drive
            </button>
          ) : (
            <div style={{ background: C.tweed, border: `1px solid ${C.alert}`, borderRadius: 10, padding: '0.7rem' }}>
              <p style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4rem', margin: 0, fontSize: '0.78rem', color: C.ink }}>
                <AlertTriangle size={15} color={C.alert} style={{ flexShrink: 0, marginTop: '0.1rem' }} />
                This replaces everything currently on the Deck with the last Drive backup. It cannot be undone.
              </p>
              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.6rem' }}>
                <button
                  onClick={async () => { await driveRestore(); setConfirmingRestore(false); }}
                  disabled={driveRestoreBusy}
                  style={{ ...pillBtn(C.alert), flex: 1, opacity: driveRestoreBusy ? 0.7 : 1 }}
                >
                  {driveRestoreBusy ? 'Restoring…' : 'Yes, replace everything'}
                </button>
                <button onClick={() => setConfirmingRestore(false)} disabled={driveRestoreBusy} style={{ ...pillBtn(C.walnutSoft), flex: 1 }}>Cancel</button>
              </div>
            </div>
          )}
          {driveRestoreMsg && <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: C.walnutSoft }}>{driveRestoreMsg}</p>}
        </Card>
      )}
    </>
  );
}

// Jarvis-triggered widget build progress (server/src/functions/
// buildDeckWidget.js) — Rob, 2026-09-17, after first seeing this land as
// chat messages instead: "wait not in the chat it should be a progress bar
// with details running in the widgets card." Polled by CommandDeckContext
// (widgetBuild) while a build is running; stays visible once done/failed
// until dismissed so a failure isn't missed by someone who stepped away.
const BUILD_STAGE_LABEL = {
  planning: 'Planning', building: 'Building', pushing: 'Pushing',
  merging: 'Waiting on checks', deploying: 'Deploying', verifying: 'Verifying', done: 'Done', failed: 'Failed',
};
// deleteDeckWidget.js reuses the same DeckWidgetBuild row/status shape
// (action: 'delete') — same stages, worded for a removal instead of a
// build so "Removing: "widget_key"" reads naturally rather than
// "Building: "widget_key"" for something being deleted.
const DELETE_STAGE_LABEL = {
  planning: 'Preparing', building: 'Removing', pushing: 'Pushing',
  merging: 'Waiting on checks', deploying: 'Deploying', verifying: 'Verifying', done: 'Deleted', failed: 'Failed',
};
// Rough fraction for the stages before/after the per-step progress bar
// actually applies (no steps planned yet, or already past the build loop) —
// keeps the bar moving instead of sitting at 0% or 100% for a few minutes.
const BUILD_STAGE_FLOOR = { planning: 0.05, pushing: 0.9, merging: 0.93, deploying: 0.97, verifying: 0.99, done: 1, failed: 1 };

function WidgetBuildProgress() {
  const { widgetBuild, dismissWidgetBuild } = useCommandDeck();
  if (!widgetBuild) return null;
  const { status, step_index: stepIndex, step_count: stepCount, step_title: stepTitle, message, description, action } = widgetBuild;
  const stageLabel = action === 'delete' ? DELETE_STAGE_LABEL : BUILD_STAGE_LABEL;
  const fraction = stepCount > 0
    ? Math.min(1, Math.max(0.05, stepIndex / stepCount))
    : (BUILD_STAGE_FLOOR[status] ?? 0.05);
  const isTerminal = status === 'done' || status === 'failed';
  const barColor = status === 'failed' ? C.alert : status === 'done' ? C.sage : C.brass;

  return (
    <div style={{ background: C.paper, border: `1.5px solid ${barColor}`, borderRadius: 10, padding: '0.65rem 0.7rem', marginBottom: '0.6rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
        {!isTerminal && <Loader2 size={14} className="animate-spin" color={barColor} />}
        {status === 'done' && <Check size={14} color={barColor} />}
        {status === 'failed' && <AlertTriangle size={14} color={barColor} />}
        <span style={{ flex: 1, fontSize: '0.8rem', fontWeight: 600 }}>
          {stageLabel[status] || status}{stepCount > 0 && !isTerminal ? ` — step ${stepIndex}/${stepCount}` : ''}: {description}
        </span>
        {isTerminal && (
          <button onClick={dismissWidgetBuild} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '0.15rem', display: 'flex' }}>
            <X size={13} color={C.walnutSoft} />
          </button>
        )}
      </div>
      <div style={{ height: 6, borderRadius: 3, background: C.line, overflow: 'hidden', marginBottom: message || stepTitle ? '0.4rem' : 0 }}>
        <div style={{ height: '100%', width: `${Math.round(fraction * 100)}%`, background: barColor, transition: 'width 0.4s ease' }} />
      </div>
      {(message || stepTitle) && (
        <p style={{ margin: 0, fontSize: '0.75rem', color: C.walnutSoft }}>{message || stepTitle}</p>
      )}
    </div>
  );
}

// 2026-09-17 (Rob: "I should be able to add custom widgets there too, I
// just don't want to lose the tools I already have") — enable/disable +
// reorder for every DECK_WIDGETS entry, driving what actually renders on
// /deck (see DeckHome.jsx's registerWidget/orderedWidgets). A widget with no
// DeckWidgetInstance row yet just doesn't show here until the load effect's
// lazy-seed finishes — same load-order every other Deck list already has.
function WidgetManager() {
  const { widgetInstances, toggleWidget, moveWidget, deleteWidget, askToDelete } = useCommandDeck();
  const sorted = [...widgetInstances].sort((a, b) => a.sort_order - b.sort_order);
  // Same base44.auth.me() call UsageMeter() below already uses to know who's
  // asking — needed here only to gate the delete button's VISIBILITY
  // (hide a button that would just fail server-side). deleteDeckWidget.js
  // is the real, only enforcement of "you can only delete what you made."
  const [currentUserId, setCurrentUserId] = useState(null);
  useEffect(() => {
    base44.auth.me().then((u) => setCurrentUserId(u?.id || null)).catch(() => {});
  }, []);

  return (
    <Card title="Widgets" sub="What shows on your Deck, and in what order.">
      <WidgetBuildProgress />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {sorted.map((w, i) => {
          const meta = DECK_WIDGETS.find((d) => d.key === w.widget_key);
          if (!meta) return null;
          const isMine = meta.createdBy && meta.createdBy === currentUserId;
          return (
            <div key={w.widget_key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: C.paper, border: `1px solid ${C.line}`, borderRadius: 10, padding: '0.5rem 0.6rem' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.83rem', fontWeight: 600, opacity: w.enabled ? 1 : 0.5 }}>{meta.label}</div>
                {meta.note && (
                  <div style={{ fontSize: '0.7rem', color: C.walnutSoft, marginTop: '0.15rem', lineHeight: 1.4 }}>{meta.note}</div>
                )}
              </div>
              <button onClick={() => moveWidget(w.widget_key, -1)} disabled={i === 0} style={{ ...pillBtn(C.walnutSoft), padding: '0.3rem', opacity: i === 0 ? 0.3 : 1 }}>
                <ChevronUp size={13} />
              </button>
              <button onClick={() => moveWidget(w.widget_key, 1)} disabled={i === sorted.length - 1} style={{ ...pillBtn(C.walnutSoft), padding: '0.3rem', opacity: i === sorted.length - 1 ? 0.3 : 1 }}>
                <ChevronDown size={13} />
              </button>
              <button onClick={() => toggleWidget(w.widget_key)} style={{ ...pillBtn(w.enabled ? C.sage : C.walnutSoft), minWidth: 62 }}>
                {w.enabled ? 'On' : 'Off'}
              </button>
              {isMine && (
                <button
                  onClick={() => askToDelete(() => deleteWidget(w.widget_key))}
                  title={`Delete "${meta.label}" — this removes it from production entirely, for everyone`}
                  style={{ ...pillBtn(C.alert), padding: '0.3rem' }}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// 2026-09-17 — closes the earlier "Business details settings form" gap and
// carries the new business_context field: what every Valiant-Music-specific
// prompt (Jarvis, the Gmail filter, brain-dump classification, doc
// drafting, suggested replies) used to hardcode inline now reads from here.
//
// 2026-09-28 — also carries the consignment fee structure. Rob: "Consignment is a set fee
// structure but i can change it in settings." Blank means the DEFAULT (30% up to $2000, 20%
// above) — the columns are nullable precisely so an account that never opens this keeps exactly
// today's behaviour. The preview underneath is the point of the field: it shows the rate that
// applies, the shop's cut and what the consignor receives, at a price the operator can type, so a
// wrong unit (rates are percentages: 30 means 30%, not 0.3) is visible before anything is saved.
const feeBlockStyle = { borderTop: `1px solid ${C.line}`, paddingTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' };
const feeFieldStyle = { display: 'flex', flexDirection: 'column', gap: '0.15rem', flex: '1 1 90px' };
const feeFieldLabelStyle = { fontSize: '0.68rem', color: C.walnutSoft };

function BusinessProfileForm() {
  const { businessProfile, businessProfileBusy, saveBusinessProfile } = useCommandDeck();
  const [form, setForm] = useState({
    shop_name: '', tagline: '', contact_email: '', business_context: '',
    fee_threshold: '', fee_rate_under: '', fee_rate_over: '',
  });
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  // The server had to drop the fee fields to make the save work (the fee_* migration has not been
  // applied in this environment yet). Kept past the 2s tick, because "Saved" over a setting that
  // was not stored is worse than a failed save — the operator has to see it and know what to do.
  const [feeDropped, setFeeDropped] = useState(false);
  const [samplePrice, setSamplePrice] = useState('2500');

  useEffect(() => {
    if (businessProfile && !dirty) {
      setForm({
        shop_name: businessProfile.shop_name || '',
        tagline: businessProfile.tagline || '',
        contact_email: businessProfile.contact_email || '',
        business_context: businessProfile.business_context || '',
        // `?? ''` and not `|| ''`: 0 is a real, storable rate ("no fee"), so it must not collapse
        // back to blank and read as "use the default".
        fee_threshold: businessProfile.fee_threshold ?? '',
        fee_rate_under: businessProfile.fee_rate_under ?? '',
        fee_rate_over: businessProfile.fee_rate_over ?? '',
      });
    }
  }, [businessProfile, dirty]);

  const update = (field) => (e) => { setForm((f) => ({ ...f, [field]: e.target.value })); setDirty(true); };
  const updateValue = (field) => (value) => { setForm((f) => ({ ...f, [field]: value })); setDirty(true); };

  // ONE rule for what the fee fields mean: it decides whether Save is allowed AND builds the
  // payload, so the button and the request cannot disagree about a value being acceptable.
  const parsed = parseFeeTierInput(form);
  const previewTiers = feeTiersFromProfile(parsed.fields);
  const sample = Number(samplePrice) || 0;

  const save = async () => {
    if (!parsed.ok) return;
    // The text fields go as typed; the fee columns are replaced by the parsed numbers (or null
    // for blank) so the API never receives "30" as a string where a Float column is expected.
    const { feeFieldsDropped } = await saveBusinessProfile({ ...form, ...parsed.fields });
    setDirty(false);
    setSaved(true);
    setFeeDropped(feeFieldsDropped);
    window.setTimeout(() => setSaved(false), 2000);
  };

  return (
    <Card title="Business profile" sub="Shapes your Deck header and every AI feature — Jarvis, Gmail filtering, brain-dump sorting, drafted replies.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <MicField placeholder="Business name" value={form.shop_name} onChange={updateValue('shop_name')} style={{ ...miniInput, width: '100%', boxSizing: 'border-box' }} />
        <MicField placeholder="Tagline (shown under the name)" value={form.tagline} onChange={updateValue('tagline')} style={{ ...miniInput, width: '100%', boxSizing: 'border-box' }} />
        <input placeholder="Contact email" value={form.contact_email} onChange={update('contact_email')} style={{ ...miniInput, width: '100%', boxSizing: 'border-box' }} />
        <MicTextarea
          placeholder="Tell Jarvis about your business — what you do, your goals, anything worth knowing when it's drafting replies or deciding what counts as a real inquiry."
          value={form.business_context}
          onChange={updateValue('business_context')}
          rows={4}
          style={miniInput}
        />
        <div style={feeBlockStyle}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: C.brass }}>Consignment fee</div>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            <label style={feeFieldStyle}>
              <span style={feeFieldLabelStyle}>Up to $</span>
              <input inputMode="decimal" placeholder={String(DEFAULT_FEE_TIERS.threshold)} value={form.fee_threshold} onChange={update('fee_threshold')} style={miniInput} />
            </label>
            <label style={feeFieldStyle}>
              <span style={feeFieldLabelStyle}>Our cut up to it (%)</span>
              <input inputMode="decimal" placeholder={formatFeeRate(DEFAULT_FEE_TIERS.rateUnder)} value={form.fee_rate_under} onChange={update('fee_rate_under')} style={miniInput} />
            </label>
            <label style={feeFieldStyle}>
              <span style={feeFieldLabelStyle}>Our cut above it (%)</span>
              <input inputMode="decimal" placeholder={formatFeeRate(DEFAULT_FEE_TIERS.rateOver)} value={form.fee_rate_over} onChange={update('fee_rate_over')} style={miniInput} />
            </label>
          </div>
          {Object.values(parsed.errors).map((msg) => (
            <span key={msg} style={{ fontSize: '0.72rem', color: C.alert }}>{msg}</span>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap', fontSize: '0.72rem', color: C.walnutSoft }}>
            <span>At</span>
            <input inputMode="decimal" value={samplePrice} onChange={(e) => setSamplePrice(e.target.value)} style={{ ...miniInput, width: 72 }} aria-label="Sample price" />
            <span>
              {feeRateLabel(sample, previewTiers)} rate → our cut {money(commissionFor(sample, previewTiers))}, consignor gets {money(consignorProceeds(sample, previewTiers))}
            </span>
          </div>
        </div>
        <button onClick={save} disabled={businessProfileBusy || !dirty || !parsed.ok} style={{ ...pillBtn(C.brass), opacity: businessProfileBusy || !dirty || !parsed.ok ? 0.6 : 1 }}>
          {businessProfileBusy ? 'Saving…' : 'Save'}
        </button>
        {saved && !feeDropped && <span style={{ fontSize: '0.75rem', color: C.sage, fontWeight: 600 }}>✓ Saved</span>}
        {feeDropped && (
          <span style={{ fontSize: '0.72rem', color: C.alert }}>
            Saved, except the fee structure — that needs a database update before it can be stored.
          </span>
        )}
      </div>
    </Card>
  );
}

function ScopeRow({ icon: Icon, label, sub, active }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.4rem 0.1rem', opacity: active ? 1 : 0.55 }}>
      <Icon size={15} color={active ? C.brass : C.walnutSoft} style={{ flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: '0.72rem', color: C.walnutSoft }}>{sub}</div>
      </div>
    </div>
  );
}

// Same balance/buy-more logic as src/components/matrix/CreditBalance.jsx
// (that component's own comment already anticipated this exact reuse) —
// rebuilt with Deck's own Card/pillBtn instead of Morpheus's Matrix styling,
// but sharing the same credit_balance field, startTokenCheckout(blockIndex),
// and TOKEN_BLOCKS as the rest of the app. One shared balance across every
// AI feature (Morpheus builds, Jarvis chat, Gmail classification, etc.) —
// there's no separate Jarvis-only credit pool.
const POLL_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 2000;

function UsageMeter() {
  const [balance, setBalance] = useState(null);
  const [loadingBalance, setLoadingBalance] = useState(true);
  const [buyingIndex, setBuyingIndex] = useState(null);
  const [error, setError] = useState('');
  const [banner, setBanner] = useState(null); // { kind: 'success' | 'cancelled' }
  const pollRef = useRef(null);

  const fetchBalance = useCallback(async () => {
    try {
      const user = await base44.auth.me();
      setBalance(Number(user?.credit_balance ?? 0));
    } catch {
      // Not fatal — balance just won't render; the rest of Settings still works.
    } finally {
      setLoadingBalance(false);
    }
  }, []);

  useEffect(() => {
    fetchBalance();

    const params = new URLSearchParams(window.location.search);
    const credits = params.get('credits');
    if (credits === 'success' || credits === 'cancelled') {
      setBanner({ kind: credits });
      params.delete('credits');
      const cleanUrl = window.location.pathname + (params.toString() ? `?${params}` : '');
      window.history.replaceState({}, '', cleanUrl);
    }
    if (credits === 'success') {
      let attempts = 0;
      pollRef.current = setInterval(() => {
        attempts += 1;
        fetchBalance();
        if (attempts >= POLL_ATTEMPTS && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, POLL_INTERVAL_MS);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchBalance]);

  const buy = async (blockIndex) => {
    setError('');
    setBuyingIndex(blockIndex);
    try {
      await startTokenCheckout(blockIndex);
    } catch (e) {
      setError(e.message || 'Could not start checkout');
      setBuyingIndex(null);
    }
  };

  return (
    <Card title="Usage" sub="Every AI action across Morpheus and Jarvis draws from one shared credit balance — no subscription, no expiry.">
      {banner?.kind === 'success' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: C.tweedDark, borderRadius: 8, padding: '0.5rem 0.6rem', marginBottom: '0.7rem', fontSize: '0.78rem', color: C.sage }}>
          <Check size={14} /> Payment received — your balance updates within a few seconds.
        </div>
      )}
      {banner?.kind === 'cancelled' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: C.tweedDark, borderRadius: 8, padding: '0.5rem 0.6rem', marginBottom: '0.7rem', fontSize: '0.78rem', color: C.walnutSoft }}>
          <X size={14} /> Checkout cancelled — no charge was made.
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.9rem' }}>
        <Coins size={16} color={C.brass} />
        <span style={{ fontSize: '0.72rem', color: C.walnutSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Balance</span>
        {loadingBalance ? (
          <Loader2 size={14} className="animate-spin" color={C.walnutSoft} />
        ) : (
          <span style={{ fontSize: '1.1rem', fontWeight: 700, color: C.walnut }}>{balance != null ? balance.toFixed(2) : '—'} credits</span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.5rem' }}>
        {TOKEN_BLOCKS.map((block, i) => (
          <button
            key={block.credits}
            onClick={() => buy(i)}
            disabled={buyingIndex !== null}
            style={{
              textAlign: 'left', background: C.paper, border: `1.5px solid ${C.line}`, borderRadius: 10,
              padding: '0.6rem 0.7rem', cursor: buyingIndex !== null ? 'default' : 'pointer', opacity: buyingIndex !== null && buyingIndex !== i ? 0.5 : 1,
            }}
          >
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: C.walnut }}>{block.credits.toLocaleString()} credits</div>
            <div style={{ fontSize: '0.68rem', color: C.walnutSoft, marginTop: '0.15rem' }}>~${block.intendedNetUsd.toFixed(2)} + card fees</div>
            <div style={{ marginTop: '0.4rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', fontWeight: 600, color: C.brass }}>
              {buyingIndex === i ? <Loader2 size={12} className="animate-spin" /> : null}
              {buyingIndex === i ? 'Redirecting…' : 'Buy'}
            </div>
          </button>
        ))}
      </div>

      {error && <p style={{ margin: '0.6rem 0 0', fontSize: '0.75rem', color: C.alert }}>{error}</p>}
      <p style={{ margin: '0.6rem 0 0', fontSize: '0.68rem', color: C.walnutSoft }}>Secure checkout via Stripe.</p>
    </Card>
  );
}
