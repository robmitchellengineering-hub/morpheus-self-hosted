# Porting guide — Base44 → self-hosted Express/Prisma

This repo is a from-source port of the real Morpheus app (the zip export of
`large-nebula-code-core.base44.app`). The `base44/` directory at the repo
root is the **original, authoritative source** — 34 serverless functions
under `base44/functions/<name>/entry.ts` and shared logic under
`base44/shared/*.ts`. Your job is to port a function or shared module to
plain JS running on this Express/Prisma stack, preserving its behavior
exactly — same prompts, same business logic, same response shape — only
swapping the runtime primitives.

Read the original file first. Port its logic faithfully. Do not
"improve" prompts, credit costs, or business rules — this has to match the
live app. Do improve obvious bugs only if trivial and clearly a bug, not a
design choice you'd guess at.

## Directory layout

```
server/
  prisma/schema.prisma      Already written — 11 models, snake_case fields
                              matching base44/entities/*.jsonc exactly.
  src/
    db.js                   export const prisma  (Prisma client singleton)
    auth.js                 requireAuth/optionalAuth middleware, JWT helpers
    crypto.js               encrypt(str) / decrypt(str) — AES-256-GCM, use
                              for any secret you persist (API keys, tokens)
    storage.js               uploadFile / downloadFile / offloadLargeString /
                              readOffloadedString — object storage
    ai.js                    invokeAI({ userId, prompt, schema, fileUrls, role })
    entities.js              generic CRUD engine backing /api/entities/*
    lib/
      projectUtils.js        ALREADY PORTED — CREDIT_COSTS, logUsage,
                               detectLanguage, createSnapshot, applyFileOperations
      toolchain.js            ALREADY PORTED — buildToolchain(provider, models)
      mailer.js               ALREADY PORTED — sendMail({to, subject, text, html})
      reviewer.js             ← port base44/shared/reviewer.ts here
      designSystem.js         ← port base44/shared/designSystem.ts here
      diagnosis.js            ← port base44/shared/diagnosis.ts here
      github.js               ← port base44/shared/githubConnection.ts +
                                  base44/shared/githubPush.ts here (merge into one file)
      stripe.js               ← port base44/shared/stripeUtils.ts here
      healthCheck.js          ← port base44/shared/healthCheck.ts here
      infrastructureComponents.js ← port base44/shared/infrastructureComponents.ts here
      costEstimate.js         ← port base44/shared/costEstimate.ts here
      buildLogs.js            ← port base44/shared/buildLogs.ts here
      compile-targets/        ← port base44/shared/compile-targets/*.ts here
                                  (index.js registry, workflow-renderer.js,
                                  utils.js, and one file per target)
    functions/
      <name>.js               ← port base44/functions/<name>/entry.ts here,
                                  one file per function, filename = function name
    routes/                   Already written — do not need changes for a
                                function/shared-lib port.
```

## The handler contract (`server/src/functions/<name>.js`)

```js
export default async function handler(ctx) {
  const { user, body } = ctx; // user = req.user (already authenticated), body = req.body
  // ... your ported logic ...
  return { reply: '...', fileOperations: [] }; // plain object → dispatcher does res.json(...)
}
```

- `ctx.user` — the authenticated `User` row from Prisma (already loaded by
  `requireAuth`). Equivalent to `await base44.auth.me()`. It's non-null for
  every function except the few in `PUBLIC_FUNCTIONS` in
  `routes/functions.routes.js` (`browseTemplates`, `getPublicTemplate`,
  `stripeWebhook`, `checkDeployHealth`) — those must handle `user` being
  `null`.
- `ctx.body` — parsed JSON POST body. Equivalent to `await req.json()`.
- Throw `Object.assign(new Error('message'), { status: 400 })` for error
  responses with a specific status code — the dispatcher catches it and
  responds `{ error: message }` with that status. A plain `throw new
  Error(...)` becomes a 500.
- To stream a non-JSON response (e.g. a ZIP file for `downloadTemplate` or
  `emailProjectFiles`), write directly to `ctx.res` (`res.set(...)`,
  `res.send(buffer)`) and return `undefined` — the dispatcher skips
  auto-JSON when `res.headersSent` is true.

## Base44 API → this stack, call by call

