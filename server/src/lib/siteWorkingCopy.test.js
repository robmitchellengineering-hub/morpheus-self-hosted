// Naming rules for a site's working copy. A repo name is the operator's first
// impression of this feature and it is also a GitHub identifier, so it has to
// survive hosts, subdomains, subdirectories, ports and nonsense.
import { repoNameForSite, describeWorkingCopy } from './siteWorkingCopy.js';
import assert from 'node:assert';

assert.strictEqual(repoNameForSite('https://valiantmusic.com.au'), 'valiantmusic.com.au-theme');
assert.strictEqual(repoNameForSite('http://valiantmusic.com.au/'), 'valiantmusic.com.au-theme');
assert.strictEqual(repoNameForSite('www.valiantmusic.com.au'), 'valiantmusic.com.au-theme', 'a bare host works and www is dropped');
assert.strictEqual(repoNameForSite('https://www.shop.example.co.nz'), 'shop.example.co.nz-theme');

// A site in a subdirectory must not collide with the site at the root of the
// same host — two different WordPress installs, two different repos.
assert.strictEqual(repoNameForSite('https://example.com/shop'), 'example.com-shop-theme');
assert.notStrictEqual(repoNameForSite('https://example.com/shop'), repoNameForSite('https://example.com'));

// Everything GitHub disallows becomes a dash, runs collapse, and the result
// never starts or ends with a separator.
assert.strictEqual(repoNameForSite('https://My Shop!.example.com/a b'), 'my-shop-.example.com-a-b-theme');
assert.strictEqual(repoNameForSite('https://example.com/'), 'example.com-theme');
const weird = repoNameForSite('http://-------');
assert.ok(/^[a-z0-9._-]+$/.test(weird), `only GitHub-legal characters: ${weird}`);
assert.ok(!/^[-._]|[-._]$/.test(weird), `no leading/trailing separator: ${weird}`);

// Long hosts are capped with room for the suffix to still be readable.
const long = repoNameForSite(`https://${'a'.repeat(120)}.example.com`);
assert.ok(long.length <= 86, `capped (got ${long.length})`);
assert.ok(long.endsWith('-theme'), 'the suffix survives the cap');

// Nonsense still produces something usable rather than throwing.
assert.strictEqual(repoNameForSite('', 'My Project'), 'my-project-theme');
assert.ok(repoNameForSite('not a url at all').length > 6);
assert.ok(repoNameForSite(null) .endsWith('-theme'));

// The summary has to mention what was NOT copied — that is the whole reason it
// exists rather than the UI composing its own sentence.
const plain = describeWorkingCopy({ files: 42, bytes: 51200, themeName: 'Woodmart Child' });
assert.ok(plain.includes('42 files') && plain.includes('50 KB') && plain.includes('Woodmart Child'));
const withSkips = describeWorkingCopy({ files: 3, bytes: 2048, skippedCount: 17 });
assert.ok(withSkips.includes('17 binary/large files left on the site'), withSkips);
assert.ok(describeWorkingCopy({ files: 1, bytes: 10, skippedCount: 1 }).includes('1 binary/large file left'));
assert.ok(describeWorkingCopy({ files: 2, bytes: 2097152 }).includes('2.0 MB'));
assert.ok(describeWorkingCopy({ files: 2, bytes: 100, reused: true }).includes('already had'));
assert.ok(describeWorkingCopy({ files: 1, bytes: 1 }).includes('1 file ('));

console.log('siteWorkingCopy.test.js passed');
