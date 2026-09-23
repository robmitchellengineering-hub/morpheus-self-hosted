// Runtime verification for the dock — the Morpheus button the site prints for
// its own administrator.
//
// WHY THIS EXISTS
//
// Until 0.8 the dock was a <script> tag pasted into the site's theme by hand.
// A theme update deleted it, and the dock simply stopped appearing: plugin.js
// answered 200, /embed answered 200, and nothing on the site or in wp-admin
// said why. The fix is that the plugin prints the tag — which moves the risk
// from "a file went missing" to "code we control emits a credential on every
// page of a live site". That trade is only worth making if the gate, the tag
// and the escape hatch are all asserted.
//
// The behaviour is asserted in a real WordPress by
// wp-plugin/morpheus/tests/harness-dock.php (who gets the tag, who must never,
// and what the settings screen says when it is not printing). This file asserts
// what a PHP request cannot see: THE CROSS-BOUNDARY CONTRACTS, each of which
// fails silently on a customer's site rather than in a test —
//
//   * the attributes PHP prints are the attributes public/plugin.js reads
//   * the token rule admits what server/src/lib/widgetToken.js actually issues
//   * the capability gate is manage_options, and there is only one gate
//   * the cache opt-out sits AFTER the decision, not before it
//   * a fresh install prints nothing (the default is off, and https)
//   * the loader mounts one dock however many copies of the tag are present,
//     because the theme that already has the old snippet still does
//
// Dependency-free on purpose, so it runs in CI's no-install guards job.
//
// Run: node scripts/verify-dock.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isNewer } from '../server/src/lib/version.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

const DOCK = 'wp-plugin/morpheus/includes/class-dock.php';
const SETTINGS = 'wp-plugin/morpheus/includes/class-settings.php';
const BOOTSTRAP = 'wp-plugin/morpheus/morpheus.php';
const LOADER = 'public/plugin.js';
const README = 'wp-plugin/morpheus/readme.txt';
const GENERATOR = 'server/src/lib/widgetToken.js';

let checks = 0;
let failures = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}

const has = (haystack, needle) => String(haystack).includes(needle);
const uniq = (list) => [...new Set(list)].sort();
const atLeast = (v, min) => v === min || isNewer(v, min);

/** The body of one PHP method, so a check can ask where things sit inside it. */
function methodBody(src, method) {
  const start = src.indexOf(`function ${method}(`);
  if (start < 0) return '';
  const next = src.indexOf('public static function', start + 1);
  return src.slice(start, next < 0 ? src.length : next);
}

console.log('\nDock — the button the site prints for its own administrator\n');

const dock = read(DOCK);
const settings = read(SETTINGS);
const bootstrap = read(BOOTSTRAP);
const loader = read(LOADER);
const readme = read(README);

// ── 1. the tag PHP prints is the tag the loader reads ───────────────────────
// The two halves are untyped and each ignores what it does not recognise: a
// misspelled attribute is not an error anywhere, it is a dock that never
// appears — the exact symptom this change exists to remove.
console.log('1. the printed tag and the loader agree');

const loaderAttrs = uniq([...loader.matchAll(/getAttribute\('([\w-]+)'\)/g)].map((m) => m[1]));
const printedAttrs = uniq([...dock.matchAll(/\b(data-[\w-]+)=/g)].map((m) => m[1]));

check('the loader reads attributes at all (parser sanity)', loaderAttrs.length >= 4, true);
check('PHP prints attributes at all (parser sanity)', printedAttrs.length >= 2, true);
check('the dock variant is printed', printedAttrs.includes('data-dock'), true);
check('the token attribute the loader reads is the one printed', printedAttrs.includes('data-token'), true);
check('nothing is printed that the loader would ignore', printedAttrs.filter((a) => !loaderAttrs.includes(a)), []);
// data-dock="1" is how the loader picks the dock path; "true" would silently
// render an inline iframe in the footer instead.
check('the dock variant is switched on, not merely present', has(dock, 'data-dock=\\"1\\"'), true);
check('the loader asks for exactly that value', has(loader, "getAttribute('data-dock') === '1'"), true);

