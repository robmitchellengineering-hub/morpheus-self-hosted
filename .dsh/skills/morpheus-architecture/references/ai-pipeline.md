# AI pipeline: `invokeAI()` and the chat build loop

Scope: every model call in the server, and the streamed build pipeline in
`server/src/functions/chatWithMorpheus.js`.

Provenance note: this area's audit record was stored as `entryPoints` + `flow` + a partial
`keyFiles` list; its structured `invariants` / `risks` / `unknowns` sections were cut off by the
artifact truncation, so this file states facts from the surviving flow only. Risks below are
consequences visible in that flow, marked as risks rather than intent.

## Where a model call can happen

One gateway: `invokeAI({ userId, prompt, schema, fileUrls, role, maxTokens })` in
`server/src/ai.js`. Every caller goes through it.

Callers reachable from the chat loop:

| Function | Role used | Notes |
| --- | --- | --- |
| `researchWeb` | planner (500) then query planner | web search stage |
| `researchRepo` | planner (4000) | repo research rounds |
| `autoSelectRelevantPaths` | coder (2000) | fallback file selection |
| planner call in `chatWithMorpheus.handler` | planner (24000) | the plan itself |
| coder call(s) | coder (24000 per chunk, 64000 fallback/retry) | file generation |
| `reviewFileOperations` / `reviewAndRetry` | reviewer (16000) | review + retries |
| syntax / deep-verify / a11y fix calls | coder (64000) | deterministic-gate fixes |
| `POLISH_PROMPT` pass | coder (64000) | optional UI polish |
| WordPress context mode | planner (6000) | single-shot reply |

`server/src/lib/chunkedFileGen.js` `generateFilesChunked` is used by `generateTests.js` and
`generateBackend.js` only — **not** by `chatWithMorpheus` or `autonomousBuildStep`, which chunk
inline.

## Transport into the handler

`routes/functions.routes.js` `router.all('/:name')` validates the name, requires the file to
exist, enforces `requireAuth` (or `requireAdmin` for `ADMIN_FUNCTIONS`), pins widget calls to
`req.widget.projectId`, then `runFunction()` calls `handler({user, body, query, req, res})`.
`chatWithMorpheus` writes `res.writeHead(200, 'application/x-ndjson')` itself, so the dispatcher
returns without `res.json()`.

## `invokeAI()` internals

1. `getUserSettings(userId)` → `resolveEndpoint(settings, role)` picks provider / baseUrl /
   apiKey / model. Throws if there is no apiKey.
2. For non-exempt users: `estimatePreCallCredits(prompt, role, model)` then `reserveCredits`
   (an atomic conditional UPDATE; throws `InsufficientCreditsError` with status 402).
   Billing helpers all live in `server/src/lib/billing.js`.
3. `fileUrls` are partitioned:
   - images → vision content parts;
   - `TEXT_FILE_EXT` → inlined up to `MAX_INLINED_FILE_CHARS = 8000` via `readTextFileContent`;
   - `DOCUMENT_FILE_EXT` → pdf-parse / mammoth / xlsx via `readDocumentFileContent`;
   - anything else → opaque, listed as a URL only.
4. `temperature = resolvePlatformTemperature(role)` — default 0.7, clamped 0-2.
5. Body is `{ model, messages, temperature }`; `body.max_tokens` is set **only** when `maxTokens`
   is truthy. When `schema` is set, `body.response_format = { type: 'json_object' }` and the JSON
   schema is appended to the prompt as prose.
6. `fetchWithTimeout(endpoint, ..., AI_FETCH_TIMEOUT_MS = 180000)` POSTs to
   `${baseUrl}/chat/completions`.

### Provider tiers and fallback

