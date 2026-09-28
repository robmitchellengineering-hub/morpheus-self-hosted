// The capability registry, the app-shape decision, and the exact words a user
// reads — the pure half of "a generated app can use the operator's own Google
// connection, and Morpheus says so before it fails at run time".
//
// WHY THIS EXISTS
//
// Owner's decision, 2026-09-28, verbatim:
//
//   "I think we need to make morpheus as a whole handle oauth and credentials
//    like this so it will just work for free tier app creation or if it needs to
//    be the other way he needs to say so and let people know the steps."
//
// So there are exactly two honest answers for a generated app that needs a
// provider, and Morpheus must be able to say which one applies BEFORE the user
// runs the app and meets a raw provider error:
//
//   mode A — "this app uses your connected Google account — nothing to set up".
//   mode B — "this app needs your own OAuth client: here are the exact steps".
//
// THE SECURITY RULE THAT DECIDES BETWEEN THEM
//
// A capability token that can write to a user's Drive must never be shipped in a
// public web page. A static app has no backend, so any token its browser holds is
// readable by anyone who opens the app, who could then write to that user's
// Drive. That is not acceptable and is not worked around here: an app that uses
// an operator's connection must have somewhere server-side to keep the token, and
// an app that has nowhere to keep it takes the app's-own-OAuth-client route
// instead. Mode B is therefore not a fallback for "unsupported" — it is the
// correct, stated answer for every static app, and its steps are spelled out.
//
// DEPENDENCY-FREE ON PURPOSE. scripts/verify-app-capability-creds.mjs imports
// this module, and that guard runs in CI's no-install guards job (hazard H4). The
// two isolation rules that matter most — a token is bound to ONE app, and a grant
// belongs to ONE user — are decided by the pure functions below rather than by a
// regex over source, so the guard can drive them with plain objects.
//
// WHICH GOOGLE CONNECTION AN APP USES
//
// A generated app uses the PLATFORM Drive connection (`lib/googleDrive.js`,
// scope `drive.file`) — the narrow, general-purpose one the operator creates in
// Settings → Google Drive. Deliberately NOT the Command Deck's connection
// (`lib/deckGoogle.js`), which carries gmail.readonly, gmail.send, documents and
// calendar.events on top of drive.file. functions/photoDrive.js prefers the Deck
// connection when one exists, and that is right for a Deck widget — but building
// app capabilities on it would silently make every generated app require a
// Command Deck connection and spend a far wider scope than the app needs. The
// source is named in the constant below so a reader never has to trace a
// fallback chain to learn which credential an app just spent.
import { hashToken, sameToken } from './tokenHash.js';

/** Token prefix. A value starting with this is an app capability grant. */
export const APP_CAPABILITY_PREFIX = 'apc_';

/**
 * The capabilities a generated app may be granted, and what each is allowed to
 * do. This is the whole of a grant's power, and it is deliberately its own
 * registry rather than a reuse of WIDGET_SCOPE_FUNCTIONS (which names Morpheus
 * functions, not app capabilities) or DEVICE_SCOPE_FUNCTIONS (one AI action).
 */
export const APP_CAPABILITIES = {
  // Upload a file to the operator's own Drive. No read-back, no listing, no
  // delete: a capability that can only add is a capability whose worst case is
  // an unwanted file, not a lost one.
  drive_upload: {
    label: 'Upload files to your Google Drive',
    // The provider in plain words, used in the sentences the user reads. Written
    // out rather than derived from `label` by stripping words: a sentence built by
    // string surgery reads correctly until someone renames the label.
    providerLabel: 'Google Drive',
    provider: 'google',
    // Read from this connection and no other. See the header.
    connectionSource: 'drive',
    connectionLabel: 'your connected Google Drive account (Settings → Google Drive)',
    scopes: ['https://www.googleapis.com/auth/drive.file'],
    scopeNames: ['drive.file'],
  },

  // Let the app's backend make an AI call on the operator's Morpheus account.
  //
  // DELIBERATELY SHAPED DIFFERENTLY FROM drive_upload, and the difference is the point: there is no
  // provider connection, no `connectionSource` and no `scopes`, because nothing needs connecting and
  // nothing needs registering. What it spends is the grant OWNER's Morpheus credits — metered by the
  // same `invokeAI` path every other call uses, so there is no second ledger.
  //
  // The label is where the cost is disclosed, and it is read at the moment of CONSENT — which is the
  // only moment it can be acted on. Rob, 2026-09-28: there is no free AI path ("costs still need to be
  // covered"), and an own-key call is billed cheaply rather than freely, so the label must not promise
  // anything free. See lib/creditPolicy.js and scripts/verify-ai-cost-claims.mjs, which fails the build
  // if any file a customer reads claims otherwise.
  ai_generate: {
    label: 'Use Morpheus AI on your account — this spends your Morpheus credits',
    providerLabel: 'Morpheus AI',
    provider: 'morpheus',
    connectionLabel: 'your Morpheus account and its credits',
    // No scopes: this grants an action, not access to a third-party account.
    scopes: [],
    scopeNames: [],
  },
};

