import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { logUsage } from '../../shared/projectUtils.ts';

// All entity names in the app (used to fetch live schemas)
const ENTITY_NAMES = [
  'User', 'Project', 'ProjectFile', 'ChatMessage', 'FileSnapshot',
  'Template', 'Purchase', 'UserSettings', 'UsageRecord', 'RebuildDoc', 'BackendConfig'
];

// Backend function registry — purpose, input, output for each
const BACKEND_FUNCTIONS: { name: string; purpose: string; input: string; output: string }[] = [
  // --- AI Chat & Autonomous Build ---
  { name: 'chatWithMorpheus', purpose: 'Core AI chat: sends user message + current project files to LLM, returns file operations (create/edit/delete) applied to the database', input: '{ projectId, message, fileUrls }', output: '{ reply, fileOperations, appliedOps }' },
  { name: 'autonomousBuildStep', purpose: 'Runs one autonomous coding step: reads project state, asks LLM for next action, applies file ops, returns status', input: '{ projectId, spec }', output: '{ reply, fileOperations, isComplete }' },
  { name: 'generateTests', purpose: 'Analyzes project files and generates a test suite + CI workflow, stored as project files', input: '{ projectId, spec }', output: '{ reply, fileOperations }' },
  { name: 'updateDependencies', purpose: 'Scans project files for package.json/requirements.txt and updates dependencies to latest versions', input: '{ projectId }', output: '{ reply, fileOperations }' },
  { name: 'diagnoseIssue', purpose: 'AI diagnosis agent: analyzes build/deploy errors, auto-fixes critical issues, returns summary + remaining action items', input: '{ type, projectId, errorContext }', output: '{ summary, autoFixed, needsUserAction }' },
  // --- GitHub Integration ---
  { name: 'checkGithubConnection', purpose: 'Verifies the user GitHub OAuth connection and returns login name', input: '{}', output: '{ connected, login }' },
  { name: 'uploadToGithub', purpose: 'Creates a GitHub repo (or reuses existing) under the user account and pushes all project files via Git Data API', input: '{ projectId, repoName, isPrivate }', output: '{ repoUrl, fileCount }' },
  { name: 'importFromGithub', purpose: 'Fetches a GitHub repo tree recursively, creates a new project, and bulk-imports decoded file contents', input: '{ repoInput, compileTarget }', output: '{ projectId, fileCount }' },
  // --- Compile Pipeline ---
  { name: 'compileProject', purpose: 'Scaffolds project files, creates a build repo, pushes files + generated GitHub Actions workflow, triggers the build', input: '{ projectId }', output: '{ repoFullName, repoUrl, target, status }' },
  { name: 'getCompileStatus', purpose: 'Polls GitHub Actions run status, fetches step-level progress, extracts error context from failed job logs, fetches release assets on success', input: '{ repoFullName }', output: '{ status, conclusion, stepProgress, logs, assets, releaseUrl }' },
  { name: 'saveCompiledArtifacts', purpose: 'After a successful compile, downloads release assets from the GitHub build repo and saves them as ProjectFile records under _compiled/ for in-app download', input: '{ projectId, repoFullName }', output: '{ saved, files }' },
  { name: 'getBuildLogs', purpose: 'Fetches build logs for a project from the GitHub Actions run', input: '{ projectId }', output: '{ logs }' },
  { name: 'generateNativePrototype', purpose: 'Generates a rapid native prototype preview for the project based on its compile target', input: '{ projectId }', output: '{ previewUrl, status }' },
  // --- Backend Architecture ---
  { name: 'planBackend', purpose: 'AI plans the backend architecture for a project: generates schema, API routes, infrastructure components', input: '{ projectId, spec }', output: '{ plan, components }' },
  { name: 'generateBackend', purpose: 'Generates backend code files from a planned architecture and stores them as project files', input: '{ projectId }', output: '{ fileOperations }' },
  { name: 'wireFrontendToBackend', purpose: 'Connects frontend project files to the generated backend API endpoints', input: '{ projectId }', output: '{ wired }' },
  { name: 'deployBackend', purpose: 'Deploys the generated backend to a hosting platform (Supabase, Vercel, Cloudflare, etc.)', input: '{ projectId, platform }', output: '{ deployUrl, status }' },
  { name: 'checkDeployHealth', purpose: 'Checks the health of a deployed backend service', input: '{ projectId }', output: '{ healthy, details }' },
  { name: 'getBackendLogs', purpose: 'Pulls logs from a deployed backend service for troubleshooting', input: '{ projectId }', output: '{ logs }' },
  { name: 'manageBackendConfig', purpose: 'Manages backend configuration: custom domains, API keys, connection settings', input: '{ projectId, action, config }', output: '{ updated }' },
  // --- Marketplace & Payments ---
  { name: 'publishTemplate', purpose: 'Publishes a project as a marketplace template (creates Stripe product+price, stores template entity)', input: '{ projectId, name, description, price, tags, category }', output: '{ templateId, stripePriceId }' },
  { name: 'browseTemplates', purpose: 'Lists marketplace templates with optional category/tag filter', input: '{ category, tag, search }', output: '{ templates }' },
  { name: 'getPublicTemplate', purpose: 'Fetches a single template for the public store detail page', input: '{ templateId }', output: '{ template }' },
  { name: 'installTemplate', purpose: 'Creates a new project from a template (free or after purchase verification)', input: '{ templateId }', output: '{ projectId, fileCount }' },
  { name: 'downloadTemplate', purpose: 'Generates a ZIP download of template files for purchased templates', input: '{ templateId }', output: '{ downloadUrl }' },
  { name: 'createTemplateCheckout', purpose: 'Creates a Stripe Checkout session for purchasing a template', input: '{ templateId }', output: '{ url, sessionId }' },
  { name: 'stripeWebhook', purpose: 'Receives Stripe events, records purchases with 80/20 revenue split', input: 'Stripe event body', output: '{ received: true }' },
  { name: 'getSellerStats', purpose: 'Aggregates seller earnings from purchases (total, platform cut, seller cut, sales count)', input: '{}' , output: '{ totalEarnings, salesCount, templates }' },
  // --- Usage & Account ---
  { name: 'getUsageStats', purpose: 'Aggregates usage records for the current user (credits by action type)', input: '{}', output: '{ totalCredits, byAction }' },
  { name: 'emailProjectFiles', purpose: 'Bundles project files as ZIP and emails them to a specified address', input: '{ fileUrl, projectName, email }', output: '{ sent: true }' },
  { name: 'deleteAccount', purpose: 'Permanently deletes the user account and all associated data', input: '{}' , output: '{ deleted: true }' },
  // --- Snapshots & Docs ---
  { name: 'restoreSnapshot', purpose: 'Restores project files from a FileSnapshot record', input: '{ snapshotId }', output: '{ restored: true }' },
  { name: 'generateRebuildDoc', purpose: 'Generates this document — a comprehensive blueprint for standalone reconstruction', input: '{}', output: '{ version, contentSize }' },
  { name: 'generateMorpheusSpeech', purpose: 'Legacy TTS function (now replaced by browser speechSynthesis on the client)', input: '{ text }', output: '{ audioUrl }' }
];