| Base44 (original) | This stack |
|---|---|
| `const base44 = createClientFromRequest(req); const user = await base44.auth.me();` | `ctx.user` (already resolved) |
| `base44.entities.X.get(id)` | `prisma.x.findFirst({ where: { id, created_by_id: user.id } })` — **always scope by `created_by_id` unless you have a specific reason not to** (mirrors the original RLS in `base44/entities/*.jsonc`) |
| `base44.entities.X.filter({ project_id }, 'created_date')` | `prisma.x.findMany({ where: { project_id, created_by_id: user.id }, orderBy: { created_date: 'asc' } })` (note: base44 `filter(query, sort)` with a bare field name sorts ascending; `-created_date` sorts descending — same convention we use) |
| `base44.entities.X.create(data)` | `prisma.x.create({ data: { ...data, created_by_id: user.id } })` |
| `base44.entities.X.update(id, data)` | `prisma.x.update({ where: { id }, data })` — check ownership first with a `findFirst` if the row wasn't already loaded scoped to this user |
| `base44.entities.X.delete(id)` | `prisma.x.delete({ where: { id } })` — same ownership check |
| `base44.asServiceRole.entities.X...` | Same as above, WITHOUT the `created_by_id` filter — this was Base44's explicit RLS-bypass for cross-user reads (e.g. `getPublicTemplate` reading any user's `Template` row, `stripeWebhook` writing a `Purchase` for the buyer while crediting a different seller). Use plain `prisma.x...` with no owner filter when the original used `asServiceRole`. |
| `base44.asServiceRole.integrations.Core.InvokeLLM({ prompt, response_json_schema, model })` / `invokeAI(base44, prompt, schema, fileUrls, role)` | `import { invokeAI } from '../ai.js'; await invokeAI({ userId: user.id, prompt, schema, fileUrls, role })` — returns `{ result, provider, model, usage }`, same shape |
| `base44.integrations.Core.UploadFile({ file })` | `import { uploadFile } from '../storage.js'; const { file_url } = await uploadFile({ buffer, filename, contentType })` |
| `base44.asServiceRole.connectors.getCurrentAppUserConnection(connectorId)` (GitHub) | `import { getGithubToken } from '../lib/github.js'; const token = await getGithubToken(user.id)` (reads the `GithubConnection` row set up by `routes/connections.routes.js`) |
| `Response.json({ ... }, { status: N })` | `throw Object.assign(new Error('...'), { status: N })` for errors; for success, just `return { ... }` |
| `npm:@base44/sdk@0.8.40` import | Not needed — delete it |
| Base44 entity field names (`project_id`, `compile_target`, `created_date`, etc.) | **Unchanged.** `prisma/schema.prisma` uses the exact same snake_case field names as `base44/entities/*.jsonc`, specifically so ported logic doesn't need a field-name translation layer. |

## Credits / usage logging

Already ported in `lib/projectUtils.js`. Call it exactly like the original:

```js
import { logUsage } from '../lib/projectUtils.js';
await logUsage(user.id, 'chat_build', projectId, project.name, { ...toolchainMetadata });
```

`CREDIT_COSTS` in that file has the exact same action-type → credit mapping
as `base44/shared/projectUtils.ts`. Don't invent new action types; if a
function logs an action type not in that map it silently costs 1 credit
(matches original fallback behavior).

## Worked example

`checkGithubConnection` (short, good first read) — original:

```ts
// base44/functions/checkGithubConnection/entry.ts
import { getGithubConnection } from '../../shared/githubConnection.ts';
export default async function(req) {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const connection = await getGithubConnection(base44);
  return Response.json({ connected: !!connection, login: connection?.login || null });
}
```

Ported (`server/src/functions/checkGithubConnection.js`):

```js
import { getGithubConnection } from '../lib/github.js';

export default async function handler({ user }) {
  const connection = await getGithubConnection(user.id);
  return { connected: !!connection, login: connection?.login || null };
}
```

(The `Unauthorized` check is gone because `requireAuth` already handled it
before the dispatcher calls your handler — see `routes/functions.routes.js`.)

## Confirmed shared-lib exports (already ported — use these, don't re-invent)

All paths below are under `server/src/`.