/**
 * Every capability an operator may approve for an app, with the label they read when they decide.
 *
 * The LABELS travel from here rather than being written into the client, because the label is where the
 * cost is disclosed — "this spends your Morpheus credits" is a claim about money, and a claim that lives
 * in two places is a claim that will disagree with itself. Same reason the provider sentences live in
 * this module. scripts/verify-app-capability-creds.mjs asserts the client renders these.
 */
export function grantableCapabilities() {
  return Object.entries(APP_CAPABILITIES).map(([name, cap]) => ({
    name,
    label: cap.label,
    // What the operator is handing over, in one word, so the UI can group them honestly.
    kind: cap.provider === 'morpheus' ? 'account' : 'provider',
  }));
}

/**
 * The sentence an operator reads when a capability token is minted — built from what was ACTUALLY
 * granted, never from a fixed string.
 *
 * The first version said "anyone who opens the app could read it and write to your Google Drive" for
 * every grant. Handed to an AI-only grant that is a false statement about both access and money, and it
 * was written before a second capability existed to expose it. A warning that describes the wrong
 * capability is worse than no warning: it teaches the operator to skim the one that is accurate.
 */
export function grantWarning(capabilities = []) {
  const granted = Array.isArray(capabilities) ? capabilities : [];
  const canDo = [];
  if (granted.includes('drive_upload')) canDo.push('write to your Google Drive');
  if (granted.includes('ai_generate')) canDo.push('make AI calls that spend your Morpheus credits');
  const consequence = canDo.length
    ? `Anyone who reads it could ${canDo.join(', and could ')}.`
    : 'It carries only the capabilities listed on it.';
  return 'Copy this token into the app BACKEND now — it is shown once and cannot be recovered. '
    + 'Never put it in a web page, a URL or client-side code. '
    + consequence
    + ' An app with no backend cannot use a capability token safely.';
}

/** Is this a capability we can actually grant? */
export function isKnownCapability(name) {
  return Object.prototype.hasOwnProperty.call(APP_CAPABILITIES, String(name ?? ''));
}

/**
 * A stable, document-free id for an app, derived from its project id.
 *
 * The published app carries this value; the grant stores it. It is not a secret
 * — the token is — and it exists so that a capability request must NAME the app
 * it is acting for and be refused when the name does not match the grant. That
 * turns "is this token being used by the app it was issued to?" from an
 * assumption into a checked fact.
 */
export function appIdForProject(projectId) {
  const raw = String(projectId ?? '').trim();
  // 16 hex chars of SHA-256 — long enough not to collide, and deliberately not
  // the project id itself, so a leaked app id does not advertise a row to probe.
  return raw ? `app_${hashToken(raw).slice(0, 16)}` : '';
}

/** The scopes a capability needs, deduped, for the consent screen and the guide. */
export function scopesForCapabilities(capabilities = []) {
  const out = [];
  for (const name of Array.isArray(capabilities) ? capabilities : []) {
    for (const scope of APP_CAPABILITIES[name]?.scopes ?? []) {
      if (!out.includes(scope)) out.push(scope);
    }
  }
  return out;
}

/** The short scope names (drive.file) — what the Google console UI asks for. */
export function scopeNamesForCapabilities(capabilities = []) {
  const out = [];
  for (const name of Array.isArray(capabilities) ? capabilities : []) {
    for (const scope of APP_CAPABILITIES[name]?.scopeNames ?? []) {
      if (!out.includes(scope)) out.push(scope);
    }
  }
  return out;
}

