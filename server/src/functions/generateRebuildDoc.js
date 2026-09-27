// Ported from base44/functions/generateRebuildDoc/entry.ts — Morpheus's
// self-documentation feature. The original fetched live entity schemas via
// `base44.entities[name].schema()`, a Base44-only introspection API; this
// stack has no runtime equivalent, so the entity field list below is a
// static mirror of prisma/schema.prisma (kept in sync by hand — update both
// together). Content, structure, and every other section are otherwise
// ported verbatim, updated only to describe THIS stack's architecture
// instead of "how to port off Base44" (fitting, since that porting is done).
import { prisma } from '../db.js';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSchemaModels, listFunctionNames, generatedFromNote } from '../lib/schemaIntrospect.js';

// Read the system, do not remember it. The hand-kept mirrors these replace had
// drifted far enough that this document described 11 entities and 35 backend
// functions against 54 and 123 — see lib/schemaIntrospect.js for why the two
// pages that shared the same habit were deleted instead.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(HERE, '..', '..', 'prisma', 'schema.prisma');

async function readSystemShape() {
  let models = [];
  let functions = [];
  try { models = parseSchemaModels(await readFile(SCHEMA_PATH, 'utf8')); }
  catch (err) { console.warn('[generateRebuildDoc] could not read schema.prisma:', err?.message || err); }
  try { functions = listFunctionNames(await readdir(HERE)); }
  catch (err) { console.warn('[generateRebuildDoc] could not list the functions directory:', err?.message || err); }
  return { models, functions };
}
import { uploadFile } from '../storage.js';
import { logUsage } from '../lib/projectUtils.js';



function fmtDate() {
  return new Date().toISOString();
}

function entityToMarkdown(name, fields) {
  const lines = [`### ${name}`, '', '| Field | Type | Required |', '|---|---|---|'];
  for (const [key, type, required] of fields) {
    lines.push(`| ${key} | ${type} | ${required ? '✓' : ''} |`);
  }
  lines.push('| id | string (uuid) | ✓ (auto) |');
  lines.push('| created_date | datetime | ✓ (auto) |');
  lines.push('| updated_date | datetime | ✓ (auto) |');
  lines.push('| created_by_id | string (uuid, FK → User) | ✓ (auto) |');
  lines.push('');
  return lines.join('\n');
}