const FRONTEND_PAGES = [
  { file: 'src/pages/Landing.jsx', purpose: 'Matrix-rain boot screen, "Enter the Matrix" + PWA install button' },
  { file: 'src/pages/Workspace.jsx', purpose: 'Main IDE: project bar, chat panel, file tree, file viewer, preview, all dialog orchestration (compile, share, history, autonomous, tests, usage, market, seller, backend, pipeline, rebuild)' },
  { file: 'src/pages/Architect.jsx', purpose: 'Backend architecture planning workspace: plan, generate, deploy backend services' },
  { file: 'src/pages/Settings.jsx', purpose: 'User settings: AI provider config (default vs custom endpoint/key/model + per-role model overrides), hosting connections, danger zone' },
  { file: 'src/pages/Market.jsx', purpose: 'Public marketplace: browse and search community templates' },
  { file: 'src/pages/StoreItem.jsx', purpose: 'Public store detail page for a single template with purchase flow' },
  { file: 'src/pages/Login.jsx', purpose: 'Email+password + Google OAuth login' },
  { file: 'src/pages/Register.jsx', purpose: 'Email+password registration with OTP verification flow' },
  { file: 'src/pages/ForgotPassword.jsx', purpose: 'Password reset request' },
  { file: 'src/pages/ResetPassword.jsx', purpose: 'Password reset via token' },
  { file: 'src/pages/OAuthConsent.jsx', purpose: 'OAuth consent screen for connector authorization' }
];