`resolveEndpoint` / `resolveModel` / `resolvePlatformDefaultModel` implement per-user BYO keys
and a platform default; `getVisionAssistConnection(settings)` prefers per-user settings and then
`FALLBACK_LLM_*`. On a non-2xx whose body looks like a vision rejection, `invokeAI` retries once
with images stripped after `describeImagesWithConnection` captions them; if that is not possible
it injects a "cannot see images" note instead of failing. `isDeepSeekModel` and the DeepSeek
fallback path live in `billing.js`; `modelPricing.js` (`isLocalModel`, `getModelRate`,
`computeCostUsd`) and `costEstimate.js` (`MODEL_PRICING`, `DEFAULT_PRICING`,
`LOCAL_MODEL_PATTERNS`, `ACTION_TOKENS`, `estimateActionCost`) price the calls.

### Credits: reserve, then reconcile

- Reserve before the call (`reserveCredits`); refuse with 402 when short.
- Any failure **before** a `usage` object exists fully refunds the reservation via
  `reconcileCredits(userId, reservedCredits, 0)`.
- On success, `recordCallDuration(role, ms)` feeds `timingStats`, `recordUsageEvent(...)` is
  fired un-awaited, and `reconcileAgainstActualUsage` settles the difference against real token
  counts. `usdToCredits`, `CREDIT_RATE_USD`, `TOKEN_BLOCKS`, `computeGrossedUpCharge`,
  `resolveBillingRate`, `resolveBillingMarkup`, `getModelMarkup`, `FIRST_PURCHASE_RECOUP_USD`,
  `isFirstTokenPurchase` all live in `billing.js`.

### Truncation semantics (easy to get wrong)

- A non-2xx throws `AI endpoint error (status): <body[:300]>`.
- `finish_reason === 'length'` throws `OUTPUT_TRUNCATED` carrying role + maxTokens **only for
  schema calls**.
- Plain-text (no-schema) calls deliberately **return truncated prose instead of throwing**.
- Schema parsing is `JSON.parse` → `jsonrepair(content)` → on failure an error that includes the
  role and a 300-char snippet.

## The chat build loop, phase by phase

Streaming is NDJSON: `res.writeHead(200, x-ndjson, Cache-Control: no-cache, X-Accel-Buffering: no)`;
`emit()` writes one JSON line per event. `makeStageEmitter(emit)` wraps stages with
`STAGE_LABELS`/`STAGE_ROLE`, records `startedAt`, and logs
`[chatWithMorpheus] stage start/done` to stdout — added because the stream alone left 15+ minute
silent gaps invisible in server logs.

**1. Pre-flight.** Load the project as `prisma.project.findFirst({id, created_by_id: user.id})`;
reject `project_type === 'self_dev'` unless `user.role === 'admin'`; load **all** `ProjectFile`
rows for the project (by `project_id` only, deliberately not `created_by_id`); load the last 20
`ChatMessage` rows (`orderBy created_date desc`, then reversed); call
`getContextSummary(user.id, project, 'chat')`; create the user's `ChatMessage`. The 20-message
window is bounded by design (comment cites a 2026-08-26 audit that reverted an unbounded version).

**2. Context mode.** `totalFileBytes = sum(content lengths)`;
`useScopedContext = isSelfDev || totalFileBytes > SCOPED_CONTEXT_THRESHOLD_BYTES (120000)`.
Scoped mode uses `buildScopedFilesContext(files, focusPaths, orientation)` and emits
`scopedContextNote()`. `deferResearch = useScopedContext && mode === 'build' && no manual focusPaths`.
Orientation lists: `SELF_DEV_ORIENTATION_FILES` / `GENERIC_ORIENTATION_FILES`.
`SCOPED_MAX_CONTEXT_BYTES = 150000` caps inlined content.

