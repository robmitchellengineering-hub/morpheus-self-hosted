// Does the Portable Morpheus download still describe the product?
//
// WHY THIS EXISTS. The download used to be assembled in the browser from a mirror directory,
// `public/portable-morpheus/_source/`, produced by a script whose own header said "Run after dev
// changes". Nothing ran it and nothing checked it, so it drifted silently and for a month: measured
// 2026-09-29 it mirrored `base44/` (last touched 2026-08-26) while the implementation had moved to
// `server/src/` (touched that day). The download worked perfectly and handed out the superseded
// codebase. Rob: "I can see we have lost the downloadable portable morpheus along the way somewhere."
//
// A mirror is a claim about a codebase, and it needs the same treatment as any other claim: something
// that fails when it stops being true. So this guard asserts the three properties that make the drift
// impossible rather than merely unlikely —
//
//   1. the bundle is GENERATED during the build, from the tree being built (not committed);
//   2. the rule for what ships selects the real product and never the fossil tree;
//   3. the page and the bundle say what they do NOT contain, because a download that implies an
//      installer it does not have is the same class of lie as the copy `reality.mjs` catches.
//
// It is dependency-free and asserts the rule through the same import-free module the generator uses,
// so it runs in CI's no-install guards job and cannot disagree with the thing it checks.
//
// Run:  node scripts/verify-portable-bundle.mjs
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectPortableFiles, isPortableFile, portableBundleReadme, PORTABLE_EXCLUDE } from '../server/src/lib/portableBundle.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\n1. the rule selects the product');
check('the frontend ships', isPortableFile('src/App.jsx'), true);
check('…including the Command Deck', isPortableFile('src/pages/CommandDeck/DeckHome.jsx'), true);
check('the backend ships — this IS the local server', isPortableFile('server/src/functions/chatWithMorpheus.js'), true);
check('the schema ships', isPortableFile('server/prisma/schema.prisma'), true);
check('the verification suite ships, so a self-hoster can check it', isPortableFile('scripts/verify.mjs'), true);
check('root manifests ship', [isPortableFile('package.json'), isPortableFile('README.md')].join(','), 'true,true');

console.log('\n2. …and never a fossil, a secret, or a copy of itself');
// The measured failure: the mirror shipped base44/ for a month after the port.
check('the pre-port base44 tree does NOT ship', isPortableFile('base44/functions/autonomousBuildStep/entry.ts'), false);
// The nesting trap: this directory contains the download page's own assets, inside public/.
check('the portable download machinery does not nest inside itself',
  isPortableFile('public/portable-morpheus/_source/README.md'), false);
check('…even though public/ itself ships', isPortableFile('public/deck.html'), true);
check('credentials never ship',
  [isPortableFile('server/.env'), isPortableFile('server/.env.prodsql'), isPortableFile('server/.env.northflank')].join(','), 'false,false,false');
check('build products never ship',
  [isPortableFile('node_modules/jszip/index.js'), isPortableFile('dist/assets/main.js'), isPortableFile('public/morpheus-wordpress-plugin.zip')].join(','), 'false,false,false');
check('dotfiles never ship', isPortableFile('.github/workflows/ci.yml'), false);
check('every exclusion names a reason in the module', PORTABLE_EXCLUDE.length >= 5, true);

console.log('\n3. selection is stable and deduplicated');
check('duplicates collapse and the order is stable',
  selectPortableFiles(['src/B.jsx', 'src/A.jsx', 'src/A.jsx']), ['src/A.jsx', 'src/B.jsx']);
check('junk in the list cannot become a file', selectPortableFiles(['', null, undefined, 'src/']).length, 1);

console.log('\n4. the real repository selects the whole product');
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.'))) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out;
};
const real = selectPortableFiles(walk(ROOT));
check('it selects hundreds of files (parser sanity)', real.length > 300, true);
check('the backend is in there', real.includes('server/src/functions/chatWithMorpheus.js'), true);
check('the Command Deck is in there', real.some((p) => p.startsWith('src/pages/CommandDeck/')), true);
check('the schema is in there', real.includes('server/prisma/schema.prisma'), true);
check('no base44 path survives', real.filter((p) => p.startsWith('base44/')), []);
check('no portable mirror path survives', real.filter((p) => p.startsWith('public/portable-morpheus/')), []);
check('no credential path survives', real.filter((p) => /(^|\/)\.env/.test(p)), []);

console.log('\n5. the bundle cannot go stale again');
// The whole point: regeneration is part of the build, so nobody has to remember.
check('postbuild regenerates the bundle on every build',
  /"postbuild":\s*"[^"]*scripts\/build-portable-bundle\.mjs/.test(read('package.json')), true);
check('the generator uses this same rule (guard and generator cannot disagree)',
  /from '\.\.\/server\/src\/lib\/portableBundle\.js'/.test(read('scripts/build-portable-bundle.mjs'))
  && /selectPortableFiles\(/.test(read('scripts/build-portable-bundle.mjs')), true);
check('the hand-run mirror script is gone', existsSync(join(ROOT, 'scripts/sync-portable-morpheus.mjs')), false);
check('no committed mirror survives', existsSync(join(ROOT, 'public/portable-morpheus')), false);
check('the rule module is import-free, so this runs without an install',
  /^\s*import\s/m.test(read('server/src/lib/portableBundle.js')), false);

console.log('\n6. the download page links the build product, and claims nothing more');
const page = read('src/pages/PortableMorpheusDownload.jsx');
check('the page no longer assembles a zip in the browser', /from 'jszip'/.test(page), false);
check('…it links the artifact the build wrote', /portable-morpheus\.zip/.test(page), true);
check('…and it does not fetch files one request at a time', /fetch\(`\$\{import\.meta\.env\.BASE_URL\}portable-morpheus\//.test(page), false);

console.log('\n7. the bundle says what it does NOT contain');
// A download that implies an installer it does not have is the claim-vs-system class this repo keeps
// catching. The README is generated, so it cannot describe a different build than it ships with.
const readme = portableBundleReadme({ commit: 'abc1234', builtAt: '2026-09-29T00:00:00Z', fileCount: 42 });
check('it names the commit it was built from', /abc1234/.test(readme), true);
check('it admits there is no installer or wizard', /No installer and no first-run wizard/.test(readme), true);
check('it admits there is no remote access', /No remote access/.test(readme), true);
check('it admits no AI provider is configured', /No AI configured by default/.test(readme), true);
check('it names the Command Deck, because that is the scope', /Command Deck/.test(readme), true);

console.log('\n8. the authority reports it');
check('reality.mjs knows the portable bundle exists',
  /portable/i.test(read('scripts/reality.mjs')), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ the portable download would describe something other than the product\n');
  process.exit(1);
}
console.log('the portable download is generated from the code it ships\n');