// ── 2. the token rule admits what Morpheus issues ───────────────────────────
// A rule tighter than the generator refuses a real token and looks like a bug
// in the field; one looser than the generator sends a malformed credential to
// morpheus.nz on every page load. Neither shows up in a unit test that uses a
// made-up token, so the generator's OWN shape is what the rule is tested with.
console.log('\n2. the token rule matches the token Morpheus actually issues');

const prefix = (read(GENERATOR).match(/WIDGET_TOKEN_PREFIX\s*=\s*'([^']+)'/) || [])[1] || '';
const bytes = Number((read(GENERATOR).match(/randomBytes\((\d+)\)\s*\.toString\('hex'\)/) || [])[1]);
check('the generator was parsed (parser sanity)', prefix !== '' && Number.isInteger(bytes) && bytes > 0, true);

// The rule is a PHP single-quoted string, so everything up to the closing quote
// is the pattern INCLUDING PHP's own /…/ delimiters — and a naive character-class
// match here silently truncated it, which made the "rule" accept an empty token.
// Captured to the quote, then de-delimited, because the delimiters are PHP's
// syntax and not part of the pattern JS should test with.
const ruleRaw = (dock.match(/preg_match\(\s*'([^']+)'/) || [])[1] || '';
const ruleDelim = ruleRaw[0] || '';
const ruleSrc = ruleDelim !== '' && ruleRaw.endsWith(ruleDelim) ? ruleRaw.slice(1, -1) : ruleRaw;
check('the plugin rule was parsed (parser sanity)', ruleSrc.startsWith('^'), true);
const rule = new RegExp(ruleSrc);

const issued = prefix + 'a'.repeat(bytes * 2);
check('the token the generator issues passes the plugin rule', rule.test(issued), true);
check('the rule and the generator use the same prefix',
  ruleSrc.startsWith('^' + prefix), true);
// The rule is deliberately looser than today's exact shape (see the comment in
// class-dock.php): refusing the next token format would be a field bug with no
// action the operator could take. What it must never do is admit a stub, so the
// bounds it does impose are the ones tested.
check('a stub far shorter than any real token is refused', rule.test(prefix + 'a'.repeat(15)), false);
check('an unboundedly long value is refused', rule.test(prefix + 'a'.repeat(200)), false);
check('an empty token is refused', rule.test(''), false);
check('a GitHub token pasted into the token field is refused', rule.test('ghp_' + 'a'.repeat(36)), false);
check('a token with a trailing quote from the snippet is refused', rule.test(issued + '"'), false);

// ── 3. one gate, and it is manage_options ───────────────────────────────────
// The token acts as the owner. Every extra place that decides who gets it is
// another place to get it wrong, so the decision is one pure function and the
// capability in the file is asserted to be singular.
console.log('\n3. the gate is one function, and it is administrator-only');

const decide = methodBody(dock, 'should_print');
check('the decision function was found (parser sanity)', decide.length > 200, true);
check('it requires a signed-in user', has(decide, "context['logged_in']"), true);
check('it requires the site-management capability', has(decide, "context['can_manage']"), true);
check('and it is checked, not merely mentioned', has(decide, "empty( $context['logged_in'] )") && has(decide, "empty( $context['can_manage'] )"), true);
check('wp-admin itself is excluded', has(decide, "context['is_admin']"), true);
check('feeds, REST and AJAX are excluded',
  has(decide, "context['is_feed']") && has(decide, "context['is_rest']") && has(decide, "context['doing_ajax']"), true);
const capabilities = uniq([...dock.matchAll(/current_user_can\(\s*'([\w]+)'/g)].map((m) => m[1]));
check('the capability named in the file is manage_options, once', capabilities, ['manage_options']);
check('the printer asks the decision rather than repeating it',
  has(methodBody(dock, 'maybe_print'), 'self::should_print('), true);
// The settings screen must not be a second gate that can disagree with the
// first — it reports the same answer, from the same two functions.
check('the settings screen reports through the same rule',
  has(methodBody(dock, 'status_note'), 'self::is_valid_token') && has(methodBody(dock, 'status_note'), 'self::loader_url'), true);

// ── 4. the cache opt-out is after the decision ──────────────────────────────
// Set before it, and every page on the site is uncacheable — a performance
// regression introduced by a change that was supposed to be a security fix.
console.log('\n4. the response is opted out of caching only when it carries the token');

const printer = methodBody(dock, 'maybe_print');
check('the printer was found (parser sanity)', printer.length > 200, true);
check('the cache opt-out is set', has(printer, "define( 'DONOTCACHEPAGE', true )"), true);
check('and the object cache with it', has(printer, "define( 'DONOTCACHEOBJECT', true )"), true);
check('it comes AFTER the decision, not before',
  printer.indexOf('self::should_print(') < printer.indexOf('DONOTCACHEPAGE'), true);
check('it returns early, so nothing below the decision runs for a visitor',
  has(printer, 'if ( ! self::should_print( $s, $c ) ) {') && has(printer, "\t\t\treturn;"), true);
// nocache_headers() in wp_footer is a "headers already sent" warning, not a fix.
check('headers are not sent from wp_footer', has(printer, 'nocache_headers('), false);

// ── 5. printing is wired up, and the token is escaped ───────────────────────
console.log('\n5. the printer is registered, and the token is escaped');

check('the bootstrap loads the class', has(bootstrap, "require_once MORPHEUS_DIR . 'includes/class-dock.php'"), true);
check('the bootstrap initialises it', has(bootstrap, 'Morpheus_Dock::init();'), true);
check('class-dock is not initialised twice',
  bootstrap.split('Morpheus_Dock::init();').length - 1, 1);
check('it prints in the site footer, not the head',
  has(methodBody(dock, 'init'), "add_action( 'wp_footer'"), true);
check('the token is attribute-escaped before it is printed', has(printer, "esc_attr( $s['token'] )"), true);
check('the loader URL is escaped as a URL', has(printer, 'esc_url( self::loader_url('), true);
check('the host must be https', has(dock, "const REQUIRE_SCHEME = '#^https://#i'"), true);

// ── 6. a fresh install prints nothing ───────────────────────────────────────
// The safe default. A plugin that starts emitting a credential on install
// because someone forgot a default is how a quiet feature becomes an incident.
console.log('\n6. the defaults are closed');

const defaults = (settings.match(/function defaults\(\)[\s\S]*?return array\(([\s\S]*?)\);/) || [])[1] || '';
check('the defaults block was parsed (parser sanity)', defaults.length > 100, true);
check('the dock ships switched OFF', /'dock_enabled'\s*=>\s*0/.test(defaults), true);
check('the dock ships with no token', /'widget_token'\s*=>\s*''/.test(defaults), true);
check('the host default is https', /'dock_host'\s*=>\s*'https:\/\//.test(defaults), true);
check('a bare host is given the scheme rather than stored bare',
  has(methodBody(settings, 'sanitize'), "https://' . $host"), true);
check('the token field is masked in the form and never echoed back',
  has(settings, 'id="md-widgettoken" type="password"') && has(settings, "self::mask( $o['widget_token'] )"), true);
check('the screen says whether it is printing, and why not when it is not',
  has(settings, 'Morpheus_Dock::status_note('), true);

// ── 7. however many copies of the tag, one dock ─────────────────────────────
// Real sites have the old snippet in the theme AND the plugin printing it now.
// Two toggles fighting over one corner is the visible bug that follows.
console.log('\n7. one dock, however many tags');

check('the loader takes a mount lock', has(loader, '__morpheusDockMounted'), true);
check('the lock is taken before the dock mounts',
  loader.indexOf('__morpheusDockMounted') < loader.indexOf('function mountDock()'), true);
check('a second copy stops there', /if \(window\.__morpheusDockMounted\) return;/.test(loader), true);
// Per-mode, not global: an inline embed on a page must keep working alongside
// a dock.
check('the lock only applies to the dock', /if \(isDock\) \{\s*\n\s*if \(window\.__morpheusDockMounted\)/.test(loader), true);

// ── 8. the version the feature shipped in ───────────────────────────────────
// "At or beyond", not equality: demanding equality made verify-traffic fail the
// first time any other change bumped the plugin, which is a gate failing for a
// reason that is not the code.
console.log('\n8. the version this capability shipped in');

const headerVersion = (bootstrap.match(/Version:\s+([\d.]+)/) || [])[1] || '';
const constantVersion = (bootstrap.match(/MORPHEUS_VERSION',\s*'([\d.]+)'/) || [])[1] || '';
const stableTag = (readme.match(/Stable tag:\s*([\d.]+)/) || [])[1] || '';
check('the header is at or beyond 0.8.0', atLeast(headerVersion, '0.8.0'), true);
check('the constant is at or beyond 0.8.0', atLeast(constantVersion, '0.8.0'), true);
check('the readme stable tag is at or beyond 0.8.0', atLeast(stableTag, '0.8.0'), true);
check('the changelog has a 0.8.0 entry that names the dock',
  has(readme, '= 0.8.0 =') && /0\.8\.0[\s\S]{0,600}[Dd]ock/.test(readme), true);

// ── 9. the operating memory points at the file ──────────────────────────────
// The card is what a future session reads before touching this area; a card
// that does not mention the dock sends it straight back to the theme.
console.log('\n9. the WordPress card knows about the dock');

const card = read('.dsh/skills/morpheus-build-library/references/wordpress.md');
check('the card names the file that decides', has(card, 'class-dock.php'), true);


// ── 10. one-tap setup: the two sides have to agree ──────────────────────────
// Every check here is a cross-boundary contract that fails AT RUNTIME on
// someone's site as a silent 403 or a button that does nothing, which is the
// expensive kind of failure. So each one parses BOTH sides rather than trusting
// the comment on either.
console.log('\n10. one-tap setup — the app and the site agree');

const APP_DOCK_ACTION = 'server/src/functions/dockAction.js';
const APP_WPP = 'server/src/lib/wpPlugin.js';
const TOKENS = 'server/src/lib/widgetToken.js';

const actionSrc = read(APP_DOCK_ACTION);
const wppSrc = read(APP_WPP);
const tokensSrc = read(TOKENS);
const dockHandle = methodBody(dock, 'handle');
const dockApply = methodBody(dock, 'apply');
const dockState = methodBody(dock, 'state');

check('the cross-boundary sources were read (parser sanity)',
  [actionSrc, wppSrc, tokensSrc, dockHandle, dockApply, dockState].every((x) => x.length > 80), true);

// 10a. the ACTION NAMES the app can send are the ones the plugin's switch has.
const pluginActions = uniq([...dockHandle.matchAll(/case\s+'([a-z_]+)'|'([a-z_]+)'\s*===\s*\$action/g)]
  .flatMap((m) => [m[1], m[2]]).filter(Boolean));
const appActions = uniq([...(actionSrc.match(/const ACTIONS = \[([^\]]+)\]/) || [])[1]?.matchAll(/'([a-z_]+)'/g) || []].map((m) => m[1]));
check('the plugin switch handles at least two actions (parser sanity)', pluginActions.length >= 2, true);
check('the app can only ask for actions the plugin handles',
  appActions.filter((a) => !pluginActions.includes(a)), []);
check('the app can ask for every action the plugin offers',
  pluginActions.filter((a) => !appActions.includes(a)), []);

// 10b. the FIELD NAMES the app sends are the ones the handler reads. Parsed from
// the payload the app actually builds, not from the wrapper's signature.
const appFields = uniq([...actionSrc.matchAll(/data\.([a-z_]+)\s*=/g)].map((m) => m[1])
  .concat([...actionSrc.matchAll(/(?:enabled|widgetToken|widget_token|action)\b/g)].map((m) => m[0])));
const pluginFields = uniq([...dockHandle.matchAll(/\$body\['([a-z_]+)'\]/g)].map((m) => m[1])
  .concat([...dockApply.matchAll(/\$body\['([a-z_]+)'\]/g)].map((m) => m[1])));
check('the plugin reads fields at all (parser sanity)', pluginFields.length >= 2, true);
// The app's camelCase must be converted, never sent raw: `widgetToken` arriving
// at PHP's `$body['widget_token']` is a silent no-op that stores nothing.
// The OUTBOUND payload is what has to be snake_case. `widgetToken` is the app's
// own inbound name from the browser and is correctly camelCase there; what must
// never happen is `data.widgetToken = ...`, which would reach PHP as nothing.
const outboundFields = uniq([...actionSrc.matchAll(/data\.([A-Za-z_]+)\s*=/g)].map((m) => m[1]));
check('the outbound payload was parsed (parser sanity)', outboundFields.length >= 1, true);
check('the app sends the plugin\'s field names, not its own camelCase',
  outboundFields.filter((f) => /[A-Z]/.test(f)), []);
check('the app names the token field the plugin reads', has(actionSrc, 'widget_token'), true);
check('the plugin names the token field the app sends', pluginFields.includes('widget_token'), true);
check('the plugin names the enable field the app sends', pluginFields.includes('enabled'), true);
check('the plugin names the action field the app sends', pluginFields.includes('action'), true);

// 10c. the route is registered, and it is the signed kind.
check('the dock route is registered', /register_rest_route\(\s*MORPHEUS_REST_NS\s*,\s*'\/dock'/.test(dock), true);
check('the route is registered on rest_api_init',
  /rest_api_init',\s*array\(\s*'Morpheus_Dock',\s*'register_routes'\s*\)/.test(bootstrap), true);
check('the dock route is POST', /'methods'\s*=>\s*'POST'/.test(dock.slice(dock.indexOf("'/dock'"), dock.indexOf("'/dock'") + 300)), true);
check('the handler verifies the signature before anything else',
  /function handle\( WP_REST_Request \$request \) \{\s*\n\s*\$body = Morpheus_REST::verified_body\( \$request \);/.test(dock), true);
check('a failed signature is returned, not swallowed',
  /if \( \$body instanceof WP_REST_Response \) \{\s*\n\s*return \$body;/.test(dockHandle), true);
// The 401 itself comes from verified_body(), which is the ONE place that decides
// it — asserted here so a future handler cannot grow its own weaker check.
const verifiedBody = methodBody(read('wp-plugin/morpheus/includes/class-rest.php'), 'verified_body');
check('the shared verifier still refuses a bad signature with 401',
  has(verifiedBody, "'bad_signature'") && has(verifiedBody, ', 401 )'), true);

// 10d. the pushed token is judged by the SAME function the settings screen uses.
const statusNote = methodBody(dock, 'status_note');
check('the settings verdict uses is_valid_token', has(statusNote, 'self::is_valid_token('), true);
check('the settings verdict uses loader_url', has(statusNote, 'self::loader_url('), true);
check('the push validates the token with that same function', has(dockApply, 'self::is_valid_token( $token )'), true);
check('the push validates the host with that same function', has(dockApply, 'self::loader_url('), true);
check('an invalid token is refused with 400', has(dockApply, "'invalid_token'") && /'invalid_token'[\s\S]{0,200}400/.test(dockApply), true);
// Refusing must not write. The save is the LAST thing that happens.
const saveAt = dockApply.indexOf('update_option(');
const validateAt = dockApply.indexOf('self::is_valid_token( $token )');
check('the token is validated at all (parser sanity)', validateAt >= 0, true);
check('nothing is saved on the ON path before the token is validated',
  dockApply.indexOf('update_option(', validateAt) > validateAt, true);

// 10e. turning it OFF is a first-class action, or one-tap setup is a trap.
check('the push can switch the dock off', /empty\( \$body\['enabled'\] \)[\s\S]{0,160}update_option\(/.test(dockApply), true);

// 10f. THE RESPONSE CAN NEVER CARRY THE TOKEN.
// Comments are stripped first: this file TALKS about not echoing the token, and
// a check that passes because the word appears in a comment is a check that would
// also pass if the echo came back.
const stripPhpComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
const dockCode = stripPhpComments(dock);
check('the comment stripper works (parser sanity)', dockCode.length < dock.length && !has(dockCode, 'THE TOKEN IS NOT IN HERE'), true);
check('the state builder reads the token only to validate it',
  /is_valid_token\( \$s\['token'\] \)/.test(dockState), true);
check('the state output is only the three verdict fields',
  uniq([...dockState.matchAll(/'(enabled|configured|note)'\s*=>/g)].map((m) => m[1])), ['configured', 'enabled', 'note']);
const responseCode = stripPhpComments(dockHandle + dockApply + dockState);
check('the response builders were isolated (parser sanity)', responseCode.length > 200, true);
check('no response path echoes a token key',
  [...responseCode.matchAll(/'(widget_token|token)'\s*=>/g)].map((m) => m[1]), []);
check('the handler never puts the body back in a response',
  /new WP_REST_Response\(\s*\$body/.test(dock), false);
check('the app does not read a token out of the reply either',
  /res\??\.data\??\.(widget_token|token)\b/.test(actionSrc), false);

// 10g. a dock token must not be able to reconfigure the dock. A widget token is
// the credential the dock ACTS AS, so letting it call this route is privilege
// escalation — and the failure is silent, because the call would simply work.
// Parsed STRUCTURALLY, not by substring. The scope list carries a comment
// explaining why dockAction is absent, and a substring check counted that
// comment — the guard failed the moment the reason was written down, which is
// the same trap as asserting on a file that merely talks about the token. What
// matters is the strings inside the arrays, so only those are read.
const scopeBlock = tokensSrc.slice(tokensSrc.indexOf('WIDGET_SCOPE_FUNCTIONS = {'));
const scopeCode = scopeBlock.slice(0, scopeBlock.indexOf('\n};') + 3)
  .replace(/(^|\s)\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const scopedFns = uniq([...scopeCode.matchAll(/\[([^\]]*)\]/g)]
  .flatMap((m) => [...m[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((x) => x[1])));
check('the widget scopes were parsed (parser sanity)', scopedFns.length >= 8, true);
check('the scope entries were read as names, not as text', scopedFns.includes('trafficAction'), true);
check('dockAction is not callable with a widget token', scopedFns.includes('dockAction'), false);
check('dockAction is not public', has(read('server/src/routes/functions.routes.js'), "'dockAction'"), false);

// 10h. the app says what it is doing, and the manual route survives.
check('the button pushes the freshly minted token', has(actionSrc, 'widgetToken') && has(read('src/components/matrix/website/EmbedTab.jsx'), 'SEND TO MY SITE'), true);
check('the snippet is still offered beside it', has(read('src/components/matrix/website/EmbedTab.jsx'), 'Embed snippet'), true);
check('the tab explains itself when the site is not connected',
  has(read('src/components/matrix/website/EmbedTab.jsx'), 'Connect your site in Setup first'), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`\n${failures} FAILED\n`);
  process.exit(1);
}
console.log('');