**3. Prompt assembly.** `assembleContextBlock()` composes: `summaryBlock`, `featureBlock`
(`getActiveFeature`/`featureContextBlock`), `decisionsBlock` (`recentDecisionsBlock`),
`mediaBlock` (`getProjectAssets`/`mediaAssetsBlock`), `webNotes`, `researchNotes`, current files,
history, `wordpressBlock`, `currentPageBlock` (wpStore `resolve_url` when `pageUrl` is sent),
`brandBlock`, `designBlock`, `compileAdapterBlock` (`adapter.aiNotes` from `getCompileTarget`),
`publishBlock`, `formsBlock`, `siteBlock`, `cmsBlock`, `analyticsBlock`.
`engineScopePolicy = resolvePolicy(activeFeature.scopePolicy)` when a feature declares one.

**4. Web research (`web`, role planner).** `researchWeb(userId, message)` fetches up to 3 pasted
URLs directly (`fetchLlmsTxt` for a bare origin, else `webFetch`), then **one** `invokeAI` call
(role planner, `maxTokens 500`) deciding 0-3 search queries, then
`webSearch(searchKey, q, {maxResults: 4})`. Best-effort: any throw is caught and logged, returning
empty notes.

**5. CONTEXT mode short-circuits.** For the WordPress/context mode, a single `invokeAI` call
(role planner, `maxTokens 6000`) with a schema of `{reply}` plus optional `proposeAction`/
`actionType`/`stockQuantity` and `proposeBulkAction`/`bulkActionType`/`bulkProductNames`/
`bulkStockQuantity`. No snapshot, no fileOperations. Any proposed WordPress action is rebuilt
server-side from `resolvedPage` (wpStore) or from wpStore `list_products` exact-name matching —
**the model only ever supplies a verb/name, never an id**. Emits
`{type:'result', data:{reply, fileOperations: [], mode:'context', proposedAction, proposedBulkAction}}`.

**6. Repo research (`research`) when deferResearch.** `researchRepo(userId, files, message,
{maxRounds, maxFiles})` loops up to 3 rounds / 16 files (self-dev) or 2 rounds / 10 files
(normal); each round is one `invokeAI` call (role planner, `maxTokens 4000`) returning
`{readNext, notes, done}`. On failure it falls back to
`autoSelectRelevantPaths(userId, files, message, {limit: 6 or 10, fallback: orientation})`,
itself one `invokeAI` call (role coder, `maxTokens 2000`).

**7. Planner (`planner`, `maxTokens 24000`).** One `invokeAI` call per round with the full
schema: `reply`, `needsCode`, `needsClarification`, `plan`, `plannedFiles`,
`featureTitle`/`featureSteps`, `stepComplete`, `decisionSummary`/`decisionRationale`,
`externalApis[]`, and (self-dev only) `toolCalls[]`. On self-dev, if the model returns
`toolCalls` and `round < SELF_DEV_TOOL_MAX_ROUNDS (2)`: `stages.start('diagnose')`,
`runSelfDevToolCalls(user, project, requested)` executes up to
`SELF_DEV_TOOL_MAX_CALLS_PER_ROUND (3)` **read-only** diagnostics,
`formatSelfDevToolResultsBlock` is appended, `extractScreenshotUrls` feeds images into the next
planner call's `fileUrls`, and the loop repeats. Worst case 3 planner calls.

**8. Post-planner branches.** If `featureSteps.length >= 3` and no feature is active,
`createFeature(user.id, projectId, {title, goal, stepTitles})` records the escalation and this
turn builds step 1 only. If `needsClarification`, it writes the Morpheus `ChatMessage`, logs
`logUsage('chat_simple')`, and emits a terminal result with `fileOperations: []` and
`needsClarification: true`.

**9. External-API pre-flight (`api_check`).** If `plannerResult.externalApis` is non-empty,
`verifyExternalApiCalls` (GET only, max 5, 10 s timeout, manual redirect, DNS resolution checked
against private/reserved IPv4+IPv6 ranges) and `formatApiCheckBlock()` produce a verified-URL
block handed to the coder as ground truth (`lib/externalApiCheck.js`).

