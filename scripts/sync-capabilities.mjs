// Auto-generates src/MORPHEUS_DESIGN_PLAN.md from the single source of truth
// (src/lib/morpheusCapabilities.json). Runs automatically on every build via
// the `prebuild` npm script, so the design-plan doc stays in sync with the
// capabilities list shown on the load screen without manual editing.
//
// Usage: node scripts/sync-capabilities.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const srcPath = resolve(root, 'src/lib/morpheusCapabilities.json');
const outPath = resolve(root, 'src/MORPHEUS_DESIGN_PLAN.md');

const data = JSON.parse(readFileSync(srcPath, 'utf8'));

const lines = [];
lines.push('# Morpheus — Design Plan');
lines.push('');
lines.push('> Auto-generated from `src/lib/morpheusCapabilities.json` by `scripts/sync-capabilities.mjs`. Do not edit by hand — change the JSON and rebuild.');
lines.push('');
lines.push('## Core Principle');
lines.push('');
lines.push(`**${data.principle}**`);
lines.push('');
lines.push(data.intro);
lines.push('');
lines.push('---');
lines.push('');
lines.push('## What Morpheus Does');
lines.push('');
for (const c of data.capabilities) {
  lines.push(`- **${c.title}** — ${c.body}`);
}
lines.push('');
lines.push('---');
lines.push('');
lines.push(data.closing);
lines.push('');

writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log(`[sync-capabilities] wrote ${outPath} (${data.capabilities.length} capabilities)`);