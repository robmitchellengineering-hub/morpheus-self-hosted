// Ported from base44/functions/generateRebuildDoc/entry.ts — Morpheus's
// self-documentation feature. The original fetched live entity schemas via
// `base44.entities[name].schema()`, a Base44-only introspection API; this
// stack has no runtime equivalent, so the entity field list below is a
// static mirror of prisma/schema.prisma (kept in sync by hand — update both
// together). Content, structure, and every other section are otherwise
// ported verbatim, updated only to describe THIS stack's architecture
// instead of "how to port off Base44" (fitting, since that porting is done).
import { prisma } from '../db.js';
import { uploadFile } from '../storage.js';
import { logUsage } from '../lib/projectUtils.js';

const ENTITY_FIELDS = {
  User: [['email', 'string', true], ['password_hash', 'string', true], ['full_name', 'string', false], ['role', 'string (enum: user, admin)', false], ['google_id', 'string', false], ['email_verified', 'boolean', false]],
  Project: [['name', 'string', true], ['description', 'string', false], ['status', 'string (enum: init, building, ready)', false], ['compile_target', 'string (enum: source, windows-exe, mac-app, linux-binary, android-apk, ios-app, python-package, web-app, rpi-distro, linux-distro, arduino-firmware)', false], ['project_type', 'string (enum: frontend, backend)', false], ['polish_ui', 'boolean', false]],
  ProjectFile: [['project_id', 'string', true], ['path', 'string', true], ['content', 'text', true], ['file_url', 'string', false], ['language', 'string', false]],
  ChatMessage: [['project_id', 'string', true], ['role', 'string (enum: user, morpheus)', true], ['content', 'text', true]],
  FileSnapshot: [['project_id', 'string', true], ['label', 'string', false], ['files', 'text', false], ['file_url', 'string', false]],
  UsageRecord: [['action_type', 'string', true], ['credits', 'int', true], ['project_id', 'string', false], ['project_name', 'string', false], ['metadata', 'text', false]],
  Template: [['name', 'string', true], ['description', 'string', false], ['long_description', 'text', false], ['files', 'text', true], ['icon', 'string', false], ['screenshots', 'text', false], ['compile_target', 'string', false], ['tags', 'string', false], ['category', 'string', false], ['install_count', 'int', false], ['price', 'int (cents)', false], ['stripe_product_id', 'string', false], ['stripe_price_id', 'string', false]],
  Purchase: [['template_id', 'string', true], ['buyer_id', 'string', true], ['seller_id', 'string', true], ['amount', 'int (cents)', true], ['platform_cut', 'int', false], ['seller_cut', 'int', false], ['stripe_session_id', 'string', true], ['status', 'string (enum: paid, refunded)', false]],
  UserSettings: [['ai_mode', 'string (enum: default, custom)', true], ['ai_base_url', 'string', false], ['ai_api_key', 'string (encrypted)', false], ['ai_model', 'string', false], ['planner_model', 'string', false], ['coder_model', 'string', false], ['reviewer_model', 'string', false], ['diagnosis_model', 'string', false], ['connections', 'text (JSON, encrypted)', false], ['tts_mode', 'string', false], ['tts_engine', 'string', false], ['tts_api_key', 'string (encrypted)', false]],
  BackendConfig: [['project_id', 'string', true], ['custom_domain', 'string', false], ['api_keys', 'text (JSON, encrypted)', false], ['deploy_platform', 'string', false], ['deploy_url', 'string', false], ['deploy_status', 'string', false]],
  RebuildDoc: [['version', 'string', true], ['content', 'text', true], ['content_size', 'int', false], ['file_url', 'string', false]],
  GithubConnection: [['login', 'string', true], ['access_token', 'string (encrypted)', true], ['scope', 'string', false]],
};

