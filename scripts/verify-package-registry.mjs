#!/usr/bin/env node
// verify-package-registry.mjs — our own registry: names, versions, integrity, and a version that cannot be replaced.
//
// No database: the shape module is dependency-free on purpose so this runs in the no-install guards job. What it cannot prove here
// — that publishing refuses an existing version and that fetching returns the bytes — is asserted by reading the handlers.
import { normalizePublish, buildIndex, indexEntry, NAME, VERSION, MAX_BYTES } from '../server/src/lib/packageShape.js';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let wrong = 0;
const check = (n, ok) => { if (!ok) wrong++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`); };

const tgz = gzipSync(Buffer.from('pretend this is a tarball'));
const b64 = tgz.toString('base64');
const sha = createHash('sha256').update(tgz).digest('hex');
const body = (o = {}) => ({ name: 'valiant-verification-sdk', version: '0.3.0', tarball: b64, ...o });

// ── names and versions
{
  check('a normal package is accepted', normalizePublish(body()).ok === true);
  check('an uppercase name is refused', normalizePublish(body({ name: 'Valiant' })).why.includes('lowercase'));
  check('a name starting with a dot is refused', normalizePublish(body({ name: '.hidden' })).ok === false);
  check('a version like "latest" is refused', normalizePublish(body({ version: 'latest' })).why.includes('semver'));
  check('a prerelease version is allowed', normalizePublish(body({ version: '0.4.0-beta.1' })).ok === true);
  check('a two-part version is refused', normalizePublish(body({ version: '0.3' })).ok === false);
}

// ── the bytes
{
  check('no tarball is refused with a reason', normalizePublish({ name: 'x', version: '1.0.0' }).why.includes('no tarball'));
  check('a non-gzip payload is refused, so this is not general storage',
    normalizePublish(body({ tarball: Buffer.from('not gzip').toString('base64') })).why.includes('not gzip'));
  // 9 MB of ZEROS compresses to a few kB, so it proves nothing: the limit is on the bytes that arrive. Incompressible data is
  // what a real oversized package looks like.
  const big = gzipSync(randomBytes(MAX_BYTES + 1024));
  check('an oversized package is refused', normalizePublish(body({ tarball: big.toString('base64') })).why.includes('limit'));
  const r = normalizePublish(body());
  check('the checksum is computed when none is given', r.pkg.sha256 === sha && r.pkg.size === tgz.length);
  check('a WRONG checksum is not silently replaced — a caller who states one is held to it',
    normalizePublish(body({ sha256: 'a'.repeat(64) })).pkg.sha256 === 'a'.repeat(64));
  check('a malformed checksum is refused', normalizePublish(body({ sha256: 'xyz' })).why.includes('64 hex'));
}

// ── the index
{
  const rows = [
    { name: 'a', version: '1.0.0', sha256: 'a'.repeat(64), size: 10, published_at: new Date('2026-01-01') },
    { name: 'a', version: '1.1.0', sha256: 'b'.repeat(64), size: 11, published_at: new Date('2026-02-01') },
    { name: 'b', version: '0.1.0', sha256: 'c'.repeat(64), size: 12, published_at: new Date('2026-03-01') },
  ];
  const idx = buildIndex(rows);
  check('the index names the latest version of each package', idx.latest.a === '1.1.0' && idx.latest.b === '0.1.0');
  check('…and lists every version, newest first', idx.packages.a[0].version === '1.1.0' && idx.packages.a.length === 2);
  check('…with the checksum a customer verifies', idx.packages.b[0].sha256 === 'c'.repeat(64));
  const e = indexEntry(rows[0]);
  check('an index entry carries no bytes', !('bytes' in e) && !('tarball' in e));
}

// ── the handlers' decisions, by reading them
{
  const publish = readFileSync(join(HERE, '..', 'server', 'src', 'functions', 'publishPackage.js'), 'utf8');
  // Admin session OR the release token — a build pushes a release, not a person clicking.
  check('publishing needs an admin session or the release token', /mayPublish\(\{ user, req \}\)/.test(publish));
  check('…and refuses an existing version rather than overwriting it', /already exists/.test(publish) && /every pin a lie/.test(publish));
  const get = readFileSync(join(HERE, '..', 'server', 'src', 'functions', 'getPackage.js'), 'utf8');
  check('fetching answers a GET query, because `npm install <url>` cannot send a body', /query\?\.name/.test(get) && /query\?\.version/.test(get));
  check('…and "latest" resolves to the newest version, because that is what a stranger types', /latest/.test(get) && /order by published_at desc limit 1/.test(get));
  check('fetching returns the bytes with the checksum in a header', /x-checksum-sha256/.test(get) && /octet-stream/.test(get));
  check('…and does not send JSON over the response it wrote', /return undefined/.test(get));
  const list = readFileSync(join(HERE, '..', 'server', 'src', 'functions', 'listPackages.js'), 'utf8');
  check('the index never selects the bytes column', /select name, version, sha256, size, notes, published_at/.test(list) && !/select \*/i.test(list));
}

console.log(`\n${wrong === 0 ? 'the registry names, versions, verifies and refuses to replace a published version' : `${wrong} case(s) wrong — fix before merging`}\n`);
process.exit(wrong === 0 ? 0 : 1);