**10. Coder (`coder`).** `plannedFiles` drives chunking: `MAX_FILES_PER_CODER_STEP = 3`,
`CODER_STEP_MAX_TOKENS = 24000` per chunk. Each chunk prompt is `systemPrompt` +
`CODER_INSTRUCTIONS` + `diffModeNote` + `contextBlock` + the **full** plan + `apiCheckBlock` +
the full planned file list + the current content of any existing chunk file not already shown
(`chunkCurrent`). Schema is
`{fileOperations:[{path, content, action, edits:[{find,replace}]}]}`. It then injects
`styles.css = DESIGN_SYSTEM_CSS` if the app is web and the coder did not produce one. If
`plannedFiles` was empty (model omitted it), it falls back to **one** unscoped `invokeAI` call
with `maxTokens 64000`, plus the current content of any existing path mentioned in the plan text.

**11. Diff-edit resolution.** For any op with `edits`, `curContent` is built from the
**start-of-turn** `files` rows; `applyEdits(original, edits)` is applied (exact match first, then
whitespace-tolerant line match, ambiguity rejected), and only fully-applied ops replace content.
Files whose edits fail get one targeted `retry_coder` `invokeAI` call (role coder,
`maxTokens 64000`) asked for **full** content; retry ops are filtered to paths in the failure set
and must carry a string `content`.

**12. Reviewer (`reviewer`).** `reviewAndRetry(user.id, fileOps, reviewContext, plan,
coderPrompt, stages.onProgress)`: context is enriched with a CALLER IMPACT manifest from
`buildReverseImports(files)` for every modified existing file. `reviewFileOperations` chunks ops
by `REVIEW_CHUNK_SIZE = 3`; each chunk is one `invokeAI` call (role reviewer,
`maxTokens REVIEW_STEP_MAX_TOKENS = 16000`) with `REVIEWER_PROMPT`/`REVIEW_SCHEMA` returning
`{issues:[{path, severity, message}], summary, approved}`. If any critical issue remains it loops
up to `MAX_REVIEW_ATTEMPTS = 3`: a `retry_coder` call (`buildRetryPrompt`, role coder,
`maxTokens 64000`), merge corrected ops by path (last wins), then re-review as `retry_reviewer`.
**The loop never blocks** — files commit regardless of the verdict. `formatReviewChatBlock`
renders the result into the reply.

**13. Deterministic gates.**
- *Syntax gate*: `checkSyntax(changedCode())` runs an esbuild transform per JS/TS/JSX/TSX file
  and a real CPython `ast.parse` per `.py` file. Up to `MAX_GATE_ATTEMPTS = 3` coder fix calls
  (role coder, `maxTokens 64000`), re-checked each pass; leftovers become `syntaxCritical` note
  text (`lib/syntaxCheck.js`).
- *Self-dev deep verify*: `adapter = getDeliveryAdapter('self-dev')`; `adapter.verify({files:
  applyVirtual()})` runs `engine/verify.js`'s real-bundle + cross-file named-export check over
  the full repo with fileOps applied virtually. Same 3-attempt fix loop; an error pointing at an
  importer the turn never touched breaks out immediately.
- *A11y gate* (web apps only): `checkA11y(changedMarkup())` findings trigger **one** coder fix
  call, then `checkSyntax` on the fix ops, then re-check a11y **only if** the syntax re-check
  passed; leftovers become `a11yNotes`.

**14. Persistence.** `createSnapshot(user.id, projectId, 'Operator build request')` then
`applyFileOperations(user.id, projectId, fileOps, files, engineScopePolicy)`. That function skips
duplicate paths; enforces `assertWritable(policy, op.path)` per op (recording action
`policy_denied`); refuses empty content at known `BINARY_EXTENSIONS` paths as
`skipped_fake_binary` (`isFakeBinaryPlaceholder`); deletes when `action === 'delete'`; applies
`edits` against the **current DB row** content for updates (recording `edit_failed` and leaving
the file untouched on any mismatch); and on a create `P2002` unique-constraint collision looks the
row up and updates it instead of crashing. All in `lib/projectUtils.js`.

