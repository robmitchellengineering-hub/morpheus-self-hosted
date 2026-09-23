#!/usr/bin/env node
/**
 * Seed the dock rig: the smallest amount of real database state that makes
 * /embed?token=… render and do something.
 *
 *   * a fixture OWNER (admin, so the AI path is billing-exempt and the rig never
 *     has to fund an account) whose email is obviously synthetic;
 *   * a project with compile_target 'web-app' — the WEBSITE panel only offers
 *     its button for that target, and the dock is the same surface;
 *   * a PluginConnection row pointing at the mock WordPress, its shared secret
 *     encrypted the way the server stores it (server/src/crypto.js);
 *   * two widget tokens, minted through the REAL server code
 *     (server/src/lib/widgetToken.js), so only their SHA-256 is stored exactly
 *     as in production:
 *       - `full`          chat,deploy,store,seo,traffic → every tab
 *       - `chat-only`     chat                          → one tab, no tab bar
 *     Two tokens, because "the tabs it is scoped for appear" is only a real
 *     assertion when something is deliberately withheld from one of them.
 *
 * The plaintext token is written ONLY to server/data/dock-rig/state.json
 * (under server/data/, which .gitignore covers) and is never committed. Run
 * `node scripts/dev-dock-rig.mjs url` to print the embed URL.
 *
 * Run through scripts/dev-dock-rig.mjs, which supplies DATABASE_URL and the
 * mock's secret. Standalone it needs the same env the server has.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = join(REPO, 'server', 'data', 'dock-rig');
const STATE_FILE = join(STATE_DIR, 'state.json');

const { prisma } = await import('../server/src/db.js');
const { encrypt } = await import('../server/src/crypto.js');
const { createWidgetToken, WIDGET_SCOPE_FUNCTIONS } = await import('../server/src/lib/widgetToken.js');

const OWNER_EMAIL = process.env.DOCK_RIG_EMAIL || 'dock-rig@example.test';
const PROJECT_NAME = process.env.DOCK_RIG_PROJECT || 'Dock rig fixture';
const WP_SITE_URL = (process.env.DOCK_RIG_WP_URL || 'http://localhost:4600').replace(/\/+$/, '');
const WP_SECRET = process.env.DOCK_RIG_WP_SECRET || 'dock-rig-local-shared-secret';
const TOKEN_LABEL = 'dock-rig';

const ALL_SCOPES = Object.keys(WIDGET_SCOPE_FUNCTIONS); // chat, deploy, store, seo, traffic

const user = await prisma.user.upsert({
  where: { email: OWNER_EMAIL },
  update: { role: 'admin', email_verified: true },
  create: {
    email: OWNER_EMAIL,
    password_hash: 'dock-rig-no-login',
    full_name: 'Dock Rig Owner',
    role: 'admin',
    email_verified: true,
  },
  select: { id: true, email: true, role: true },
});

const existing = await prisma.project.findFirst({ where: { created_by_id: user.id, name: PROJECT_NAME }, select: { id: true } });
const project = existing
  ? await prisma.project.update({
    where: { id: existing.id },
    data: { compile_target: 'web-app', status: 'ready' },
    select: { id: true, name: true, compile_target: true },
  })
  : await prisma.project.create({
    data: {
      created_by_id: user.id,
      name: PROJECT_NAME,
      description: 'Fixture project for the dock rig (local only).',
      compile_target: 'web-app',
      status: 'ready',
      project_type: 'frontend',
    },
    select: { id: true, name: true, compile_target: true },
  });

// The site connection the DEPLOY/HEALTH/SHOP/SEO tabs all read. `secret` is
// stored encrypted, exactly as upsertWpConnection would.
await prisma.pluginConnection.upsert({
  where: { project_id_kind: { project_id: project.id, kind: 'wordpress' } },
  update: { site_url: WP_SITE_URL, webhook_secret: encrypt(WP_SECRET), meta: JSON.stringify({ pluginVersion: '0.8.2', source: 'dock-rig' }) },
  create: {
    created_by_id: user.id,
    project_id: project.id,
    kind: 'wordpress',
    site_url: WP_SITE_URL,
    webhook_secret: encrypt(WP_SECRET),
    meta: JSON.stringify({ pluginVersion: '0.8.2', source: 'dock-rig' }),
  },
});

// Re-mint rather than accumulate: the plaintext of an old token is unrecoverable
// (only the hash is stored), so a re-run has to issue new ones either way.
await prisma.widgetToken.deleteMany({ where: { project_id: project.id, created_by_id: user.id, label: TOKEN_LABEL } });

const full = await createWidgetToken(project.id, user.id, { label: TOKEN_LABEL, scopes: ALL_SCOPES });
const chatOnly = await createWidgetToken(project.id, user.id, { label: TOKEN_LABEL, scopes: ['chat'] });

const embedUrl = (token) => `http://localhost:5173/embed?token=${encodeURIComponent(token)}`;
const state = {
  generated_at: new Date().toISOString(),
  owner: { id: user.id, email: user.email, role: user.role },
  project: { id: project.id, name: project.name, compile_target: project.compile_target },
  mock_wp: { url: WP_SITE_URL },
  tokens: {
    full: { id: full.id, prefix: full.prefix, scopes: full.scopes, token: full.token, embed_url: embedUrl(full.token) },
    'chat-only': { id: chatOnly.id, prefix: chatOnly.prefix, scopes: chatOnly.scopes, token: chatOnly.token, embed_url: embedUrl(chatOnly.token) },
  },
};
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });

console.log(`  owner      ${user.email} (${user.role})`);
console.log(`  project    ${project.name} [${project.compile_target}] ${project.id}`);
console.log(`  wordpress  ${WP_SITE_URL} (secret encrypted in plugin_connections)`);
for (const [name, t] of Object.entries(state.tokens)) {
  console.log(`  token ${name.padEnd(9)} ${t.prefix}… scopes=${t.scopes.join(',')}`);
}
console.log(`  state      ${STATE_FILE.replace(REPO + '/', '')}  (plaintext tokens; gitignored)`);
console.log('  embed URLs are in that file — run `node scripts/dev-dock-rig.mjs url` to print one.');

await prisma.$disconnect();