// ── Which provider capabilities an app actually needs ────────────────────────
//
// Markers are matched against the app's own file paths and contents. A marker is
// deliberately specific — `googleapis.com` or `accounts.google.com/o/oauth2`, not
// the bare word "google" — because a false positive here costs every generated app
// that mentions Google an unnecessary setup guide, and a guide shown where it is
// not needed is the same dishonesty as one withheld where it is.
const PROVIDER_MARKERS = [
  { provider: 'google', capability: 'drive_upload', label: 'Google Drive', markers: [
    'drive.google.com', 'www.googleapis.com/drive', 'googleapis.com/auth/drive',
    'googleapis.com/upload/drive', 'drive.file', 'google-drive', 'googledrive',
  ] },
  { provider: 'google', capability: 'gmail', label: 'Gmail', markers: [
    'gmail.googleapis.com', 'googleapis.com/auth/gmail',
  ] },
  { provider: 'google', capability: 'calendar', label: 'Google Calendar', markers: [
    'googleapis.com/calendar', 'calendar.googleapis.com', 'googleapis.com/auth/calendar',
  ] },
  { provider: 'github', capability: 'github', label: 'GitHub', markers: [
    'api.github.com', 'github.com/login/oauth',
  ] },
];

/** Does the app bring its own OAuth client rather than borrowing the operator's? */
const OWN_CLIENT_MARKERS = [
  'accounts.google.com/o/oauth2',
  'oauth2/v2/auth',
  'client_id=',
  'CLIENT_ID',
];

/**
 * The provider capabilities this app's files say it needs.
 *
 * Returns capability names from APP_CAPABILITIES plus provider-only names
 * (`gmail`, `calendar`, `github`) that we cannot yet grant — the caller needs
 * both, because "you need Google, and we can only help with Drive" is a
 * different sentence from "you need Google" and a more useful one.
 */
export function detectProviderNeeds(files = [], { declared = [] } = {}) {
  const haystack = (Array.isArray(files) ? files : [])
    .map((f) => `${f?.path ?? ''}\n${f?.content ?? ''}`)
    .join('\n')
    .toLowerCase();

  const found = new Set();
  for (const entry of PROVIDER_MARKERS) {
    if (entry.markers.some((m) => haystack.includes(m))) found.add(entry.capability);
  }
  // The planner's own declaration is honoured even when no marker was found: it
  // read the request, and a plan to "upload the receipt to the user's Drive"
  // does not have to contain a Drive URL to be true.
  for (const name of Array.isArray(declared) ? declared : []) {
    if (isKnownCapability(name) || PROVIDER_MARKERS.some((e) => e.capability === name)) found.add(String(name));
  }

  const order = [...PROVIDER_MARKERS.map((e) => e.capability)];
  return order.filter((c) => found.has(c));
}

/** Human labels for a set of capability names. */
export function capabilityLabels(capabilities = []) {
  return (Array.isArray(capabilities) ? capabilities : []).map((name) => (
    APP_CAPABILITIES[name]?.label
    ?? PROVIDER_MARKERS.find((e) => e.capability === name)?.label
    ?? String(name)
  ));
}

/**
 * Can this app keep a capability token where a browser cannot read it?
 *
 * `web-app` is the static one — it compiles to files and deploys to a static
 * host, so its whole program is public. Every other target produces something
 * with a server, a binary or a daemon that can hold a secret. This is a fact
 * about the compile target, not a preference, which is why it is computed here
 * and asserted by the guard rather than left to prose.
 */
export function appCanHoldToken(compileTarget) {
  const target = String(compileTarget ?? 'source');
  return target !== 'web-app' && target !== 'source';
}

/**
 * Decide the mode, in one place, for both the README and the compile UI.
 *
 * Returns a plain object so the guard can assert every branch without a database.
 * `mode` is one of:
 *   'none'                — no provider capability is involved at all
 *   'connected'           — mode A: runs through the operator's own connection
 *   'own_client_required' — mode B: the app must bring its own OAuth client
 */
