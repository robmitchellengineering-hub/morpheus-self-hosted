# Morpheus — Backend Functions Reference

> **Purpose:** Complete documentation of every backend function in the Morpheus platform — its logic, inputs, outputs, and internal flow. For future developers maintaining or extending the platform.
>
> **Location:** `base44/functions/{functionName}/entry.ts`
> **Runtime:** Deno serverless functions on Base44
> **Total functions:** 35

---

## Table of Contents

1. [AI Chat & Autonomous Build](#1-ai-chat--autonomous-build)
2. [GitHub Integration](#2-github-integration)
3. [Compile Pipeline](#3-compile-pipeline)
4. [Backend Architecture](#4-backend-architecture)
5. [Marketplace & Payments](#5-marketplace--payments)
6. [Usage & Account](#6-usage--account)
7. [Snapshots & Docs](#7-snapshots--docs)
8. [Voice & Prototyping](#8-voice--prototyping)
9. [Shared Modules](#9-shared-modules)

---

## 1. AI Chat & Autonomous Build

### chatWithMorpheus
**Path:** `base44/functions/chatWithMorpheus/entry.ts`

The core conversational AI. Sends the user's message + current project files + full conversation history to the LLM, receives file operations (create/edit/delete), applies them to the database, and returns Morpheus's reply.

**Input:** `{ projectId, message, fileUrls }`
**Output:** `{ reply, fileOperations, appliedOps }`

**Logic:**
1. Authenticates the user and loads the project + all ProjectFile records.
2. Loads the ENTIRE ChatMessage history (perpetual memory — every message ever sent in this project).
3. Builds a context block: project name, description, compile target, all current files, and full conversation history.
4. **Phase 1 — Planner:** Invokes the high-think planner model to analyze the request, decide what files need creating/updating/deleting, and produce a precise build plan. The planner is instructed to output only JSON with `assessment`, `plan`, and `fileOperations`.
5. **Phase 2 — Coder:** Invokes the fast coder model with the planner's plan to generate the actual file contents. Each file operation has `{ path, content, action }`.
6. **Phase 3 — Reviewer:** Runs `reviewAndRetry` on the generated files — checks for critical issues (syntax errors, missing imports, broken logic) and retries up to 2 times if critical issues are found. Critical issues are flagged with `// CRITICAL` in the reply.
7. **Phase 4 — UI Polish (optional):** If `project.polish_ui` is true, runs an extra pass that refines only styling files (CSS, Tailwind classes, spacing).
8. Applies all file operations via `applyFileOperations` (handles large file offloading to storage).
9. Creates a ChatMessage record with Morpheus's reply.
10. Logs usage with toolchain info (provider, models used, client tools).

**Key design:** Two-phase (plan → code) with a review gate. The planner reasons about architecture; the coder implements. This prevents the coder from making design decisions mid-stream.

---

### autonomousBuildStep
**Path:** `base44/functions/autonomousBuildStep/entry.ts`

Runs one step of the autonomous build loop. The frontend `AutonomousPanel` calls this repeatedly until the project is complete.

**Input:** `{ projectId, spec }`
**Output:** `{ reply, fileOperations, isComplete, truncated, reviewStatus, outputMetrics }`

**Logic:**
1. Loads project, files, and full conversation history.
2. Creates a snapshot (for revert capability).
3. **Phase 1 — Planner:** High-think model analyzes the current state and produces a build plan. Key constraint: budgets output to 4-5 files per step (the coder has a ~16K token output window). If the previous step was truncated, the planner is told to plan only 2 files. Returns `{ assessment, plan, isComplete }`.
4. If `isComplete` is true (planner says project is already production-ready), skips the coder and returns immediately with status `ready`.
5. **Phase 2 — Coder:** Fast model implements the plan — writes 4-5 files max. If the output is truncated (token limit hit), catches the `OUTPUT_TRUNCATED` error and signals the panel to reduce batch size.
6. **Phase 3 — Reviewer:** `reviewAndRetry` checks the generated files. Critical issues are returned in `reviewStatus` so the panel can feed them back for auto-fixing.
7. Applies file operations, creates a ChatMessage, updates project status (`building` or `ready`).
8. Returns output metrics (tokens per phase) for the UI to display.

**Key design:** The `truncated` flag tells the panel to continue with a smaller batch — the loop self-corrects when the coder tries to write too much at once.

---

### generateTests
**Path:** `base44/functions/generateTests/entry.ts`

Analyzes project files and generates a complete test suite + CI pipeline.

**Input:** `{ projectId, spec }`
**Output:** `{ reply, fileOperations, testCount }`

**Logic:**
1. Loads project files. Fails if no files exist.
2. Creates a snapshot before test generation.
3. Sends all files to the coder model with a detailed prompt that detects the project's language/framework/test runner and generates real test files (no placeholders, no skipped tests).
4. Generates a CI config file (`.github/workflows/ci.yml`) appropriate to the platform (jest/vitest for JS, pytest for Python, cargo test for Rust, etc.).
5. Runs `reviewAndRetry` on the generated test files.
6. Applies file operations and creates a ChatMessage with `[TESTS]` prefix.

---

### updateDependencies
**Path:** `base44/functions/updateDependencies/entry.ts`

Scans project files for dependency manifests and updates all packages to their latest versions across 8 ecosystems.

**Input:** `{ projectId }`
**Output:** `{ reply, fileOperations, updatedCount, updates }`

**Logic:**
1. Creates a snapshot before updating.
2. Iterates every file against a registry of updaters (one per manifest format):
   - **npm** — `package.json` (deps, devDeps, peerDeps, optionalDeps)
   - **pip** — `requirements.txt` and `pyproject.toml` (PEP-621 arrays)
   - **Maven** — `pom.xml` and Gradle `build.gradle`/`build.gradle.kts`
   - **Cargo** — `Cargo.toml`
   - **Go** — `go.mod`
   - **Gem** — `Gemfile`
   - **Composer** — `composer.json`
   - **PlatformIO** — `platformio.ini` lib_deps
3. Each updater parses its manifest, looks up latest versions on the relevant registry (npmjs.org, pypi.org, Maven Central + Google Maven, crates.io, Go proxy, rubygems.org, packagist.org, PlatformIO registry), and rewrites the file.
4. Uses an in-memory cache so a package appearing in multiple sections is only fetched once.
5. Flags major-version bumps as `breaking: true` so the user is warned.
6. Per-ecosystem cap of 200 packages to prevent timeout.
7. Updates each manifest file in the database and returns a summary grouped by ecosystem.

---

### diagnoseIssue
**Path:** `base44/functions/diagnoseIssue/entry.ts`

Unified AI diagnosis agent. Analyzes errors across the entire platform (deploy, compile, github, build), auto-fixes code-level issues, and returns a structured action plan.

**Input:** `{ type, projectId, errorContext, components }`
- `type`: `'deploy' | 'compile' | 'github' | 'build'`
- `errorContext`: error message, logs, repoUrl, target, step, spec
- `components`: infrastructure components (for deploy diagnosis)

**Output:** `{ diagnosis: { summary, autoFixed, needsUserAction, allClear } }`

**Logic:**
1. Routes to a type-specific diagnoser:
   - **deploy** — Classifies deploy errors as credential errors (→ user action) or code errors (→ auto-fix). Manual deploy results (ZIP, SQL-ready) become user action items with step-by-step instructions.
   - **compile** — Auth errors → user action. Build errors → auto-fix with error logs. If no auto-fix possible, returns GitHub Actions link for manual inspection.
   - **github** — Auth errors, repo name collisions, rate limits → user action with specific steps.
   - **build** — Autonomous build step errors → auto-fix with error context.
2. **Auto-fix engine (`autoFixCodeErrors`):** Sends error context + current project files to the diagnosis model. The model identifies root causes and regenerates broken files with fixes. Runs `reviewAndRetry` on the fix files before applying. Applies fixes via `applyFileFixes`.
3. Returns a structured `Diagnosis` object: `summary`, `autoFixed[]` (each with component, issue, fix, fileCount), `needsUserAction[]` (each with component, label, issue, steps, link, severity), and `allClear` boolean.

---

## 2. GitHub Integration

### checkGithubConnection
**Path:** `base44/functions/checkGithubConnection/entry.ts`

Verifies the user's per-user GitHub OAuth connection.

**Input:** `{}` (no body)
**Output:** `{ connected, login }`

**Logic:**
1. Gets the app-user GitHub token via `getAppUserGithubToken` (connector ID: `6a8785ad122b26c1461f0f6c`).
2. If no token, returns `{ connected: false }`.
3. Fetches `GET /user` from the GitHub API to verify the token is valid.
4. Returns `{ connected: true, login: <github_username> }`.

---

### uploadToGithub
**Path:** `base44/functions/uploadToGithub/entry.ts`

Creates a GitHub repo (or reuses existing) and pushes all project files + a generated BUILD_LOG.md.

**Input:** `{ projectId, repoName, isPrivate }`
**Output:** `{ repoUrl, fileCount }`

**Logic:**
1. Gets the per-user GitHub token.
2. Creates a repo via `createRepo` helper (handles name collisions by appending a suffix).
3. Loads all ProjectFile records for the project.
4. Aggregates build logs via `aggregateBuildLogs` and generates a `BUILD_LOG.md` markdown file.
5. Pushes all files + BUILD_LOG.md via `pushFiles` (Git Data API with retry logic for tree creation).
6. Logs usage.

---

### importFromGithub
**Path:** `base44/functions/importFromGithub/entry.ts`

Fetches a GitHub repo tree recursively, creates a new project, and bulk-imports decoded file contents.

**Input:** `{ repoInput, compileTarget }`
- `repoInput`: `"owner/repo"`, full URL, or `"https://github.com/owner/repo.git"`

**Output:** `{ projectId, projectName, fileCount, skipped, truncated, totalFiles }`

**Logic:**
1. Parses owner/repo from the input (handles URLs, .git suffixes, trailing slashes).
2. Fetches repo info to get the default branch.
3. Fetches the file tree recursively via `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`.
4. Filters out binary files, node_modules, .git, dist/build directories.
5. Caps at 150 files (marks `truncated` if more).
6. Creates a new Project with status `ready`.
7. Fetches each blob via `GET /repos/{owner}/{repo}/git/blobs/{sha}`, decodes base64 content.
8. Bulk-creates ProjectFile records.
9. Creates a ChatMessage with import summary.
10. Logs usage.

---

## 3. Compile Pipeline

### compileProject
**Path:** `base44/functions/compileProject/entry.ts`

Scaffolds project files, creates a build repo on GitHub, pushes files + a generated GitHub Actions workflow, and triggers the build.

**Input:** `{ projectId, dryRun? }`
**Output:** `{ repoFullName, repoUrl, target, status }` or dry-run preview

**Logic:**
1. Loads project and files. Rejects `source` target (use ZIP export instead).
2. Looks up the compile target adapter via `getCompileTarget(target)`. Each adapter handles its own validation, scaffolding, and build-step generation.
3. Checks required secrets (adapter declares `requiredSecrets`) — fails fast if missing.
4. **Validate:** Adapter checks if the project has essential source files.
5. **Scaffold:** Adapter auto-generates missing config files (Gradle properties, manifests, Dockerfile, etc.).
6. **Build steps:** Adapter generates structured build steps → `renderWorkflow` renders them to GitHub Actions YAML.
7. **Dry-run mode:** If `dryRun: true`, returns the scaffolded files, workflow YAML, and artifact spec without pushing to GitHub.
8. Gets the per-user GitHub token, creates a unique repo (`morpheus-build-{slug}-{timestamp}`).
9. Pushes all files + the workflow YAML via `pushFiles`.
10. Polls for workflow registration (up to 8 attempts, 3s apart) — GitHub needs time to index the workflow.
11. Triggers `workflow_dispatch` on the registered workflow.
12. Logs usage and returns repo info.

**Supported targets:** `web-app`, `windows-exe`, `mac-app`, `linux-binary`, `android-apk`, `ios-app`, `python-package`, `rpi-distro`, `linux-distro`, `arduino-firmware`

---

### getCompileStatus
**Path:** `base44/functions/getCompileStatus/entry.ts`

Polls GitHub Actions run status, fetches step-level progress, extracts error context from failed job logs, and fetches release assets on success.

**Input:** `{ repoFullName, target }`
**Output:** `{ status, conclusion, runUrl, message, stepProgress, logs, assets, releaseUrl }`

**Logic:**
1. Gets the per-user GitHub token.
2. Fetches the latest workflow run via `GET /repos/{repo}/actions/runs?per_page=1`.
3. Returns `{ status: 'queued' }` if no runs yet.
4. Maps run status to a human message (`in_progress` → "Compiling...", `completed/success` → "Build complete!", etc.).
5. **Step progress:** While in progress, fetches `GET /repos/{repo}/actions/runs/{runId}/jobs` and extracts the job's steps — counts completed steps, identifies the current in-progress step, and any failed step. Returns `{ completed, total, currentStep }`.
6. **Error extraction on failure:** Fetches failed job logs via `GET /repos/{repo}/actions/jobs/{jobId}/logs` (follows redirect to the text file). Uses `extractErrorContext` to find error-relevant lines (matching error patterns, filtering noise like "Downloading"/"Installing") with 3-line context windows. Falls back to run-level logs if no failed jobs. Uses adapter-specific `errorPatterns` if available (more precise than the generic catch-all).
7. **Release assets on success:** Retries up to 4 times (2s apart) fetching `GET /repos/{repo}/releases/latest`. Returns asset names, download URLs, and sizes.

---

### saveCompiledArtifacts
**Path:** `base44/functions/saveCompiledArtifacts/entry.ts`

Downloads compiled release artifacts from the private GitHub build repo and re-uploads them to Morpheus storage so they appear in the file tree.

**Input:** `{ projectId, repoFullName, target }`
**Output:** `{ saved, files }` or `{ saved, alreadyExists, files }`

**Logic:**
1. Checks if `_compiled/` files already exist for this project (avoids duplicates on re-poll).
2. Gets the per-user GitHub token.
3. Fetches the latest release via `GET /repos/{repo}/releases/latest`.
4. For each release asset:
   - Downloads via `GET /repos/{repo}/releases/assets/{assetId}` with `Accept: application/octet-stream` and `redirect: 'manual'`.
   - Gets the `Location` header (signed CDN URL), then fetches it WITHOUT the Authorization header (the CDN rejects authed requests — this is a known dead-end that was solved).
   - Uploads the binary to Morpheus storage via `UploadFile` with a `.bin` extension (storage blocks certain binary extensions like .apk, .exe).
   - Creates a ProjectFile record at `_compiled/{displayName}` with the `file_url` and a metadata comment in `content`.
5. Uses the adapter's normalized `artifactName` for the primary asset (e.g. `app.apk` instead of the raw GitHub name).

---

### getBuildLogs
**Path:** `base44/functions/getBuildLogs/entry.ts`

Fetches aggregated build logs for a project from UsageRecord metadata.

**Input:** `{ projectId }`
**Output:** `{ logs, projectName, totalEvents }`

**Logic:**
1. Calls `aggregateBuildLogs(base44, projectId)` from the shared `buildLogs.ts` module.
2. Returns the aggregated log array (each entry has `type`, `tool`, `details`, `timestamp`, `credits`, `toolchain`).

---

## 4. Backend Architecture

### planBackend
**Path:** `base44/functions/planBackend/entry.ts`

AI plans the backend architecture: generates database schema, API routes, auth strategy, and infrastructure component recommendations.

**Input:** `{ projectId }`
**Output:** `{ plan, status }`

**Logic:**
1. Loads project files. For frontend projects, analyzes the frontend to identify API calls (fetch, axios), data entities, and auth expectations. For standalone backend projects, uses the project description.
2. Sends to the high-think planner model with a detailed prompt listing all available infrastructure components and their free-tier options.
3. The AI returns a structured plan: `summary`, `database.tables[]`, `api.routes[]`, `auth.strategy`, `storage`, `envVars[]`, `recommendations`, `components[]` (each with type, suggested service, alternatives, reason).
4. Validates AI-suggested component IDs against the known COMPONENTS list — falls back to defaults if the AI hallucinated an invalid service ID.
5. Saves the plan as `backend/.plan.json` in the project files.
6. Logs usage.

---

### generateBackend
**Path:** `base44/functions/generateBackend/entry.ts`

Generates production-ready backend code files from the architecture plan.

**Input:** `{ projectId, components }`
**Output:** `{ fileCount, summary, status }`

**Logic:**
1. Loads the plan from `backend/.plan.json`. Fails if no plan exists.
2. Builds a codegen prompt from the components (includes infrastructure-specific code patterns, env var names).
3. Sends to the coder model with the plan + frontend file summaries (for API contract reference — matches the fetch/axios calls the frontend makes).
4. The AI generates all backend files: server entry point, route handlers, database schema/migrations, auth middleware, config files (package.json, wrangler.toml, Dockerfile, .env.example), README.
5. Runs `reviewAndRetry` on the generated files.
6. Deletes existing backend code files (keeps `.plan.json`).
7. Deduplicates by normalized path (the retry path can return both `api/v1/tasks.js` and `backend/api/v1/tasks.js`).
8. Bulk-creates new ProjectFile records with `backend/` prefix.
9. Logs usage.

---

### wireFrontendToBackend
**Path:** `base44/functions/wireFrontendToBackend/entry.ts**

Auto-wires the frontend to the live backend after a successful deploy.

**Input:** `{ projectId }`
**Output:** `{ apiUrl, configPath, filesChanged, totalReplacements, changes, message }`

**Logic:**
1. Reads the live API URL from `backend/.deploy.json` (the API host result with `status: 'deployed'`).
2. Prefers custom domain (from BackendConfig) over the deploy URL.
3. For standalone backend projects, returns the API URL with no wiring needed.
4. Creates/updates `src/api/config.js` with `export const API_BASE_URL = '<liveUrl>'`.
5. Scans all frontend files (`.js`, `.jsx`, `.ts`, `.tsx`, `.env`):
   - Replaces `http://localhost:PORT` with the live URL.
   - Rewrites relative `/api/` calls to use the full live URL.
   - Updates `.env` files: `VITE_API_URL`, `REACT_APP_API_URL`, `NEXT_PUBLIC_API_URL`, `EXPO_PUBLIC_API_URL`.
6. Updates each changed file in the database.
7. Returns a summary of every file changed and replacement count.

---

### deployBackend
**Path:** `base44/functions/deployBackend/entry.ts`

Deploys generated backend code to the chosen live targets. The largest and most complex function in the platform.

**Input:** `{ projectId, components, dryRun? }`
**Output:** `{ results, deployInfo }` or dry-run validation

**Logic:**
1. Loads project files, filters to `backend/` files (excluding `.plan.json` and `.deploy.json`).
2. **Dry-run:** Validates credentials and file structure (checks for entry point, SQL files) without deploying. Returns warnings for missing creds/entry point.
3. Reads per-user hosting credentials from UserSettings.connections (JSON string).
4. Reads backend config (custom domain + API key hashes).
5. **Deploys each component:**
   - **API host** — Routes to a platform-specific deployer:
     - `cloudflare-workers` — Uploads the main worker file via FormData to the Workers API. Returns the `.workers.dev` URL.
     - `vercel` — Uploads each file (SHA-256 digest) to Vercel's file API, then creates a production deployment referencing those SHAs.
     - `netlify` — Creates a site (if no site_id), uses the atomic deploy API (sends SHA-1 hashes, Netlify responds with which files need uploading, uploads each).
     - `railway` — Pushes code to GitHub, creates a Railway project + service from the repo via GraphQL API.
     - `render` — Pushes code to GitHub, creates a Render web service via REST API.
     - `fly` — Pushes code + a deploy workflow to GitHub, sets `FLY_API_TOKEN` as a GitHub secret (encrypted), triggers the workflow.
     - Others — Returns ZIP + dashboard link for manual deploy.
   - **Database** — `supabase-pg`: executes SQL migrations via Supabase Management API. Others: returns SQL + editor link for manual execution.
   - **Auth/Storage/Cache** — Code-level integrations, returns dashboard links for verification.
6. **Post-deploy health check:** Pings each deployed URL to verify it's live. Async-build platforms (Railway/Render/Fly) may show `building` status.
7. **Backend config application:** Applies custom domain + API keys to deployed services:
   - Cloudflare Workers: sets `API_KEYS` secret + configures custom domain route.
   - Vercel: sets env var + adds custom domain.
   - Others: returns platform-specific manual instructions with dashboard deep-links.
8. Stores deploy metadata in `backend/.deploy.json` for log retrieval.
9. Logs usage.

---

### checkDeployHealth
**Path:** `base44/functions/checkDeployHealth/entry.ts`

Pings a deployed backend URL and returns its health status.

**Input:** `{ url?, projectId? }`
**Output:** `{ url, healthy, statusCode, responseTimeMs, error, attempts }`

**Logic:**
1. If no URL provided, looks up the deploy metadata:
   - First checks BackendConfig for a custom domain.
   - Falls back to the first deployed component's URL from `backend/.deploy.json`.
2. Normalizes the URL (ensures protocol).
3. Calls `checkHealth` with 3 retries, 2s delay, 8s timeout.
4. Returns health status, status code, response time, and error (if any).

---

### getBackendLogs
**Path:** `base44/functions/getBackendLogs/entry.ts`

Pulls runtime logs from deployed backend platforms.

**Input:** `{ projectId, platform? }`
**Output:** `{ platform, logs, dashboardUrl, status }`

**Logic:**
1. Reads deploy metadata from `backend/.deploy.json`.
2. Reads user connections from UserSettings.
3. Routes to a platform-specific log fetcher:
   - **cloudflare-workers** — Checks script health/settings (Tail API is WebSocket-only, so returns status + `wrangler tail` instructions).
   - **supabase** — Pulls database log stats via Management API.
   - **render** — Pulls service logs via REST API (`GET /v1/services/{id}/logs`).
   - **vercel** — Pulls deployment logs via REST API.
   - **netlify** — Lists recent deploys and site status.
   - **railway** — Queries recent deployments via GraphQL API.
   - **fly** — Checks app/machine status via the Fly.io API (log streaming requires `flyctl logs`).
   - Others — Returns dashboard link with "not supported" message.
4. Returns log lines + dashboard URL for manual log viewing.

---

### manageBackendConfig
**Path:** `base44/functions/manageBackendConfig/entry.ts`

Manages per-project backend configuration: custom domain and API keys.

**Input:** `{ projectId, action, ... }`
- `action: 'get'` — returns current config
- `action: 'set_domain'` — sets custom domain (pass `custom_domain`)
- `action: 'generate_key'` — creates a new API key (pass `name`)
- `action: 'revoke_key'` — marks a key inactive (pass `keyId`)

**Output:** Varies by action.

**Logic:**
- **get** — Returns `{ custom_domain, api_keys: [{id, name, prefix, created_date, active}] }`. API key hashes are never exposed — only the prefix.
- **set_domain** — Strips protocol/trailing slash, saves to BackendConfig.
- **generate_key** — Generates `mk_<48hex>`, stores SHA-256 hash (never plaintext), returns the full key ONCE. The prefix (`mk_xxxxxxxx`) is stored for later identification.
- **revoke_key** — Sets `active: false` on the key by id.

---

## 5. Marketplace & Payments

### publishTemplate
**Path:** `base44/functions/publishTemplate/entry.ts`

Publishes a project as a marketplace template.

**Input:** `{ projectId, tags, category, price, screenshots, icon, long_description }`
**Output:** `{ templateId, name, fileCount, price }`

**Logic:**
1. Validates price: paid templates must be ≥ $0.50 (Stripe minimum checkout amount). Free = $0.
2. Loads all project files, maps them to `{ path, content, language }`.
3. Creates a Template entity with the files as a JSON string, author info, compile target, tags, category, screenshots, icon.
4. If paid, creates a Stripe product + price via `stripeFetch` with `metadata.base44_app_id` and `metadata.template_id`.
5. Updates the template with the `stripe_price_id`.
6. Logs usage.

---

### browseTemplates
**Path:** `base44/functions/browseTemplates/entry.ts`

Lists marketplace templates with optional category and search filtering. Public — auth optional.

**Input:** `{ category?, q? }` (both optional)
**Output:** `{ templates, categories }`

**Logic:**
1. Auth is optional — if authenticated, includes `mine` and `purchased` flags.
2. Fetches all templates via service role (public read).
3. If authenticated, fetches the user's purchases to mark which templates they own.
4. Filters by category (if not 'all') and search query (matches name, description, tags).
5. Returns template list with metadata (id, name, description, author, icon, compile_target, tags, category, install_count, file_count, price, `mine`, `purchased`).
6. Returns the list of unique categories.

---

### getPublicTemplate
**Path:** `base44/functions/getPublicTemplate/entry.ts`

Returns template details for the public store detail page. Public — no auth required.

**Input:** `{ templateId }`
**Output:** `{ id, name, description, long_description, author_name, icon, screenshots, compile_target, tags, category, install_count, file_count, price, files }`

**Logic:**
1. Fetches the template via service role.
2. Parses screenshots from JSON string.
3. For **free** templates, includes the `files` JSON so the frontend can offer a ZIP download.
4. For **paid** templates, withholds files — they are only released after purchase verification.

---

### installTemplate
**Path:** `base44/functions/installTemplate/entry.ts`

Creates a new project from a template (free or after purchase verification).

**Input:** `{ templateId, projectName? }`
**Output:** `{ projectId, projectName, fileCount }`

**Logic:**
1. Loads the template.
2. For paid templates (price > 0 and not owned by the user), checks for a completed Purchase record. Returns `{ error: 'Payment required', requiresPayment: true, price }` with status 402 if not purchased.
3. Creates a new Project with the template's name/description/compile target.
4. Parses the template's files JSON and bulk-creates ProjectFile records.
5. Increments the template's install count via service role (the installer isn't the author, so an owner-scoped update rule would block a user-context call).
6. Logs usage.

---

### downloadTemplate
**Path:** `base44/functions/downloadTemplate/entry.ts`

Public endpoint — verifies a Stripe checkout session was paid, then releases the template files. Handles the race condition where the Stripe redirect arrives before the webhook processes.

**Input:** `{ sessionId, templateId }`
**Output:** `{ files, name, compile_target }`

**Logic:**
1. **Fast path:** Checks if a Purchase record already exists (webhook processed first). If found and matches the template, proceeds.
2. **Fallback:** If no Purchase record, verifies the session directly with the Stripe API (`GET /checkout/sessions/{sessionId}`). Checks `payment_status === 'paid'` and that the session's `metadata.template_id` matches.
3. Creates the Purchase record now (webhook may still arrive later — idempotency check in the webhook handles duplicates). Computes the 80/20 revenue split via `computeSplit`.
4. Increments the template's install count (non-critical).
5. Returns the template's files JSON, name, and compile target.

---

### createTemplateCheckout
**Path:** `base44/functions/createTemplateCheckout/entry.ts`

Creates a Stripe Checkout session for purchasing a template.

**Input:** `{ templateId, buyerId?, buyerEmail?, successUrl, cancelUrl }`
**Output:** `{ url }` (Stripe Checkout URL)

**Logic:**
1. Loads the template. Validates it has a price and a `stripe_price_id`.
2. **Self-healing:** If the stored Stripe price ID has been deleted or points to another account, regenerates it from the template's stored price. Creates a new product + price, updates the template.
3. Creates a Stripe Checkout session with:
   - `mode: 'payment'`, the price ID, quantity 1.
   - `success_url` and `cancel_url` from the request.
   - `client_reference_id` and `customer_email` (optional — anonymous buyers can purchase).
   - `metadata` with `base44_app_id`, `template_id`, `buyer_id`, `seller_id`, `template_name`, `amount`.
4. Translates the raw Stripe minimum-amount error into a clear message if the template is mispriced.
5. Returns the Checkout URL.

---

### stripeWebhook
**Path:** `base44/functions/stripeWebhook/entry.ts`

Receives Stripe webhook events and records purchases with the 80/20 revenue split.

**Input:** Stripe event body (raw) + `stripe-signature` header
**Output:** `{ received: true }`

**Logic:**
1. Reads `STRIPE_WEBHOOK_SECRET` from secrets.
2. Verifies the Stripe signature: parses the `t` and `v1` components, checks timestamp is within ±300s, computes HMAC-SHA-256 of `{timestamp}.{rawBody}`, compares to the provided signature.
3. Only processes `checkout.session.completed` events — ignores all others.
4. Extracts `template_id`, `buyer_id`, `seller_id`, `template_name` from session metadata.
5. Computes the 80/20 revenue split via `computeSplit`.
6. **Idempotency:** Checks if a Purchase with this `stripe_session_id` already exists. If not, creates one with `status: 'paid'`.
7. Returns `{ received: true }`.

---

### getSellerStats
**Path:** `base44/functions/getSellerStats/entry.ts`

Aggregates seller earnings from purchases.

**Input:** `{}` (no body)
**Output:** `{ templateCount, totalSales, totalRevenue, totalPlatformCut, totalSellerCut, refunds, perTemplate, recentSales }`

**Logic:**
1. Fetches all templates authored by the current user.
2. Fetches recent purchases (up to 500) and filters to those matching the user's template IDs.
3. Aggregates: total sales count, total revenue, platform cut, seller cut, refunds.
4. Per-template breakdown: sales, revenue, seller cut, price, installs.
5. Recent sales (last 20) with template name, amount, cuts, status, date.

---

## 6. Usage & Account

### getUsageStats
**Path:** `base44/functions/getUsageStats/entry.ts`

Aggregates usage records for the current user with estimated USD costs.

**Input:** `{}` (no body)
**Output:** `{ byType, totalCredits, totalActions, totalUsd, platformUsd, customUsd }`

**Logic:**
1. Fetches the last 500 UsageRecord entries.
2. Groups by `action_type`: count, credits, estimated USD cost (via `estimateActionCost`).
3. Splits USD by provider: platform vs custom (parsed from metadata).
4. Returns totals + per-type breakdown + recent 20 actions.

---

### emailProjectFiles
**Path:** `base44/functions/emailProjectFiles/entry.ts`

Emails a project ZIP download link to a specified address.

**Input:** `{ fileUrl, projectName, email }`
**Output:** `{ sent: true }`

**Logic:**
1. Uses the Core `SendEmail` integration (service role) to send an email with the project name, a download link to the pre-uploaded ZIP, and a Morpheus-branded footer.
2. Logs usage.

---

### deleteAccount
**Path:** `base44/functions/deleteAccount/entry.ts`

Permanently deletes all data associated with the calling user's account.

**Input:** `{}` (no body)
**Output:** `{ success, projectsDeleted, userRecordDeleted, message }`

**Logic:**
1. Deletes per-project data: ProjectFile, ChatMessage, FileSnapshot, BackendConfig for each project.
2. Deletes all projects.
3. Deletes user-level entities: UserSettings, RebuildDoc, UsageRecord.
4. Deletes marketplace data: Template (authored), Purchase (bought).
5. Attempts to delete the auth User record (may not be permitted by the platform — if so, the message tells the user to contact Base44 support).
6. Returns a summary with counts and whether the auth record was deleted.

---

## 7. Snapshots & Docs

### restoreSnapshot
**Path:** `base44/functions/restoreSnapshot/entry.ts`

Restores project files from a FileSnapshot record.

**Input:** `{ snapshotId }`
**Output:** `{ restored, projectId }`

**Logic:**
1. Loads the snapshot. Reads the files JSON from either the inline `files` field or the `file_url` (for large snapshots that were offloaded to storage).
2. Creates a new snapshot of the CURRENT state (pre-restore backup) so the user can undo the restore.
3. Deletes all current ProjectFile records for the project.
4. Creates new ProjectFile records from the snapshot's files.

---

### generateRebuildDoc
**Path:** `base44/functions/generateRebuildDoc/entry.ts`

Generates a comprehensive blueprint document for standalone reconstruction of the Morpheus platform.

**Input:** `{}` (no body)
**Output:** `{ version, contentSize, docId, updated }`

**Logic:**
1. Fetches live entity schemas for all 11 entities (User, Project, ProjectFile, ChatMessage, FileSnapshot, Template, Purchase, UserSettings, UsageRecord, RebuildDoc, BackendConfig).
2. Builds a comprehensive markdown document with:
   - Purpose and architecture overview
   - Data model (entity schemas as tables)
   - All backend functions (purpose, input, output)
   - Frontend structure (pages, components, hooks)
   - Shared backend modules
   - Integrations (GitHub, Stripe, AI, Voice)
   - Build/compile process
   - Environment variables
   - Standalone reconstruction guide (7 steps)
3. Uploads the full document as a file (so it can exceed the entity field size limit).
4. Stores a truncated preview in the `content` field and the full URL in `file_url`.
5. Upserts the RebuildDoc entity (updates existing or creates new).

---

## 8. Voice & Prototyping

### generateMorpheusSpeech
**Path:** `base44/functions/generateMorpheusSpeech/entry.ts`

Generates speech audio (TTS) from text. Supports built-in voice, ElevenLabs, OpenAI, or a custom endpoint.

**Input:** `{ text }`
**Output:** `{ audioUrl }`

**Logic:**
1. Truncates text to 5000 characters.
2. Loads the user's TTS settings from UserSettings.
3. **Default path** (no custom TTS configured): Uses the built-in `GenerateSpeech` integration with the `storm` voice (deepest, most authoritative).
4. **Custom path** (tts_mode = 'custom' with API key):
   - `elevenlabs` — POST to `https://api.elevenlabs.io/v1/text-to-speech/{voiceId}` with `eleven_multilingual_v2` model. Returns base64-encoded MP3.
   - `openai` — POST to `https://api.openai.com/v1/audio/speech` with `tts-1` model. Returns base64-encoded MP3.
   - `custom` — POST to the user's endpoint with `{ text, voice }`. Handles both JSON (`{ audioUrl }`) and binary audio responses.
5. Returns the audio URL (either a storage URL from the built-in integration or a `data:audio/mpeg;base64,...` data URL for custom engines).

---

### generateNativePrototype
**Path:** `base44/functions/generateNativePrototype/entry.ts`

Generates a single self-contained HTML document that serves as a visual rapid prototype of a native app.

**Input:** `{ projectId }`
**Output:** `{ html, target, fileCount }`

**Logic:**
1. Only works for native compile targets (android-apk, ios-app, windows-exe, mac-app, linux-binary, python-package, rpi-distro, arduino-firmware).
2. Loads project files (filters out node_modules, .git, lock files; caps at 25 files, 6KB each).
3. Sends to the planner model with a detailed prompt that:
   - Matches the target platform's visual conventions (Material Design for Android, iOS HIG for iOS, desktop window frames for Windows/Mac/Linux, terminal for Python, kiosk for RPi, hardware panel for Arduino).
   - Extracts colors, layout, text, and structure from the source files.
   - Simulates logic flow (button click handlers do something visible).
   - Infers the full UI from the project name/description if the code is skeletal.
4. Strips markdown fences if the LLM added them.
5. Returns the complete HTML document string.

---

## 9. Shared Modules

These modules live in `base44/shared/` and are imported by multiple backend functions. They contain cross-cutting logic that would otherwise be duplicated.

| Module | Purpose |
|---|---|
| `projectUtils.ts` | Credit costs per action, `logUsage` (non-blocking usage logging), `detectLanguage` (file extension → language), `createSnapshot` (saves current file state), `applyFileOperations` (handles large file offloading to storage), `readOffloadedString` (reads from inline or file_url). |
| `githubConnection.ts` | Per-user GitHub token retrieval via the app-user connector (ID: `6a8785ad122b26c1461f0f6c`). `getAppUserGithubToken` resolves the OAuth token. |
| `githubPush.ts` | GitHub repo creation (`createRepo` — handles name collisions), file pushing via Git Data API (`pushFiles` — creates blobs, tree, commit with retry logic), `ghHeaders`/`ghJson` helpers, `encryptAndSetGithubSecret` (encrypts a secret value with the repo's public key before setting it). |
| `compile-targets/index.ts` | Compile target adapter registry. `getCompileTarget(target)` returns the adapter for a target. `listCompileTargets()` returns all supported targets. |
| `compile-targets/*.ts` | One adapter per compile target (android-apk, ios-app, windows-exe, mac-app, linux-binary, web-app, python-package, rpi-distro, linux-distro, arduino-firmware). Each declares: `label`, `runner`, `validate()`, `scaffold()`, `buildSteps()`, `artifact` (glob/name), `requiredSecrets`, `errorPatterns`. |
| `compile-targets/workflow-renderer.ts` | `renderWorkflow(runner, steps, artifact)` — renders structured build steps into GitHub Actions YAML. |
| `aiUtils.ts` | `invokeAI(base44, prompt, schema?, fileUrls?, role?)` — routes AI requests to the platform default (`Core.InvokeLLM`) or a user-configured custom endpoint (from UserSettings: `ai_mode`, `ai_base_url`, `ai_api_key`, `ai_model`). Supports per-role model overrides (planner, coder, reviewer, diagnosis). |
| `reviewer.ts` | `reviewAndRetry(base44, fileOps, contextBlock, plan, originalPrompt)` — code review agent that checks generated code before commit. Flags critical issues (syntax errors, missing imports, broken logic). Retries up to 2 times if critical issues are found. `formatReviewChatBlock` formats the review summary for chat display. |
| `diagnosis.ts` | AI diagnosis engine: `isCredentialError`, `isAuthError`, `buildCredentialAction`, `applyFileFixes`, `fixResponseSchema`. Classifies errors as credential (→ user action) or code-level (→ auto-fix). |
| `stripeUtils.ts` | `stripeFetch` (wraps Stripe API calls with auth header + error handling), `encodeForm` (encodes nested objects as `application/x-www-form-urlencoded` with bracket notation), `computeSplit` (80/20 revenue split calculation). |
| `infrastructureComponents.ts` | `COMPONENTS` array (all infrastructure component types + free-tier service options), `getServiceOption`, `DEFAULT_COMPONENTS`, `getDashboardUrl`, `validateDeployCredentials`, `buildCodegenPrompt`, `buildEnvVars`. |
| `healthCheck.ts` | `checkHealth(url, options)` — pings a URL with retries and timeout. `withRetry(fn, shouldRetry)` — generic retry wrapper. |
| `buildLogs.ts` | `aggregateBuildLogs(base44, projectId)` — fetches and aggregates build log events from UsageRecord metadata. `generateBuildLogMarkdown` — formats logs as markdown. |
| `costEstimate.ts` | `estimateActionCost(actionType, metadata)` — estimates LLM compute cost in USD per model and token count for usage transparency. |
| `toolchain.ts` | `buildToolchain(provider, models)` — builds a toolchain info object for usage logging (SDK, provider, planner/coder/reviewer models, client tools). |
| `designSystem.ts` | Design system tokens for web-app compile targets (spacing, typography, hover/focus states). |

---

## Environment Variables / Secrets

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe API authentication (live mode) |
| `STRIPE_PUBLISHABLE_KEY` | Stripe client-side checkout |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature verification |
| `BASE44_APP_ID` | App ID for Stripe metadata tracking |
| `GITHUB_CONNECTOR_ID` | Per-user GitHub OAuth connector ID (`6a8785ad122b26c1461f0f6c`) |

---

## Architecture Notes

### AI Pipeline Pattern
Most AI-driven functions follow a three-phase pattern:
1. **Planner** (high-think model) — reasons about architecture, produces a plan
2. **Coder** (fast model) — implements the plan, writes files
3. **Reviewer** — checks the output for critical issues, retries if needed

This separation prevents the coder from making design decisions mid-stream and ensures quality through the review gate.

### Perpetual Project Memory
`chatWithMorpheus` and `autonomousBuildStep` both load the ENTIRE conversation history (every ChatMessage ever sent in the project) as context. This means Morpheus never forgets a requirement, decision, or fix from earlier in the project.

### Compile Target Adapters
Each compile target is a self-contained adapter that handles its own:
- Validation (does the project have the right files?)
- Scaffolding (auto-generates missing config files)
- Build steps (structured steps → rendered to GitHub Actions YAML)
- Artifact spec (what file pattern to download from the release)
- Error patterns (target-specific log filtering for diagnosis)

To add a new compile target, create a new adapter in `base44/shared/compile-targets/` and register it in `index.ts`.

### Large File Offloading
`applyFileOperations` in `projectUtils.ts` handles the entity field size limit: if a file's content exceeds the limit, it's uploaded to storage and the `file_url` is stored instead, with a truncated preview in `content`. `readOffloadedString` reads from either source transparently.

### Revenue Split
All marketplace purchases use an 80/20 split: 80% to the seller, 20% to the platform. This is computed by `computeSplit` in `stripeUtils.ts` and stored on the Purchase record as `seller_cut` and `platform_cut`.

---

_Generated from source code analysis. Last updated: 2026-08-23._
