// Runtime verification for the "put my site in a repo" flow.
//
// Two different kinds of check, both of which have bitten this codebase before:
//
//   1. the JS↔PHP contract for the export endpoint — the plugin must be asked
//      for the actions it implements, with the fields it reads, and the app
//      must read the fields it returns. A rename on either side is a silent
//      failure at runtime, in a flow whose whole job is to not lose data;
//   2. the safety rules on the plugin side: the export reads files off a live
//      server, so "only inside the active theme, text only, capped" are
//      asserted against the source rather than trusted.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

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

console.log('\nSite working copy — runtime verification\n');

const php = read('wp-plugin/morpheus/includes/class-export.php');
const bootstrap = read('wp-plugin/morpheus/morpheus.php');
const js = read('server/src/lib/wpPlugin.js');
const handler = read('server/src/functions/createSiteWorkingCopy.js');

console.log('1. the export endpoint exists and is reachable');
check('the class is required by the plugin', has(bootstrap, "require_once MORPHEUS_DIR . 'includes/class-export.php';"), true);
check('its route is registered', has(bootstrap, "add_action( 'rest_api_init', array( 'Morpheus_Export', 'register_routes' ) );"), true);
check('the route is /export', has(php, "register_rest_route( MORPHEUS_REST_NS, '/export'"), true);
check('its requests are signature-verified', has(php, 'Morpheus_REST::verified_body'), true);
check('/status advertises export support', has(read('wp-plugin/morpheus/includes/class-rest.php'), "'export'     => array("), true);

console.log('\n2. the export can only read inside the active theme');
check('the theme root comes from WordPress, not the caller', has(php, 'wp_get_theme()'), true);
check('a path must sit under the active theme prefix', has(php, "strpos( $p, $prefix ) !== 0"), true);
check('traversal is refused', has(php, "strpos( $rel, '..' ) !== false"), true);
check('a NUL byte is refused', has(php, 'strpos( $p, "\\0" ) !== false'), true);
check('a backslash is refused', has(php, "strpos( $p, '\\\\' ) !== false"), true);
check('.git and node_modules are never copied', has(php, "'.git'") && has(php, 'node_modules'), true);
check('it exports the ACTIVE theme (the child when one is active)', has(php, 'get_stylesheet()'), true);
check('the export root is the active theme directory', has(php, 'get_theme_root( $slug )'), true);
// The parent theme is a third-party theme a deploy must never touch, so the
// export must NAME it, not walk into it.
check('it never walks into the parent theme directory', has(php, 'get_template_directory'), false);
check('the parent is reported from the theme object', has(php, "'parent_slug' => $theme['parent_slug'],"), true);

console.log('\n3. the caps are real, and what is skipped is reported');
check('per-file cap', /const MAX_FILE_BYTES\s*=\s*\d+;/.test(php), true);
check('whole-theme cap', /const MAX_TOTAL_BYTES\s*=\s*\d+;/.test(php), true);
check('per-call cap', /const MAX_BATCH_FILES\s*=\s*\d+;/.test(php), true);
check('the tree reports truncation', has(php, "'truncated'"), true);
check('skipped files carry a reason', /\$skipped\[\] = array\( 'path' => .*'reason' =>/.test(php), true);
// Building the list is not the same as RETURNING it: a repo silently missing
// 40 images with no mention anywhere is the failure this rule prevents.
check('the response includes the skipped list', has(php, "'skipped'   => array_slice( $skipped"), true);
check('the response counts them', has(php, "'skipped_count'"), true);
check('the batch reports whether it was complete', has(php, "'complete'"), true);
check('binary detection does not need the fileinfo extension', has(php, 'fread( $fh, 8192 )'), true);

console.log('\n4. JS and PHP agree on the wire');
check('JS posts to /export', has(js, "wpCall(conn, 'export'"), true);
check('JS asks for theme_tree', has(js, "action: 'theme_tree'"), true);
check('PHP answers theme_tree', has(php, "case 'theme_tree':"), true);
check('JS asks for theme_files', has(js, "action: 'theme_files'"), true);
check('PHP answers theme_files', has(php, "case 'theme_files':"), true);
check('JS sends `paths`', has(js, 'data: { paths }'), true);
check('PHP reads `paths`', has(php, "isset( $data['paths'] )"), true);
check('JS reads `files` from the response', has(handler, 'tree.data.files') || has(handler, 'res.data.files'), true);
check('PHP returns `files`', has(php, "'files'     => \$files"), true);
check('JS reads the theme block', has(handler, 'tree.data.theme'), true);
check('PHP returns the theme block', has(php, "'theme'     => array("), true);
check('JS reads `skipped`, so nothing is silently missing', has(handler, 'tree.data.skipped'), true);
check('JS reports files changed while copying', has(handler, 'changed_while_copying'), true);

console.log('\n5. the app records the repo where everything else looks for it');
check('the plugin connection is updated (what deploy reads)', has(handler, 'pluginConnection.update'), true);
check('...with the repo it just created', has(handler, 'data: { repo: repo.full_name },'), true);
check('the project is updated (what export/compile read)', has(handler, 'data: { github_repo: repo.full_name }'), true);
// NOTE ON WHAT THIS PROVES: a text guard can see that the refusal exists and
// that it is written before the theme is used; it CANNOT prove the branch is
// reachable (wrapping it in `if (false)` still passes here). Reachability is
// verified behaviourally instead — the end-to-end run points this handler at a
// site running a plugin without the export action and asserts the 409.
check('an old plugin is refused, and before the theme is touched', has(handler, 'too old to export its theme'), true);
// Both shapes an older plugin can answer with: no route at all (404
// rest_no_route) and route-but-not-this-action (400 unknown_action). Handling
// only the second is what shipped first, and a real 0.5.4 site proved it.
check('...when the export route does not exist (404 rest_no_route)', has(handler, 'rest_no_route'), true);
check('...and when the action does not exist (400 unknown_action)', has(handler, "=== 'unknown_action'"), true);
check('...with the refusal written ahead of the manifest', handler.indexOf('unknown_action') < handler.indexOf('const manifest'), true);
check('a repo name collision merges instead of clobbering', has(handler, 'listUserRepos'), true);
check('the created repo is private by default', /createRepo\(token, repoName, true/.test(handler), true);
check('the commit is one commit with a README explaining the repo', has(handler, 'README-MORPHEUS.md'), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\nThe working-copy flow is broken or the two sides disagree. Fix before merging.\n');
  process.exit(1);
}
console.log('working copy holds.\n');