export function decideAppProviderMode({ capabilities = [], compileTarget, files = [], declared = [], hasOwnClient } = {}) {
  const needs = detectProviderNeeds(files, { declared });
  const names = needs.filter(isKnownCapability);
  const unknown = needs.filter((n) => !isKnownCapability(n));

  if (needs.length === 0) {
    return { mode: 'none', capabilities: [], ungrantable: [], reason: 'no-provider-needed' };
  }

  const capable = appCanHoldToken(compileTarget);
  const own = hasOwnClient ?? (Array.isArray(files) ? files : [])
    .some((f) => OWN_CLIENT_MARKERS.some((m) => `${f?.content ?? ''}`.includes(m)));

  // An app that already carries its own client is on the own-client route whether
  // or not it could have a backend — telling it "nothing to set up" when it ships
  // a client id would be wrong in the other direction.
  if (names.length > 0 && capable && !own) {
    return { mode: 'connected', capabilities: names, ungrantable: unknown, reason: 'app-can-hold-token' };
  }

  return {
    mode: 'own_client_required',
    capabilities: names,
    ungrantable: unknown,
    // The reason is the sentence the UI leans on, so it is decided here.
    reason: own ? 'app-brings-its-own-client'
      : names.length === 0 ? 'no-capability-we-can-grant'
        : 'static-app-cannot-hold-token',
  };
}

// ── The exact words ─────────────────────────────────────────────────────────
//
// These two blocks are the deliverable's honesty half, and the strings are pinned
// by the guard so the README and the UI cannot drift into saying different things
// about the same app. Both are written as plain prose a person can act on: what is
// true, and — when something is needed — the numbered steps, with no sentence that
// promises a setup-free path the app cannot deliver.

/**
 * The line the user sees first. `label` is the provider in plain words
 * ("Google Drive"), so the same sentence works for the next capability.
 */
export function headlineForMode(mode, label = 'Google Drive') {
  if (mode === 'connected') {
    return `This app uses your connected ${label} account — nothing to set up.`;
  }
  return `This app needs your own ${label} OAuth client — here are the exact steps.`;
}

/**
 * Mode A, in full.
 *
 * The last sentence is the one that must not be dropped: a capability is usable
 * only by a backend, and the operator has to be told that, because "nothing to
 * set up" is true of Morpheus and of the app's normal use, not of the one case
 * where somebody opens the page and expects it to write to a Drive by itself.
 */
export function connectedModeMessage(label = 'Google Drive') {
  return [
    `This app uses your connected ${label} account — nothing to set up.`,
    '',
    `It works through Morpheus, using the ${label} connection you already made, so there is no`,
    'OAuth client to create and no origin to register. Files it saves go to your own account,',
    'never to storage Morpheus holds.',
    '',
    'Two things are worth knowing:',
    '- Keep Google Drive connected in Settings (Settings → Google Drive). If it is ever',
    `  disconnected, this app's ${label} features stop with a clear message rather than a raw`,
    '  provider error.',
    '- The app reaches your account through its own backend, which holds a token we issued for',
    '  this app alone. That is deliberate: a token kept in a public web page could be read and',
    '  used by anyone who opened it. If you rebuild this app as a static page, it takes the',
    '  own-OAuth-client route instead and that route is documented for you in the same step.',
  ].join('\n');
}

/**
 * Mode B, in full — the steps, not a diagnosis.
 *
 * Written for the person who has the app open and no idea what "origin" means.
 * The origin is passed in by the caller, which is the only place that knows the
 * app's real deployed URL.
 */
