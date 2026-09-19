#!/usr/bin/env node
// Drive the existing read-only Northflank client from the command line, so the
// agent can watch deploys and read backend logs itself instead of asking Rob
// to open a browser tab — or, on 2026-09-19, instead of inferring a crash-loop
// from an `istio-envoy` 503 and polling the public health endpoint.
//
//   node scripts/northflank.mjs status
//   node scripts/northflank.mjs logs --search "ERR_" --minutes 30
//   node scripts/northflank.mjs logs --type build --minutes 60
//
// The API logic is NOT reimplemented here — it lives in
// server/src/lib/northflank.js, the same tested client the Admin Ops Console
// and SelfDev's "DIAGNOSE FROM LOGS" use. This file only loads the credential
// and prints what that client returns.
//
// SETUP (once): create a read-only API token at Northflank → Team Settings →
// API → Tokens (RBAC role: "View Services" + "View Observability" on this
// project), then put it in server/.env.northflank (gitignored):
//
//   NORTHFLANK_API_TOKEN=...
//
// Optional overrides: NORTHFLANK_PROJECT_ID / NORTHFLANK_SERVICE_ID (they
// default to this deployment's own names). Write actions are deliberately NOT
// exposed here; a restart needs NORTHFLANK_WRITE_ENABLED and a wider token,
// and that decision stays out of this read-only wrapper.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getServiceLogs, getServiceStatus, isNorthflankConfigured } from '../server/src/lib/northflank.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(HERE, '..', 'server', '.env.northflank');

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};

function usage() {
  console.error([
    'usage:',
    '  node scripts/northflank.mjs status',
    '  node scripts/northflank.mjs logs [--search <s>] [--minutes N] [--limit N] [--type runtime|build]',
    '',
  ].join('\n'));
  process.exit(1);
}

if (!existsSync(ENV_FILE)) {
  console.error('\n  ⚠  Northflank not configured — server/.env.northflank is missing.');
  console.error('     Create it (gitignored) with one line, then re-run:');
  console.error('\n       NORTHFLANK_API_TOKEN=...\n');
  console.error('     Get the token at Northflank → Team Settings → API → Tokens, with an RBAC');
  console.error('     role granting "View Services" + "View Observability" (read-only, no write scope).\n');
  process.exit(2);
}
process.loadEnvFile(ENV_FILE);

if (!isNorthflankConfigured()) {
  console.error('\n  ⚠  NORTHFLANK_API_TOKEN is unset in server/.env.northflank.\n');
  process.exit(2);
}

if (!cmd || !['status', 'logs'].includes(cmd)) usage();

try {
  if (cmd === 'status') {
    const s = await getServiceStatus();
    console.log('\n  Northflank service status\n');
    // Northflank's service object is large; print the fields that matter for a
    // deploy, and fall back to the raw object if the shape differs.
    const pick = (o) => ({
      name: o?.name,
      status: o?.status,
      deployment: o?.deployment ? {
        status: o.deployment.status,
        branch: o.deployment.git?.branch,
        commit: o.deployment.git?.commitSha?.slice?.(0, 8),
        commitMessage: o.deployment.git?.commitMessage,
        startedAt: o.deployment.startedAt,
      } : undefined,
      instances: o?.instances?.map?.((i) => ({ status: i.status, replicas: i.replicas })),
    });
    const compact = pick(s);
    console.log(JSON.stringify(compact, null, 2).replace(/^/gm, '  '));
    if (!s) console.log('  (empty response — see raw API)');
    console.log('');
  } else {
    const search = flag('search', '');
    const minutes = Number(flag('minutes', 60));
    const limit = Number(flag('limit', 200));
    const type = flag('type', 'runtime');
    const lines = await getServiceLogs({ search, minutesBack: minutes, limit, type });
    console.log(`\n  ${lines.length} log line(s) — ${type}, last ${minutes}m${search ? `, matching "${search}"` : ''}\n`);
    for (const l of lines) {
      const ts = l.ts ? String(l.ts).slice(0, 23) : '';
      console.log(`  ${ts}  ${l.log ?? ''}`);
    }
    console.log('');
  }
} catch (err) {
  console.error(`\n  ✗ ${err?.message || err}\n`);
  process.exit(1);
}