const FRONTEND_COMPONENTS = [
  { file: 'src/components/matrix/ProjectBar.jsx', purpose: 'Two-row toolbar: project identity, compile target, action buttons (NEW, HISTORY, AUTO, TESTS, USAGE, MARKET, EARN, HELP, SETTINGS, SYNC DEPS, COMPILE, PIPELINE, BACKEND, SHARE, REBUILD)' },
  { file: 'src/components/matrix/ChatPanel.jsx', purpose: 'Chat message list + input with voice (speechSynthesis), speech recognition, file attachments, revert last prompt' },
  { file: 'src/components/matrix/FileTree.jsx', purpose: 'Hierarchical file browser with dynamic icons; shows _compiled/ artifacts with PKG label' },
  { file: 'src/components/matrix/FileViewer.jsx', purpose: 'Code viewer with syntax highlighting + dedicated download card for compiled binary artifacts' },
  { file: 'src/components/matrix/SyntaxHighlighter.jsx', purpose: 'Component-level tokenized syntax highlighter (per-language token sets to avoid collisions)' },
  { file: 'src/components/matrix/PreviewPanel.jsx', purpose: 'Rapid prototype preview: renders native Android/Java code via wrapper/proxy approach' },
  { file: 'src/components/matrix/CompilePanel.jsx', purpose: 'Compile dialog: dispatches GitHub Actions build, polls status with step-level progress counter, shows release assets, auto-triggers AI diagnosis on failure' },
  { file: 'src/components/matrix/PipelineRunner.jsx', purpose: 'Autonomous pipeline: compile → AI fix → ask Morpheus, with visual timer and stop capability' },
  { file: 'src/components/matrix/DiagnosisPanel.jsx', purpose: 'AI diagnosis results display: auto-fixed items, remaining action items, redeploy/ask-Morpheus actions' },
  { file: 'src/components/matrix/GithubGate.jsx', purpose: 'Conditional wrapper: shows connect-Github button or children when authenticated' },
  { file: 'src/components/matrix/ShareDialog.jsx', purpose: 'Export dialog: GitHub repo creation or email ZIP' },
  { file: 'src/components/matrix/ImportGithubDialog.jsx', purpose: 'Import a GitHub repo as a new project' },
  { file: 'src/components/matrix/HistoryPanel.jsx', purpose: 'FileSnapshot browser with restore capability' },
  { file: 'src/components/matrix/AutonomousPanel.jsx', purpose: 'Autonomous build runner UI with iterative step processing and failure recovery' },
  { file: 'src/components/matrix/TestsPanel.jsx', purpose: 'Test generation UI' },
  { file: 'src/components/matrix/UsagePanel.jsx', purpose: 'Usage stats display (credits by action, estimated compute cost in USD)' },
  { file: 'src/components/matrix/MarketplacePanel.jsx', purpose: 'Template marketplace browser + checkout + publish' },
  { file: 'src/components/matrix/SellerPanel.jsx', purpose: 'Seller dashboard: earnings, sales, revenue split, per-template performance' },
  { file: 'src/components/matrix/BackendPanel.jsx', purpose: 'Backend architecture panel: plan, generate, deploy, health check, logs, config' },
  { file: 'src/components/matrix/MatrixRain.jsx', purpose: 'Canvas-based Matrix digital rain background effect' },
  { file: 'src/components/matrix/NewProjectDialog.jsx', purpose: 'Create new project dialog with compile target selection' },
  { file: 'src/components/matrix/NewBackendDialog.jsx', purpose: 'Create new backend project dialog' },
  { file: 'src/components/matrix/DeleteConfirmDialog.jsx', purpose: 'Delete confirmation with randomized nerd-humor prompts' },
  { file: 'src/components/matrix/RebuildDocDialog.jsx', purpose: 'View/download/regenerate this rebuild blueprint' },
  { file: 'src/components/matrix/HelpToggle.jsx', purpose: 'Toggles help mode for first-time user instructional overlays' },
  { file: 'src/components/matrix/HelpHint.jsx', purpose: 'Contextual help hint popover for specific UI elements' },
  { file: 'src/components/matrix/BuildStamp.jsx', purpose: 'Displays last build timestamp' },
  { file: 'src/components/matrix/CacheRefreshStamp.jsx', purpose: 'Displays cache refresh status' },
  { file: 'src/components/matrix/DangerZone.jsx', purpose: 'Danger zone settings: delete account' },
  { file: 'src/components/matrix/ConnectionsSection.jsx', purpose: 'Hosting platform credential connections (Cloudflare, Supabase, Vercel, etc.)' },
  { file: 'src/components/matrix/BackendConfigSection.jsx', purpose: 'Backend config: custom domain, API keys' },
  { file: 'src/components/matrix/DnsSetupGuide.jsx', purpose: 'DNS setup guide for custom backend domains' },
  { file: 'src/components/matrix/ExternalSources.jsx', purpose: 'External sources panel for importing data' }
];