export function ownClientSetupSteps({ label = 'Google Drive', origin = '', scopeNames = [], scopes = [], hasBackend = false, originKnown = false } = {}) {
  const scopesList = scopeNames.length ? scopeNames.join(', ') : (scopes.join(', ') || 'the scope this app asks for');
  const originLine = originKnown && origin
    ? `\`${origin}\``
    : 'the exact address this app is served from (open the app and copy it from the address bar — for a Morpheus deploy it is the Netlify URL shown in the COMPILE panel)';
  const hasBackendNote = hasBackend
    ? 'This app has somewhere server-side to keep a secret, so the value below belongs there — never in its pages.'
    : 'This app is a static page with no server, so the client id below is public by nature. That is fine for this kind of client; what is NOT fine is a token, which is exactly why the app cannot use the operator connection route.';
  return [
    `This app needs your own ${label} OAuth client — here are the exact steps.`,
    '',
    `Morpheus cannot run this one for you, and it says so rather than leaving you with a provider`,
    `error. The reason is specific: this app has no server of its own, so it has nowhere to keep a`,
    `credential that must stay secret. A token in a public page is readable and usable by anyone who`,
    `opens it. ${hasBackendNote}`,
    '',
    '1. Open the Google Cloud Console and create (or pick) a project:',
    '',
    '   https://console.cloud.google.com/projectcreate',
    '',
    `2. Enable the ${label} API for that project:`,
    '',
    '   https://console.cloud.google.com/apis/library',
    '',
    '3. Configure the consent screen (External is fine for personal use):',
    '',
    '   https://console.cloud.google.com/apis/credentials/consent',
    '',
    '4. Create an OAuth client id of type "Web application":',
    '',
    '   https://console.cloud.google.com/apis/credentials',
    '',
    '5. Under "Authorised JavaScript origins", add this app\'s origin exactly — no trailing slash:',
    '',
    `   ${originLine}`,
    '',
    '6. Under "Authorised redirect URIs", add the redirect this app actually uses. For a static app',
    '   doing a browser sign-in that is usually the same origin plus the path it returns to.',
    '',
    '7. Copy the client id (and, if this app has a backend, the client secret) into the app\'s own',
    '   configuration — see the README section below this one for the exact file and key names.',
    '',
    `8. Scopes this app requests: ${scopesList}`,
    '',
    'Numbers 5 and 6 are the two that cause the classic "Error 400: redirect_uri_mismatch" and the',
    '"idpiframe_initialization_failed" you get when the origin is missing. They must match byte for',
    'byte, including http vs https.',
  ].join('\n');
}

/**
 * The machine-readable half, for the compile UI.
 *
 * The UI must show the SAME words as the README, so both are built from the two
 * functions above rather than being retyped in JSX. `message` is the block; there
 * is no second copy of the prose anywhere.
 */
export function buildProviderReport({
  capabilities = [], compileTarget, files = [], declared = [], hasOwnClient,
  projectName = 'this app', origin = '', originKnown = false,
} = {}) {
  const decision = decideAppProviderMode({ capabilities, compileTarget, files, declared, hasOwnClient });
  const primary = decision.capabilities[0] ?? decision.ungrantable[0] ?? 'drive_upload';
  const label = APP_CAPABILITIES[primary]?.providerLabel
    ?? PROVIDER_MARKERS.find((e) => e.capability === primary)?.label
    ?? 'Google Drive';
  const shortLabel = label;

  if (decision.mode === 'none') {
    return {
      mode: 'none',
      app: projectName,
      capabilities: [],
      ungrantable: [],
      headline: '',
      message: '',
      steps: [],
      scopes: [],
      scopeNames: [],
      origin: origin || '',
    };
  }

  if (decision.mode === 'connected') {
    const message = connectedModeMessage(shortLabel);
    return {
      mode: 'connected',
      app: projectName,
      capabilities: decision.capabilities,
      ungrantable: decision.ungrantable,
      reason: decision.reason,
      headline: headlineForMode('connected', shortLabel),
      message,
      steps: [],
      scopes: scopesForCapabilities(decision.capabilities),
      scopeNames: scopeNamesForCapabilities(decision.capabilities),
      origin: origin || '',
    };
  }

  const steps = ownClientSetupSteps({
    label: shortLabel,
    origin,
    originKnown,
    scopeNames: scopeNamesForCapabilities(decision.capabilities),
    scopes: scopesForCapabilities(decision.capabilities),
    hasBackend: appCanHoldToken(compileTarget),
  });
  return {
    mode: 'own_client_required',
    app: projectName,
    capabilities: decision.capabilities,
    ungrantable: decision.ungrantable,
    reason: decision.reason,
    headline: headlineForMode('own_client_required', shortLabel),
    message: steps,
    steps: steps.split('\n'),
    scopes: scopesForCapabilities(decision.capabilities),
    scopeNames: scopeNamesForCapabilities(decision.capabilities),
    origin: origin || '',
  };
}