**`lib/reviewer.js`** (from `reviewer.ts`) — `reviewFileOperations`, `formatReviewChatBlock`, `buildRetryPrompt`, `reviewAndRetry`. **Signature note**: every function takes `userId` as its first argument (not a `base44` client) — e.g. `reviewAndRetry(userId, fileOps, contextBlock, plan, coderPrompt)`.

**`lib/designSystem.js`** (from `designSystem.ts`) — `DESIGN_SYSTEM_CSS`, `designSystemPromptBlock()`, `POLISH_PROMPT`. Ported verbatim, no signature changes.

**`lib/diagnosis.js`** (from `diagnosis.ts`) — `detectLanguage`, `isCredentialError`, `isAuthError`, `buildCredentialAction`, `applyFileFixes`, `fixResponseSchema`. **Signature note**: `applyFileFixes` takes `userId` as its first argument, not `base44`. This module has no direct `invokeAI` call itself — the function that calls it (`diagnoseIssue.js`) is responsible for calling `invokeAI({ role: 'diagnosis', ... })` and passing the result through `applyFileFixes`.

**`lib/github.js`** (merged from `githubConnection.ts` + `githubPush.ts`) — `getGithubConnection(userId)` → `{login, token}` or `null`; `getGithubToken(userId)` → decrypted token or throws 400 "GitHub not connected"; `getGithubLogin(userId)`; `ghHeaders(token)`; `ghJson(res)`; `getGhUser(token)`; `createRepo(token, repoName, isPrivate)`; `pushFiles(token, repoFullName, files, commitMessage)`; `encryptAndSetGithubSecret(token, repoFullName, secretName, secretValue)` — **this last one needs `libsodium-wrappers`, which is NOT yet in `server/package.json`. If your function needs it (only `deployBackend`'s secret-injection path does), add `"libsodium-wrappers": "^0.7.15"` to `server/package.json` dependencies.**

**`lib/stripe.js`** (from `stripeUtils.ts`) — `getStripeKey()`, `stripeFetch(path, init)` (raw Stripe REST wrapper — the original never used the `stripe` npm SDK, so neither does this port; ignore the `stripe` package listed in `server/package.json`, it's unused), `encodeForm(params)`, `PLATFORM_COMMISSION`, `computeSplit(amount)`. **Note: this module does NOT include Stripe webhook signature verification** — if `stripeWebhook.js` needs to verify `Stripe-Signature`, implement HMAC-SHA256 verification directly in that function using Node's built-in `crypto` module against `STRIPE_WEBHOOK_SECRET` (Stripe's signature scheme: `t=<timestamp>,v1=<hex hmac of "timestamp.payload">` — check `base44/functions/stripeWebhook/entry.ts` for how the original did it, since Base44 may have done this verification itself).

**`lib/healthCheck.js`**, **`lib/infrastructureComponents.js`**, **`lib/costEstimate.js`** — ported verbatim, same export names as the originals.

**`lib/buildLogs.js`** (from `buildLogs.ts`) — includes a locally-inlined `parseToolchain` (not exported from `toolchain.js`, which only has `buildToolchain`). **Signature note**: `aggregateBuildLogs(userId, projectId)` — original was `aggregateBuildLogs(base44, projectId)`; scoped by `created_by_id: userId` per the ownership rule.

**`lib/compile-targets/`** — full adapter framework ported (`index.js` exports `getCompileTarget(id)` / `listCompileTargets()`; `workflow-renderer.js` exports the YAML renderer; one file per target: `web-app.js`, `android-apk.js`, `windows-exe.js`, `mac-app.js`, `linux-binary.js`, `linux-distro.js`, `ios-app.js`, `python-package.js`, `rpi-distro.js`, `arduino-firmware.js`). Verified working via smoke test. This is what `compileProject.js` and `getCompileStatus.js` should build on instead of re-deriving compile logic.

## When you're done

- Every ported file should have **no remaining imports from `npm:@base44/sdk`,
  no `Deno.serve`, no `createClientFromRequest`** — grep for those to check
  your own work before finishing.
- Don't edit `routes/functions.routes.js` or any other route file — the
  dispatcher auto-discovers `server/src/functions/<name>.js` by filename.
  You don't need to register anything.
- Don't touch files outside your assigned scope — other agents/passes are
  porting other functions/libs concurrently in this same repo.