const FRONTEND_HOOKS = [
  { file: 'src/hooks/useWorkspace.js', purpose: 'Primary workspace state: projects, files, chat, AI orchestration, export, compile, autonomous build, saveCompiledArtifacts, revert last prompt' },
  { file: 'src/hooks/useGithubConnection.js', purpose: 'Per-user GitHub OAuth connection status, connect/disconnect' },
  { file: 'src/hooks/useDiagnosis.js', purpose: 'AI diagnosis hook: triggers diagnosis, manages loading state, returns results' },
  { file: 'src/hooks/useMorpheusVoice.js', purpose: 'Browser speechSynthesis wrapper: picks deepest en-US voice, pitch 0.8, rate 0.95' },
  { file: 'src/hooks/useSpeechRecognition.js', purpose: 'Browser SpeechRecognition wrapper for voice input' },
  { file: 'src/hooks/usePwaInstall.js', purpose: 'Captures beforeinstallprompt for PWA installation' }
];

const SHARED_MODULES = [
  { file: 'base44/shared/projectUtils.ts', purpose: 'Credit costs, logUsage, detectLanguage, createSnapshot, applyFileOperations' },
  { file: 'base44/shared/githubConnection.ts', purpose: 'Per-user GitHub token retrieval via app-user connector (id: 6a8785ad122b26c1461f0f6c)' },
  { file: 'base44/shared/githubPush.ts', purpose: 'GitHub repo creation, blob/tree/commit Git Data API operations with retry logic' },
  { file: 'base44/shared/compileWorkflows.ts', purpose: 'Generates GitHub Actions YAML for each compile target (web-app, python, exe, apk, ios, rpi, arduino, etc.)' },
  { file: 'base44/shared/compileScaffolding.ts', purpose: 'Pre-compile validation + auto-scaffolding: injects missing config files (gradle.properties, Compose settings, manifests) before the build triggers' },
  { file: 'base44/shared/aiUtils.ts', purpose: 'Routes AI requests to platform default or user-configured custom endpoint (UserSettings ai_mode/ai_base_url/ai_api_key/ai_model + per-role model overrides)' },
  { file: 'base44/shared/stripeUtils.ts', purpose: 'Stripe product/price creation and webhook helpers' },
  { file: 'base44/shared/diagnosis.ts', purpose: 'AI diagnosis engine: analyzes build/deploy errors, classifies critical vs non-critical, generates auto-fixes' },
  { file: 'base44/shared/reviewer.ts', purpose: 'Code review agent: checks generated code before commit, flags critical issues for chat escalation' },
  { file: 'base44/shared/toolchain.ts', purpose: 'Build toolchain detection and configuration per compile target' },
  { file: 'base44/shared/costEstimate.ts', purpose: 'Estimates LLM compute cost in USD per model and token count for usage transparency' },
  { file: 'base44/shared/infrastructureComponents.ts', purpose: 'Infrastructure component templates for backend deployment (Supabase, Vercel, Cloudflare, Railway, Render, Fly.io)' },
  { file: 'base44/shared/healthCheck.ts', purpose: 'Health check utilities for deployed backend services' },
  { file: 'base44/shared/buildLogs.ts', purpose: 'Build log fetching and parsing from GitHub Actions runs' }
];