/**
 * The README section a generated app gets. Kept here, not in the build handler,
 * so the guard can assert the text a user will actually read.
 */
export function providerReadmeSection(report = {}) {
  if (!report.mode || report.mode === 'none') return '';
  const extra = report.ungrantable?.length
    ? [
      '',
      `Note: this app also appears to use ${report.ungrantable.join(', ')}, which Morpheus cannot run`,
      'through your connected account yet. Those calls need the same own-client setup below.',
    ].join('\n')
    : '';
  const action = report.mode === 'connected'
    ? 'Nothing to set up. Keep Google Drive connected in Settings (Settings → Google Drive), and this app works.'
    : 'Follow the steps below before this app will work.';
  return [
    `${PROVIDER_README_MARKER} — generated at build time. Do not hand-edit:`,
    '     the next build rewrites this section from the app\'s own files. -->',
    '## Provider setup',
    '',
    `**${report.headline}**`,
    '',
    action,
    '',
    report.message,
    extra,
    '',
  ].join('\n');
}

/** The marker that makes a README section ours, and ours to rewrite. */
export const PROVIDER_README_MARKER = '<!-- MORPHEUS PROVIDER SETUP';

/** Insert or REPLACE the managed section, leaving the rest of a README alone. */
export function upsertProviderReadmeSection(existing, section) {
  const body = String(existing ?? '');
  const start = body.indexOf(PROVIDER_README_MARKER);
  if (start !== -1) {
    // The section runs from its marker TO THE END OF THE README.
    //
    // Two earlier shapes here were both wrong, and each was wrong in a way that
    // doubled the section on a rebuild:
    //
    //   1. delimited by the next "## " heading — but the section's own action line
    //      contains the literal text "## Provider setup" (the heading, quoted in
    //      prose), so the search found a line INSIDE the section and re-appended the
    //      rest;
    //   2. delimited by the next marker — correct for a normal file, but on a file
    //      that had already doubled, the "next marker" WAS the stray copy, so the
    //      tail re-appended it and the call was a no-op.
    //
    // "To the end" is the shape that cannot be wrong here: this section is written
    // at the end of the README by construction, the marker makes it explicitly ours
    // and says not to hand-edit it, and running to the end therefore also REPAIRS a
    // file that already carries a stray copy instead of preserving it.
    return section ? body.slice(0, start) + section : body.slice(0, start).replace(/\s+$/, '') + '\n';
  }
  if (!section) return body;
  return body.trimEnd() ? `${body.trimEnd()}\n\n${section}` : section;
}

/** The token's storage hash. The only form of it we ever persist. */
export function capabilityTokenHash(raw) {
  return hashToken(raw);
}

/** Does a request naming `appId` match the grant's own app? Constant-time. */
export function appIdMatches(grantAppId, requestedAppId) {
  const a = String(grantAppId ?? '');
  const b = String(requestedAppId ?? '');
  if (!a || !b) return false;
  return sameToken(a, b);
}

/**
 * Resolve a presented token against the stored rows a caller looked up by its
 * hash — the whole authorisation decision, pure.
 *
 * `rows` is every grant whose token_hash equals hashToken(presented) — at most
 * one in practice, since the column is unique; it takes an array so the guard can
 * hand it decoys and prove that a revoked row, or one belonging to the wrong app,
 * cannot pass. Returns { ok, reason, grant } and never throws.
 */
export function resolveCapabilityGrant(rows, { appId, capability, now = new Date() } = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (list.length === 0) return { ok: false, reason: 'unknown-token', grant: null };

  const grant = list[0];
  if (grant.revoked) return { ok: false, reason: 'revoked', grant: null };
  if (grant.expires_at && new Date(grant.expires_at).getTime() <= new Date(now).getTime()) {
    return { ok: false, reason: 'expired', grant: null };
  }
  if (!appIdMatches(grant.app_id, appId)) return { ok: false, reason: 'wrong-app', grant: null };

  const granted = String(grant.capabilities ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!granted.includes(String(capability ?? ''))) return { ok: false, reason: 'not-granted', grant: null };

  return { ok: true, reason: 'ok', grant };
}