export default async function handler({ user }) {
  const now = fmtDate();
  const version = now;

  // Sections 3 and 4 below are generated from the live system rather than remembered —
  // but `readSystemShape()` was written and never called, so this page threw
  // `ReferenceError: models is not defined` every time it ran. Found by turning
  // `no-undef` on for server/**.
  const { models, functions } = await readSystemShape();

  const md = [];
  md.push('# MORPHEUS — SELF-HOSTED ARCHITECTURE BLUEPRINT');
  md.push('');
  md.push(`> Generated: ${now}`);
  md.push(`> Version: ${version}`);
  md.push('');
  md.push('This document is a complete, self-contained blueprint of this self-hosted Morpheus deployment — a from-source port of the original Base44 app, running on Express + Prisma/Postgres. It doubles as the entity/function reference and as onboarding material for anyone extending this codebase.');
  md.push('');
  md.push('---');
  md.push('');
  md.push('## 1. PURPOSE');
  md.push('');
  md.push('Morpheus is a Matrix-themed, chat-driven development environment. Users converse with an AI mentor ("Morpheus") to build real software projects. The AI writes files into a database, which can be exported as ZIP, pushed to GitHub, or compiled into platform-native binaries via GitHub Actions. Includes a template marketplace with Stripe payments and a configurable platform/seller revenue split.');
  md.push('');
  md.push('## 2. ARCHITECTURE');
  md.push('');
  md.push('| Layer | Technology |');
  md.push('|---|---|');
  md.push('| Frontend | React 18 + Tailwind CSS + Vite, PWA |');
  md.push('| Backend | Node.js + Express (server/src/functions/*.js, one file per operation) |');
  md.push('| Database | PostgreSQL via Prisma (server/prisma/schema.prisma) |');
  md.push('| Auth | JWT bearer tokens + bcrypt; optional Google OAuth |');
  md.push('| AI gateway | Any OpenAI-compatible endpoint — server-wide default (env vars) + per-user override |');
  md.push('| Payments | Stripe (Checkout + webhook-verified purchases) |');
  md.push('| GitHub | Per-user OAuth connector, stored encrypted in GithubConnection |');
  md.push('| Object storage | Local disk (single instance) or S3-compatible (R2/S3/MinIO) for scale |');
  md.push('| Job queue | Optional Redis/BullMQ for offloading long-running work |');
  md.push('| Voice | Browser speechSynthesis by default; optional server-side TTS |');
  md.push('| Builds | GitHub Actions (unchanged — platform-agnostic) |');
  md.push('');
  md.push('## 3. DATA MODEL');
  md.push('');
  md.push(`${models.length} tables. ${generatedFromNote('server/prisma/schema.prisma')}`);
  md.push('');
  for (const m of models) md.push(entityToMarkdown(m.name, m.fields));
  md.push(`## 4. BACKEND FUNCTIONS (${functions.length} total)`);
  md.push('');
  md.push('Each is a file at `server/src/functions/<name>.js`, dispatched by `POST /api/functions/<name>` (see server/src/routes/functions.routes.js).');
  md.push('');
  md.push(generatedFromNote('the files in server/src/functions'));
  md.push('');
  // Names only, and on purpose: the hand-written Purpose/Input/Output lines were
  // prose about code that changed underneath them. The file is the interface.
  for (const name of functions) md.push(`- \`${name}\``);
  md.push('');
  md.push('## 5. INTEGRATIONS');
  md.push('');
  md.push('### GitHub (per-user OAuth)');
  md.push('- OAuth flow: `GET /api/connections/github/start` → `GET /api/connections/github/callback` (server/src/routes/connections.routes.js).');
  md.push('- Token storage: GithubConnection table, access_token encrypted at rest (AES-256-GCM, server/src/crypto.js).');
  md.push('- API base: `https://api.github.com`, headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.');
  md.push('');
  md.push('### Stripe');
  md.push('- Secrets: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`.');
  md.push('- Webhook endpoint: `POST /api/functions/stripeWebhook` (raw body preserved for signature verification — see server/src/index.js).');
  md.push('- Revenue split: configurable via `MARKETPLACE_PLATFORM_CUT_PCT` (default 20% platform / 80% seller), computed in server/src/lib/stripe.js.');
  md.push('');
  md.push('### AI gateway');
  md.push('- `invokeAI({ userId, prompt, schema, fileUrls, role })` in server/src/ai.js.');
  md.push('- Server-wide default via `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` (+ per-role `LLM_PLANNER_MODEL` etc.); any user can override with their own OpenAI-compatible endpoint in Settings.');
  md.push('');
  md.push('### Voice (TTS)');
  md.push('- Default: `window.speechSynthesis`, zero server cost.');
  md.push('- Optional: ElevenLabs / OpenAI / custom endpoint via UserSettings.tts_*, ported in server/src/functions/generateMorpheusSpeech.js.');
  md.push('');
  md.push('## 6. COMPILE PIPELINE');
  md.push('');
  md.push('`server/src/lib/compile-targets/` — one adapter module per target (validate/scaffold/buildSteps/artifact), registry in `index.js`, YAML rendering in `workflow-renderer.js`. `compileProject.js` looks up the adapter, scaffolds, pushes to a build repo, and triggers `workflow_dispatch`; `getCompileStatus.js` polls the run; `saveCompiledArtifacts.js` saves the release assets.');
  md.push('');
  md.push('| Target | Runner | Build tool |');
  md.push('|---|---|---|');
  md.push('| web-app | ubuntu-latest | npm + vite build |');
  md.push('| python-package | ubuntu-latest | pyinstaller |');
  md.push('| windows-exe / linux-binary / mac-app | ubuntu-latest / macos-latest | @yao-pkg/pkg or PyInstaller |');
  md.push('| android-apk | ubuntu-latest | Gradle + Compose |');
  md.push('| ios-app | macos-latest | xcodebuild |');
  md.push('| rpi-distro | ubuntu-latest | pi-gen |');
  md.push('| linux-distro | ubuntu-latest | mkosi |');
  md.push('| arduino-firmware | ubuntu-latest | arduino-cli / PlatformIO |');
  md.push('');
  md.push('## 7. SCALING TO MILLIONS OF USERS');
  md.push('');
  md.push('See `SCALING.md` at the repo root for the full plan: stateless API servers behind a load balancer, Postgres read replicas + PgBouncer, Redis-backed job queue for long-running AI/compile work, S3-compatible object storage + CDN, and per-route rate limiting.');
  md.push('');
  md.push('---');
  md.push('');
  md.push('_This blueprint is auto-generated. Regenerate it from the workspace REBUILD button to capture the latest architecture notes._');
  md.push('');

  const content = md.join('\n');
  const contentSize = content.length;

  const { file_url } = await uploadFile({
    buffer: content,
    filename: `morpheus-rebuild-${version.replace(/[:.]/g, '-')}.md`,
    contentType: 'text/markdown',
  });
  const preview = content.length > 2000 ? content.substring(0, 2000) + '\n\n... [Full blueprint in file_url]' : content;

  const existing = await prisma.rebuildDoc.findFirst({ where: { created_by_id: user.id }, orderBy: { created_date: 'desc' } });
  const doc = existing
    ? await prisma.rebuildDoc.update({ where: { id: existing.id }, data: { version, content: preview, content_size: contentSize, file_url } })
    : await prisma.rebuildDoc.create({ data: { created_by_id: user.id, version, content: preview, content_size: contentSize, file_url } });

  await logUsage(user.id, 'chat_simple', '', 'rebuild-doc', { version, contentSize });

  return { version, contentSize, docId: doc.id, updated: true };
}