const BACKEND_FUNCTIONS = [
  { name: 'chatWithMorpheus', purpose: 'Core AI chat: sends user message + current project files to LLM, returns file operations (create/edit/delete) applied to the database', input: '{ projectId, message, fileUrls }', output: '{ reply, fileOperations }' },
  { name: 'autonomousBuildStep', purpose: 'Runs one autonomous coding step: reads project state, asks LLM for next action, applies file ops, returns status', input: '{ projectId, spec }', output: '{ reply, fileOperations, isComplete }' },
  { name: 'generateTests', purpose: 'Analyzes project files and generates a test suite + CI workflow, stored as project files', input: '{ projectId, spec }', output: '{ reply, fileOperations }' },
  { name: 'updateDependencies', purpose: 'Scans project files for package.json/requirements.txt/etc. and updates dependencies to latest versions', input: '{ projectId }', output: '{ reply, fileOperations }' },
  { name: 'diagnoseIssue', purpose: 'AI diagnosis agent: analyzes build/deploy errors, auto-fixes critical issues, returns summary + remaining action items', input: '{ type, projectId, errorContext }', output: '{ summary, autoFixed, needsUserAction }' },
  { name: 'checkGithubConnection', purpose: 'Verifies the user GitHub OAuth connection and returns login name', input: '{}', output: '{ connected, login }' },
  { name: 'uploadToGithub', purpose: 'Creates a GitHub repo (or reuses existing) under the user account and pushes all project files via Git Data API', input: '{ projectId, repoName, isPrivate }', output: '{ repoUrl, fileCount }' },
  { name: 'importFromGithub', purpose: 'Fetches a GitHub repo tree recursively, creates a new project, and bulk-imports decoded file contents', input: '{ repoInput, compileTarget }', output: '{ projectId, fileCount }' },
  { name: 'compileProject', purpose: 'Scaffolds project files via the compile-targets adapter, creates a build repo, pushes files + generated GitHub Actions workflow, triggers the build', input: '{ projectId }', output: '{ repoFullName, repoUrl, target, status }' },
  { name: 'getCompileStatus', purpose: 'Polls GitHub Actions run status, fetches step-level progress, extracts error context from failed job logs, fetches release assets on success', input: '{ projectId }', output: '{ status, conclusion, stepProgress, logs, assets, releaseUrl }' },
  { name: 'saveCompiledArtifacts', purpose: 'After a successful compile, downloads release assets from the build repo and saves them as ProjectFile records under _compiled/', input: '{ projectId }', output: '{ saved, files }' },
  { name: 'getBuildLogs', purpose: 'Fetches build logs for a project from the GitHub Actions run', input: '{ projectId }', output: '{ logs }' },
  { name: 'generateNativePrototype', purpose: 'Generates a rapid native prototype preview for the project based on its compile target', input: '{ projectId }', output: '{ previewUrl, status }' },
  { name: 'planBackend', purpose: 'AI plans the backend architecture for a project: generates schema, API routes, infrastructure components', input: '{ projectId, spec }', output: '{ plan, components }' },
  { name: 'generateBackend', purpose: 'Generates backend code files from a planned architecture and stores them as project files', input: '{ projectId }', output: '{ fileOperations }' },
  { name: 'wireFrontendToBackend', purpose: 'Connects frontend project files to the generated backend API endpoints', input: '{ projectId }', output: '{ wired }' },
  { name: 'deployBackend', purpose: 'Deploys the generated backend to a hosting platform (Supabase, Vercel, Cloudflare, Railway, Render, Fly.io, Netlify)', input: '{ projectId, platform }', output: '{ deployUrl, status }' },
  { name: 'checkDeployHealth', purpose: 'Checks the health of a deployed backend service (public — no auth required)', input: '{ projectId }', output: '{ healthy, details }' },
  { name: 'getBackendLogs', purpose: 'Pulls logs from a deployed backend service for troubleshooting', input: '{ projectId, platform }', output: '{ logs }' },
  { name: 'manageBackendConfig', purpose: 'Manages backend configuration: custom domains, API keys, connection settings', input: '{ projectId, action, config }', output: '{ updated }' },
  { name: 'publishTemplate', purpose: 'Publishes a project as a marketplace template (creates Stripe product+price, stores template)', input: '{ projectId, name, description, price, tags, category }', output: '{ templateId, stripePriceId }' },
  { name: 'browseTemplates', purpose: 'Lists marketplace templates with optional category/tag/search filter (public)', input: '{ category, tag, search }', output: '{ templates }' },
  { name: 'getPublicTemplate', purpose: 'Fetches a single template for the public store detail page (public)', input: '{ templateId }', output: '{ template }' },
  { name: 'installTemplate', purpose: 'Creates a new project from a template (free, or after purchase verification)', input: '{ templateId }', output: '{ projectId, fileCount }' },
  { name: 'downloadTemplate', purpose: 'Streams a ZIP download of template files for purchased templates', input: '{ templateId }', output: 'application/zip' },
  { name: 'createTemplateCheckout', purpose: 'Creates a Stripe Checkout session for purchasing a template', input: '{ templateId }', output: '{ url, sessionId }' },
  { name: 'stripeWebhook', purpose: 'Receives Stripe events (public, signature-verified), records purchases with platform/seller revenue split', input: 'Stripe event body', output: '{ received: true }' },
  { name: 'getSellerStats', purpose: 'Aggregates seller earnings from purchases (total, platform cut, seller cut, sales count)', input: '{}', output: '{ totalSales, totalRevenue, perTemplate }' },
  { name: 'getUsageStats', purpose: 'Aggregates usage records for the current user (credits by action type, estimated USD cost)', input: '{}', output: '{ byType, totalCredits, totalUsd }' },
  { name: 'emailProjectFiles', purpose: 'Emails a link to an already-uploaded project ZIP', input: '{ fileUrl, projectName, email }', output: '{ sent: true }' },
  { name: 'deleteAccount', purpose: 'Permanently deletes the user account and all associated data (cascades via the DB)', input: '{}', output: '{ success, projectsDeleted }' },
  { name: 'restoreSnapshot', purpose: 'Restores project files from a FileSnapshot record', input: '{ snapshotId }', output: '{ restored, projectId }' },
  { name: 'generateRebuildDoc', purpose: 'Generates this document — a comprehensive blueprint for standalone reconstruction', input: '{}', output: '{ version, contentSize }' },
  { name: 'generateMorpheusSpeech', purpose: 'Optional server-side TTS (ElevenLabs/OpenAI/custom); returns useBrowserFallback when unconfigured so the client uses window.speechSynthesis', input: '{ text }', output: '{ audioUrl }' },
];

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
  md.push(`${Object.keys(ENTITY_FIELDS).length} tables. See server/prisma/schema.prisma for the authoritative definition — this section mirrors it for reference.`);
  md.push('');
  for (const [name, fields] of Object.entries(ENTITY_FIELDS)) md.push(entityToMarkdown(name, fields));
  md.push(`## 4. BACKEND FUNCTIONS (${BACKEND_FUNCTIONS.length} total)`);
  md.push('');
  md.push('Each is a file at `server/src/functions/<name>.js`, dispatched by `POST /api/functions/<name>` (see server/src/routes/functions.routes.js).');
  md.push('');
  for (const fn of BACKEND_FUNCTIONS) {
    md.push(`### ${fn.name}`);
    md.push(`- **Purpose:** ${fn.purpose}`);
    md.push(`- **Input:** \`${fn.input}\``);
    md.push(`- **Output:** \`${fn.output}\``);
    md.push('');
  }
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