function fmtDate() {
  return new Date().toISOString();
}

function schemaToMarkdown(name: string, schema: any): string {
  if (!schema) return `### ${name}\n_Schema unavailable_\n`;
  const props = schema.properties || {};
  const required = schema.required || [];
  const lines = [`### ${name}`, ''];
  const tableRows = ['| Field | Type | Required | Default |', '|---|---|---|---|'];
  for (const [key, val] of Object.entries(props)) {
    const type = Array.isArray((val as any).type) ? (val as any).type.join(' | ') : (val as any).type || 'string';
    const req = required.includes(key) ? '✓' : '';
    const def = (val as any).default !== undefined ? JSON.stringify((val as any).default) : '';
    const enumStr = (val as any).enum ? ` (enum: ${(val as any).enum.join(', ')})` : '';
    tableRows.push(`| ${key} | ${type}${enumStr} | ${req} | ${def} |`);
  }
  // Built-in fields
  tableRows.push('| id | string | ✓ (auto) | — |');
  tableRows.push('| created_date | string | ✓ (auto) | — |');
  tableRows.push('| updated_date | string | ✓ (auto) | — |');
  tableRows.push('| created_by_id | string | ✓ (auto) | — |');
  lines.push(tableRows.join('\n'), '');
  if (schema.rls) {
    lines.push(`**RLS:** ${JSON.stringify(schema.rls)}`, '');
  }
  return lines.join('\n');
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // Fetch live entity schemas
    const schemas: Record<string, any> = {};
    for (const name of ENTITY_NAMES) {
      try {
        schemas[name] = await base44.entities[name].schema();
      } catch {
        schemas[name] = null;
      }
    }

    const now = fmtDate();
    const version = `${now}`;

    // Build the comprehensive document
    const md: string[] = [];
    md.push(`# MORPHEUS — STANDALONE REBUILD BLUEPRINT`);
    md.push(``);
    md.push(`> Generated: ${now}`);
    md.push(`> Version: ${version}`);
    md.push(``);
    md.push(`This document is a complete, self-contained blueprint for rebuilding Morpheus as a standalone, self-hosted application — independent of the Base44 platform. Drop this file (and the published APK) into any AI agent to reconstruct the full stack.`);
    md.push(``);
    md.push(`---`);
    md.push(``);
    md.push(`## 1. PURPOSE`);
    md.push(``);
    md.push(`Morpheus is a Matrix-themed, chat-driven development environment. Users converse with an AI mentor ("Morpheus") to build real software projects. The AI writes files into a database, which can be exported as ZIP, pushed to GitHub, or compiled into platform-native binaries via GitHub Actions. Includes a template marketplace with Stripe payments and an 80/20 seller revenue split.`);
    md.push(``);
    md.push(`## 2. ARCHITECTURE OVERVIEW`);
    md.push(``);
    md.push(`| Layer | Technology | Standalone Replacement |`);
    md.push(`|---|---|---|`);
    md.push(`| Frontend | React 18 + Tailwind CSS + Vite | Keep as-is (static SPA) |`);
    md.push(`| Backend | Base44 serverless functions (Deno) | Node.js + Express routes |`);
    md.push(`| Database | Base44 entity store | PostgreSQL or MongoDB |`);
    md.push(`| Auth | Base44 Auth (JWT + OAuth) | JWT + Google OAuth (Passport.js) |`);
    md.push(`| AI | Base44 AI Gateway (InvokeLLM) | OpenAI API or any OpenAI-compatible endpoint |`);
    md.push(`| Payments | Stripe (live mode) | Stripe (keep as-is) |`);
    md.push(`| GitHub | Per-user OAuth connector | GitHub OAuth App (per-user tokens) |`);
    md.push(`| Voice | Browser speechSynthesis | Keep as-is (client-side) |`);
    md.push(`| Builds | GitHub Actions | Keep as-is (free tier) |`);
    md.push(``);
    md.push(`## 3. DATA MODEL (ENTITY SCHEMAS)`);
    md.push(``);
    md.push(`All data is stored in 8 entities (+ built-in User). Below are the live schemas fetched from the database at generation time.`);
    md.push(``);
    for (const name of ENTITY_NAMES) {
      md.push(schemaToMarkdown(name, schemas[name]));
    }
    md.push(``);
    md.push(`## 4. BACKEND FUNCTIONS (${BACKEND_FUNCTIONS.length} total)`);
    md.push(``);
    md.push(`Each Base44 function maps to a standalone Express route. The function name becomes the route path (e.g., \`/functions/chatWithMorpheus\` → \`POST /api/chat\`).`);
    md.push(``);
    for (const fn of BACKEND_FUNCTIONS) {
      md.push(`### ${fn.name}`);
      md.push(`- **Purpose:** ${fn.purpose}`);
      md.push(`- **Input:** \`${fn.input}\``);
      md.push(`- **Output:** \`${fn.output}\``);
      md.push(``);
    }
    md.push(`## 5. FRONTEND STRUCTURE`);
    md.push(``);
    md.push(`### Pages`);
    for (const p of FRONTEND_PAGES) {
      md.push(`- \`${p.file}\` — ${p.purpose}`);
    }
    md.push(``);
    md.push(`### Components`);
    for (const c of FRONTEND_COMPONENTS) {
      md.push(`- \`${c.file}\` — ${c.purpose}`);
    }
    md.push(``);
    md.push(`### Hooks`);
    for (const h of FRONTEND_HOOKS) {
      md.push(`- \`${h.file}\` — ${h.purpose}`);
    }
    md.push(``);
    md.push(`### Shared Backend Modules`);
    for (const s of SHARED_MODULES) {
      md.push(`- \`${s.file}\` — ${s.purpose}`);
    }
    md.push(``);
    md.push(`## 6. INTEGRATIONS`);
    md.push(``);
    md.push(`### GitHub (Per-User OAuth)`);
    md.push(`- Each app user connects their own GitHub account via OAuth.`);
    md.push(`- Connector ID: \`6a8785ad122b26c1461f0f6c\``);
    md.push(`- Token retrieval: \`base44.asServiceRole.connectors.getCurrentAppUserConnection(connectorId)\` → \`{ accessToken }\``);
    md.push(`- Standalone: Register a GitHub OAuth App, store tokens per user in the database, use \`Authorization: Bearer <token>\` for API calls.`);
    md.push(`- API base: \`https://api.github.com\``);
    md.push(`- Headers: \`Authorization: Bearer <token>\`, \`Accept: application/vnd.github+json\`, \`X-GitHub-Api-Version: 2022-11-28\``);
    md.push(``);
    md.push(`### Stripe (Live Mode)`);
    md.push(`- Secrets: \`STRIPE_SECRET_KEY\`, \`STRIPE_PUBLISHABLE_KEY\`, \`STRIPE_WEBHOOK_SECRET\``);
    md.push(`- Webhook endpoint: \`https://<host>/functions/stripeWebhook\``);
    md.push(`- Revenue split: 80% seller / 20% platform, stored on Purchase records.`);
    md.push(`- Checkout: Server-side Stripe Checkout sessions with \`metadata.base44_app_id\`.`);
    md.push(``);
    md.push(`### AI Gateway`);
    md.push(`- Platform: \`base44.asServiceRole.integrations.Core.InvokeLLM({ prompt, response_json_schema?, model? })\``);
    md.push(`- Custom (user-configured): UserSettings entity stores \`ai_mode\`, \`ai_base_url\`, \`ai_api_key\`, \`ai_model\`. When \`ai_mode === 'custom'\`, requests route to the user endpoint.`);
    md.push(`- Standalone: Use OpenAI API or any OpenAI-compatible endpoint. The chat function sends the user message + current project files as context and expects file operations back in JSON.`);
    md.push(``);
    md.push(`### Browser Voice (TTS)`);
    md.push(`- Uses \`window.speechSynthesis\` (no server cost).`);
    md.push(`- Picks deepest en-US voice, pitch 0.8, rate 0.95.`);
    md.push(``);
    md.push(`## 7. BUILD / COMPILE PROCESS`);
    md.push(``);
    md.push(`GitHub Actions compiles projects into native binaries. The workflow YAML is generated server-side (\`compileWorkflows.ts\`) based on the compile target. Pre-compile scaffolding (\`compileScaffolding.ts\`) auto-generates missing config files before the build triggers.`);
    md.push(``);
    md.push(`| Target | Runner | Build Tool | Artifact |`);
    md.push(`|---|---|---|---|`);
    md.push(`| web-app | ubuntu-latest | npm + vite build | dist/ ZIP |`);
    md.push(`| python-package | ubuntu-latest | pyinstaller | .whl / binary |`);
    md.push(`| windows-exe | ubuntu-latest | @yao-pkg/pkg | .exe |`);
    md.push(`| linux-binary | ubuntu-latest | @yao-pkg/pkg | ELF binary |`);
    md.push(`| mac-app | macos-latest | @yao-pkg/pkg | .app |`);
    md.push(`| android-apk | ubuntu-latest | Gradle + Compose (build.gradle) | .apk |`);
    md.push(`| ios-app | macos-latest | xcodebuild | .ipa |`);
    md.push(`| rpi-distro | ubuntu-latest | pi-gen | .img |`);
    md.push(`| arduino-firmware | ubuntu-latest | arduino-cli | .hex / .bin |`);
    md.push(``);
    md.push(`### Compile Pipeline Flow`);
    md.push(`1. **\`compileProject\`** — Scaffolds project files (validates structure, injects missing configs), creates a unique build repo, pushes source + generated GitHub Actions workflow YAML, triggers a \`workflow_dispatch\` event.`);
    md.push(`2. **\`getCompileStatus\`** — Polls the GitHub Actions run. While in progress, fetches job steps for a step-level progress counter (e.g. "STEP 4/13"). On failure, extracts error-relevant log lines (not just the tail) and fetches real job logs for AI diagnosis. On success, fetches the GitHub Release and its downloadable assets.`);
    md.push(`3. **\`saveCompiledArtifacts\`** — After a successful compile, downloads the release assets from the build repo and saves them as \`ProjectFile\` records under \`_compiled/\` (e.g. \`_compiled/release.apk\`). These appear in the file tree with a PKG icon and a download card in the file viewer.`);
    md.push(`4. **\`diagnoseIssue\`** — If the build fails, the AI diagnosis agent analyzes the extracted error logs, auto-fixes critical issues (regenerating affected files), and escalates remaining issues to the main Morpheus chat for interactive fixing.`);
    md.push(``);
    md.push(`### Pre-Compile Scaffolding (\`compileScaffolding.ts\`)`);
    md.push(`- **Android**: Validates AndroidManifest.xml, injects \`gradle.properties\` (AndroidX, Jetifier, JVM args, Compose compiler), \`settings.gradle\`, \`proguard-rules.pro\`, Compose build features. Auto-detects Jetpack Compose usage by scanning for \`@Composable\`.`);
    md.push(`- **Web**: Ensures \`index.html\`, \`package.json\`, Vite config exist.`);
    md.push(`- **Python**: Ensures \`requirements.txt\`, \`setup.py\`, entry point exist.`);
    md.push(`- **iOS**: Ensures \`Package.swift\` or Xcode project structure.`);
    md.push(`- **RPi / Arduino**: Ensures appropriate manifest and entry files.`);
    md.push(``);
    md.push(`### GitHub Actions Caching`);
    md.push(`- npm, pip, and Gradle caches are configured in the workflow YAML to speed up build cycles.`);
    md.push(``);
    md.push(`### Autonomous Pipeline`);
    md.push(`- The PipelineRunner component orchestrates: compile → AI fix (if error) → ask Morpheus (if AI fix fails), with a visual timer and stop capability.`);
    md.push(`- When the review agent identifies critical issues, they are automatically sent to the main Morpheus chat for interactive fixing rather than looping.`);
    md.push(``);
    md.push(`## 8. ENVIRONMENT VARIABLES / SECRETS`);
    md.push(``);
    md.push(`| Variable | Purpose |`);
    md.push(`|---|---|`);
    md.push(`| \`STRIPE_SECRET_KEY\` | Stripe API authentication |`);
    md.push(`| \`STRIPE_PUBLISHABLE_KEY\` | Stripe client-side checkout |`);
    md.push(`| \`STRIPE_WEBHOOK_SECRET\` | Stripe webhook signature verification |`);
    md.push(`| \`BASE44_APP_ID\` | App ID for Stripe metadata tracking |`);
    md.push(`| \`GITHUB_CONNECTOR_ID\` | Per-user GitHub OAuth connector ID |`);
    md.push(``);
    md.push(`## 9. STANDALONE RECONSTRUCTION GUIDE`);
    md.push(``);
    md.push(`To rebuild Morpheus without Base44:`);
    md.push(``);
    md.push(`### Step 1: Database`);
    md.push(`Create tables/collections matching the entity schemas in Section 3. Use PostgreSQL with UUID primary keys, or MongoDB with ObjectId. Include \`created_date\`, \`updated_date\`, \`created_by_id\` on every table.`);
    md.push(``);
    md.push(`### Step 2: Backend`);
    md.push(`Port each function from Section 4 to an Express route. Replace \`base44.entities.X\` calls with your ORM/DB client. Replace \`base44.asServiceRole.integrations.Core.InvokeLLM\` with direct OpenAI API calls. Keep the shared modules (Section 5) as utility files.`);
    md.push(``);
    md.push(`### Step 3: Frontend`);
    md.push(`Replace \`import { base44 } from '@/api/base44Client'\` with a custom API client (\`fetch\` or \`axios\`). Replace entity calls (\`base44.entities.X.list()\`) with \`GET /api/X\`. Replace auth calls with your JWT client. The rest of the React/Tailwind UI stays unchanged.`);
    md.push(``);
    md.push(`### Step 4: Auth`);
    md.push(`Implement JWT-based auth: \`POST /api/auth/register\`, \`POST /api/auth/login\`, \`POST /api/auth/verify-otp\`. Add Google OAuth via Passport.js. Store sessions as JWT tokens.`);
    md.push(``);
    md.push(`### Step 5: Integrations`);
    md.push(`- GitHub: Register an OAuth App, implement \`/api/github/callback\`, store tokens per user.`);
    md.push(`- Stripe: Keep \`STRIPE_SECRET_KEY\` server-side, implement webhook at \`/api/stripe/webhook\`.`);
    md.push(`- AI: Use OpenAI API or allow users to configure custom endpoints (UserSettings entity).`);
    md.push(``);
    md.push(`### Step 6: Builds`);
    md.push(`Keep the GitHub Actions workflow generation (\`compileWorkflows.ts\`) as-is. The build process is platform-agnostic — it only needs a GitHub token and the project files.`);
    md.push(``);
    md.push(`### Step 7: Deploy`);
    md.push(`- Frontend: Build with Vite (\`npm run build\`), serve \`dist/\` as static files.`);
    md.push(`- Backend: Run Express server (\`node server.js\`).`);
    md.push(`- Database: Run PostgreSQL/MongoDB.`);
    md.push(`- Set environment variables (Section 8).`);
    md.push(``);
    md.push(`---`);
    md.push(``);
    md.push(`_This blueprint is auto-generated. Regenerate it from the workspace REBUILD button to capture the latest entity schemas and architecture._`);
    md.push(``);

    const content = md.join('\n');
    const contentSize = content.length;

    // Upload the full blueprint as a file so it can exceed the entity field
    // size limit. Store a truncated preview in `content` and the full file
    // URL in `file_url`.
    const blob = new Blob([content], { type: 'text/markdown' });
    const file = new File([blob], `morpheus-rebuild-${version.replace(/[:.]/g, '-')}.md`, { type: 'text/markdown' });
    const { file_url } = await base44.integrations.Core.UploadFile({ file });
    const preview = content.length > 2000 ? content.substring(0, 2000) + '\n\n... [Full blueprint in file_url]' : content;

    // Upsert: find existing doc, update or create
    const existing = await base44.entities.RebuildDoc.list('-created_date', 1);
    let doc;
    if (existing.length > 0) {
      doc = await base44.entities.RebuildDoc.update(existing[0].id, {
        version,
        content: preview,
        content_size: contentSize,
        file_url
      });
    } else {
      doc = await base44.entities.RebuildDoc.create({
        version,
        content: preview,
        content_size: contentSize,
        file_url
      });
    }

    await logUsage(base44, 'chat_simple', '', 'rebuild-doc', { version, contentSize });

    return Response.json({
      version,
      contentSize,
      docId: doc.id,
      updated: true
    });
  } catch (error) {
    console.error('generateRebuildDoc error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
}