**15. Optional UI polish (`polish`).** Runs only when `project.polish_ui` is set,
`appliedOps.length > 0`, not self-dev, applied files include web extensions (or the target is
web-app), and not WordPress. Re-reads all `ProjectFile` rows, one `invokeAI` call (role coder,
`maxTokens 64000`, `POLISH_PROMPT`), then `createSnapshot` + `applyFileOperations` for the polish
ops with **no** policy argument.

**16. GitHub auto-sync.** If `appliedOps.length > 0` and `project.github_repo`,
`syncProjectFilesToGithub(user.id, project, appliedOps)` is called fire-and-forget (`.catch`
logs only): incremental `pushFiles` for creates/updates and explicit `getFileContent`/`deleteFile`
for deletes, on the repo's real default branch.

**17. Reply and accounting.** `fullReply = reply + reviewBlock + sourcesLine + polish/unresolved/
syntaxCritical/deepVerifyCritical/a11y note lines`. The Morpheus `ChatMessage` is written;
`project.status` becomes `'building'` if anything applied; `logUsage` with action `chat_build`
or `chat_simple` (metadata includes `buildToolchain(provider, {planner, coder, reviewer})`) is
written to `UsageRecord`; `recordDecision()` stores `decisionSummary`/`decisionRationale`; a
feature step may be advanced via `runUpdateSelfDevFeature` (non-self-dev only, and only when
`buildProgressed` = ops applied && no unresolved/syntax/deep-verify criticals); final
`emit({type:'result', data:{reply, fileOperations: appliedOps, featureChanged}})`.

## The loop-driven variant

`server/src/functions/autonomousBuildStep.js` (`PLANNER_PROMPT`, `CODER_PROMPT`, `estimateTokens`,
`measureFileOps`, `handler`) runs Planner → Coder → Reviewer for a foreground loop: **no
clarification gate and no chunking**. It does not use `chunkedFileGen.js` either.

## Context summarisation

`server/src/lib/contextSummary.js` owns rolling compression of history older than the bounded
window: `HISTORY_WINDOW`, `SUMMARY_UPDATE_INTERVAL`, `MAX_SUMMARY_WORDS`, `SUMMARY_PROMPT`,
`SUMMARY_SCHEMA`, `getContextSummary(userId, project, windowKind)`,
`formatContextSummaryBlock`.

## Points that are easy to get wrong

- `max_tokens` is omitted, not defaulted, when `maxTokens` is falsy — the provider default applies.
- Truncation is fatal for schema calls and non-fatal for prose calls (`OUTPUT_TRUNCATED`).
- The reviewer's verdict does not gate commits; only the deterministic gates produce critical
  note lines.
- `applyEdits` in step 11 runs against start-of-turn content, while `applyFileOperations`
  re-applies `edits` against the **current** DB row — the two can disagree mid-turn.
- A failed credit reservation refunds only when the failure happened before `usage` existed.
- Widget/device tokens can call `chatWithMorpheus` (with scopes), but its self-dev path is
  admin-gated **inside the handler** precisely because the function name cannot be in
  `ADMIN_FUNCTIONS` (it is shared by every project type).

## Risks (visible in the flow, not audit-asserted intent)

- The reviewer loop can spend up to 3 additional 64k-token coder calls per turn and still ship
  unreviewed code, since approval is advisory.
- Fire-and-forget GitHub sync means a failed push is invisible to the caller.
- The unscoped 64k fallback when `plannedFiles` is empty inlines plan-mentioned files and can
  blow context or cost on a malformed plan.
- The polish pass re-reads and rewrites files with **no** policy argument, so `assertWritable`
  does not run for it.

## Key files

- `server/src/ai.js` — `invokeAI`, `resolveEndpoint`, `resolveModel`, `resolvePlatformDefaultModel`,
  `resolvePlatformTemperature`, `getUserSettings`, `fetchWithTimeout`, `recordUsageEvent`,
  `getVisionAssistConnection`, `describeImagesWithConnection`, `readTextFileContent`,
  `readDocumentFileContent`.
- `server/src/functions/chatWithMorpheus.js` — `handler`, `makeStageEmitter`, `STAGE_LABELS`/`STAGE_ROLE`, `SYSTEM_PROMPT_PERSONALITY`/`SYSTEM_PROMPT_PLAIN`/`BUILD_TARGET_INSTRUCTIONS`, `PLANNER_INSTRUCTIONS`, `CONTEXT_MODE_INSTRUCTIONS`, `CODER_INSTRUCTIONS`, `autoSelectRelevantPaths`, `researchWeb`, `researchRepo`, `buildScopedFilesContext`, `scopedContextNote`, `assembleContextBlock`.
- `server/src/lib/reviewer.js` — `REVIEWER_PROMPT`, `REVIEW_SCHEMA`, `reviewFileOperations`, `formatReviewChatBlock`, `buildRetryPrompt`, `reviewAndRetry`.
- `server/src/lib/projectUtils.js` — `CREDIT_COSTS`, `logUsage`, `createSnapshot`, `isFakeBinaryPlaceholder`, `applyEdits`, `applyFileOperations`, `syncProjectFilesToGithub`.
- `server/src/lib/billing.js` — `isDeepSeekModel`, `resolveBillingRate`, `resolveBillingMarkup`, `CREDIT_RATE_USD`, `TOKEN_BLOCKS`, `computeGrossedUpCharge`, `FIRST_PURCHASE_RECOUP_USD`, `isFirstTokenPurchase`, `InsufficientCreditsError`, `usdToCredits`, `getModelMarkup`, `estimatePreCallCredits`, `reserveCredits`, `reconcileCredits`, `reconcileAgainstActualUsage`.
- `server/src/lib/modelPricing.js` — `isLocalModel`, `getModelRate`, `computeCostUsd`.
- `server/src/lib/costEstimate.js` — `MODEL_PRICING`, `DEFAULT_PRICING`, `LOCAL_MODEL_PATTERNS`, `ACTION_TOKENS`, `estimateActionCost`.
- `server/src/lib/contextSummary.js` — `HISTORY_WINDOW`, `SUMMARY_UPDATE_INTERVAL`, `MAX_SUMMARY_WORDS`, `SUMMARY_PROMPT`, `SUMMARY_SCHEMA`, `getContextSummary`, `formatContextSummaryBlock`.
- `server/src/lib/chunkedFileGen.js` — `generateFilesChunked` (used by `generateTests.js` and `generateBackend.js` only).
- `server/src/functions/autonomousBuildStep.js` — `PLANNER_PROMPT`, `CODER_PROMPT`, `estimateTokens`, `measureFileOps`, `handler`.
- `server/src/lib/syntaxCheck.js` — `checkSyntax`; `server/src/lib/timingStats.js` — `recordCallDuration`.
- `server/src/lib/enginePolicy.js` — `PLUGIN_DENY_PATHS`, `ADMIN`/`PLUGIN_TENANT`/`WIDGET_BUILD`, `resolvePolicy`, `assertWritable`, `partitionWritable`, `scopeExcludeFor`.
- `server/src/lib/externalApiCheck.js` — `isPrivateOrReservedIp`, `resolvesToPrivateIp`, `verifyExternalApiCall`, `verifyExternalApiCalls`, `formatApiCheckBlock`.

## Open questions

- The audit's `invariants`/`risks`/`unknowns` for this area are not recoverable from the artifact
  (truncated). Re-derive them from `server/src/ai.js` and `functions/chatWithMorpheus.js` before
  relying on any risk claim above as exhaustive.
- The tail of the audit's `keyFiles` list was cut mid-entry (`timingStats.js`); that list may have
  named further files.
