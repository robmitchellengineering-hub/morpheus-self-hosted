# Server routing, auth gate and handler contract

Scope: `server/src` Express app. Every claim below is cited to a file the audit read.
Line numbers are from that read; re-grep before editing.

## Boot and middleware order

`server/src/index.js` is the only entrypoint. `server/package.json` runs it as
`node src/index.js` for both `start` and `dev`.

Order matters and is deliberate:

1. `import 'dotenv/config'` — env loaded before anything reads `process.env`.
2. `app.set('trust proxy', 1)` (index.js:23) — one proxy hop in front in production (SCALING.md).
3. `helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } })` (index.js:25). CSP is **off**; CORP is loosened to `cross-origin` so the widget/embed surface can load assets.
4. `cors(...)` (index.js:27-31). `CORS_ORIGIN` is split on commas; if the list contains `*` — which it does when the var is unset, because the default is `'*'` — the option becomes `origin: true` with `credentials: true`.
5. `express.raw({ type: 'application/json' })` mounted at `/api/functions/stripeWebhook` **only** (index.js:35). This must precede the JSON parser so the Stripe HMAC can be verified over raw bytes.
6. `express.json({ limit: '15mb' })` (index.js:37) then `express.urlencoded({ extended: true })` (index.js:38).
7. `rateLimit({ windowMs: 60000, max: 300, standardHeaders: true, legacyHeaders: false })` mounted at `/api` (index.js:42). One bucket for the whole API.
8. `GET /api/health` defined inline (index.js:44), returns `{ ok, service: 'morpheus-server', time }`.
9. Route mounts (index.js:46-52) — see table below.
10. `express.static(LOCAL_ROOT, { maxAge: '1y', immutable: true })` at `/uploads` (index.js:56). `LOCAL_ROOT` is `server/data/storage` (`server/src/storage.js:17`).
11. Terminal 4-arg error middleware (index.js:58-61): logs `err`, responds `{ error: err.message }`, status `err.status || 500`.
12. `app.listen(process.env.PORT || 4500)` (index.js:63-64), then fires two in-process schedulers: `startFreshnessSchedule()` and `startDeepSeekBalanceSchedule()` (index.js:66-67).

## Route mounts

| Mount | File | Notes |
| --- | --- | --- |
| `/api/auth` | `routes/auth.routes.js` | public login/register/OTP/Google + authed me/verify |
| `/api/connections` | `routes/connections.routes.js` | GitHub / Google / Drive OAuth; per-route gates |
| `/api/entities` | `routes/entities.routes.js` | generic CRUD, see `data-model.md` |
| `/api/functions` | `routes/functions.routes.js` | the filename-dispatched registry |
| `/api/uploads` | `routes/uploads.routes.js` | multer memoryStorage, 50 MB |
| `/api/media-assets` | `routes/mediaAssets.routes.js` | multer memoryStorage, 30 MB |
| `/api/admin` | `routes/admin.routes.js` | one router-level admin gate |

There is **no** 404/fallback handler for unmatched `/api/*` paths: after the mounts and
static middleware the request reaches Express's default HTML 404, not the `{error}` JSON
the frontend `apiFetch` expects (`src/api/base44Client.js` around lines 98-124).

## The function registry: a file is the registration

`routes/functions.routes.js` is the whole mechanism. `server/src/functions/<name>.js`
exists iff the function exists — there is no shared registry file to edit, so adding an
endpoint means adding a file.

`router.all('/:name')` (functions.routes.js:52):

1. Name must match `/^[A-Za-z][A-Za-z0-9]*$/` or 400 `Invalid function name` (:54).
2. `path.join(FUNCTIONS_DIR, name + '.js')` must exist or 404 `Unknown function: <name>` (:56-57). Both checks run **before** auth.
3. Unless `name` is in `PUBLIC_FUNCTIONS`, `requireAuth` wraps the rest (:59-60).
4. Inside that callback, scoped tokens are narrowed (:64-76) — see below.
5. If `name` is in `ADMIN_FUNCTIONS`, `requireAdmin` runs before dispatch (:77-79).
6. `runFunction(name, filePath, req, res, next)` (:86-109).

`runFunction` does `await import('../functions/<name>.js')`, takes `mod.default`, and calls
it with exactly:

```js
handler({ user: req.user || null, body: req.body || {}, query: req.query || {}, req, res })
```
(:92). `router.all` means GET/DELETE/any verb reaches the same handler.

## Handler contract

- `export default async function handler(ctx)`, `ctx = { user, body, query, req, res }` (PORTING_GUIDE.md:57-81).
- Return a plain object → dispatcher `res.json(result ?? { ok: true })` (:93-94).
- Write to `res` yourself and return `undefined` → dispatcher returns early on `res.headersSent` (:93). Streaming handlers (e.g. `chatWithMorpheus` `res.writeHead`/`res.write`) depend on this.
- Throw `Object.assign(new Error(msg), { status: N })` for a specific status; a plain throw becomes 500 (PORTING_GUIDE.md:74-77).
- Rejections are logged as `[functions/<name>]` and converted to `{error, status}` plus, duck-typed, `err.code`, `err.needed`, `err.available` (:95-108). Currently only `InsufficientCreditsError` (`lib/billing.js`) sets those, driving the frontend out-of-credits popup.
- A module with no default export yields 500 `Function <name> has no default export` (:90).

## PUBLIC_FUNCTIONS and ADMIN_FUNCTIONS

`PUBLIC_FUNCTIONS` (functions.routes.js:29) — 7 names, unauthenticated:

```
browseTemplates, getPublicTemplate, downloadFreeTemplate, stripeWebhook,
checkDeployHealth, createDonationCheckout, submitFeedback
```

`ADMIN_FUNCTIONS` (functions.routes.js:50) — 12 names, `requireAuth` **and** `requireAdmin`:

```
synthesizeUpdatesPlan, generateRebuildDoc, importSelfDevRepo, pushSelfDevToGithub,
generateSelfDevPrototype, generateSelfDevManual, verifySelfDev, revertSelfDevPush,
mergeSelfDevPr, smokeCheckSelfDev, applySelfDevMigrations, buildDeckWidget
```

The in-file comments record why several of these are here: `generateRebuildDoc` used to
rely only on the frontend `ProtectedRoute adminOnly` guard; the self-dev family is
admin-only end to end; `buildDeckWidget` is gated here "for now" until `chatWithJarvis.js`
becomes the guarded caller. `chatWithMorpheus` is deliberately **not** listed because it
is shared by every project type — it re-checks self-dev admin access inside the handler.
`ADMIN_FUNCTIONS` is an explicit allowlist, not a convention: a new privileged function is
authenticated but **not** admin-gated until its name is added here.

## Scoped tokens (widget and device)

`src/api/base44Client.js` is the wire contract on the client side: `base44.functions.invoke(name, body)`
POSTs `/api/functions/<name>` with a Bearer token (~:252-257); `invokeStream` POSTs the same
URL and reads NDJSON (~:180-247).

`requireAuth` → `optionalAuth` extracts the token from, in order (auth.js:29-39):
`Authorization: Bearer`, `req.cookies.morpheus_token`, `req.query.token`.

- `wgt_` prefix → `resolveWidgetToken` → `req.user` = owner, `req.widget = { projectId, scopes, tokenId }` (auth.js:51-57, `lib/widgetToken.js`).
- `dvc_` prefix → `resolveDeviceToken` → `req.user` = approver, `req.device = { scopes, tokenId }` (auth.js:58-64, `lib/deviceToken.js`). No `projectId` — a device token is personal.
- otherwise JWT verify + full `User` row load (auth.js:65-72).

Narrowing in the dispatcher (functions.routes.js:64-76):

- A widget token is 403'd for any `ADMIN_FUNCTIONS` name and for any name outside `widgetMayCall(scopes, name)`, and has `projectId` force-injected into `req.body` (:68). `widgetMayCall` (widgetToken.js:94-97) consults `WIDGET_ALWAYS = ['getWidgetContext']` and `WIDGET_SCOPE_FUNCTIONS`: `chat` → chatWithMorpheus/getChatHistory/getProjectFiles/getSelfDevFeatures/repoFiles; `deploy` → wordPressDeploy; `store` → getWordPressStore/wordPressStoreAction/generateProductCopy/analyzeProductPhoto. Default scopes `['chat','deploy','store']`.
- A device token is 403'd for admin names and out-of-scope names via `deviceMayCall` (deviceToken.js:194-196). `DEVICE_SCOPE_FUNCTIONS` is deliberately tiny: `ai_action` → `runAiAction`. Default scope `['ai_action']`.

`blockWidget` (auth.js:99-102) is the complementary rule for non-function routers: because a
scoped token resolves to a real user (possibly an admin), every authenticated router mounts
`blockWidget` immediately after `requireAuth` so the token cannot inherit the full account.

## Gates on the non-function routers

- `entities.routes.js:9` — `router.use(requireAuth, blockWidget)`, then an `isKnownEntity` param middleware (:11-14); owner scoping lives in `entities.js scope()`.
- `uploads.routes.js:11` — `requireAuth + blockWidget + multer`.
- `mediaAssets.routes.js:22` — `router.use(requireAuth, blockWidget)`, plus per-request `ownedProject(userId, projectId)` (:24).
- `connections.routes.js` — `requireAuth + blockWidget` applied per authed route (e.g. :59, :168, :213, :271, :314, :374, :416, :468).
- `admin.routes.js:17` — one gate for every `/api/admin/*` route: `router.use(requireAuth, blockWidget, requireAdmin)`.
- `auth.routes.js` — public: register/login/forgot/reset/google/device-start/device-poll; `requireAuth + blockWidget` on me/verify-otp/resend-otp/device-approve etc. (:70, :88, :114, :300, :311, :323).

## Conventions a new endpoint must follow

- **Errors**: `{ error: err.message }` with `err.status || 500`. The functions dispatcher additionally forwards `code`/`needed`/`available`.
- **Validation**: there is no shared layer — no zod/joi/express-validator/celebrate anywhere in `server/src` or `server/package.json`. Validation is manual per handler. Examples: admin key regex (admin.routes.js:118) and value type (:121); email/password presence and 8-char minimum (auth.routes.js:47-48, :102, :142-143); media asset URL regex (mediaAssets.routes.js:65).
- **Audit logging**: admin writes call `prisma.adminAuditLog.create(...)` — `/settings` (:132-138), `/model-catalog` (:185-191), `/ops/northflank/restart` (:308-314), `/ops/db-query` (:402-413), `/users/billing-exempt` (:476-482).
- **Body limits**: 15 MB JSON/urlencoded; multipart via multer memoryStorage at 50 MB (`/api/uploads`) and 30 MB (media assets).
- **Raw body**: the Stripe webhook is the only route that gets it; it verifies HMAC-SHA256 over `<t>.<rawBody>` against `STRIPE_WEBHOOK_SECRET` with a 300 s window and `crypto.timingSafeEqual` (`functions/stripeWebhook.js:19-45`).
- **Schedulers**: when `REDIS_URL` is absent both schedulers degrade to a plain interval; when `queueEnabled()` they defer to BullMQ repeatable jobs in `worker.js` (`freshnessSchedule.js:19`, `deepseekBalanceSchedule.js:15`, `worker.js:14-54`). `queue.js` has no producer yet (header comment, `queue.js:1-15`, no-op without `REDIS_URL` :45-47) — handlers run synchronously inside the HTTP request.

## Load-bearing invariants

1. **Deny by default.** A new handler file is authenticated unless its name is added to `PUBLIC_FUNCTIONS`.
2. **Admin is an explicit allowlist.** `requireAdmin` only applies to names in `ADMIN_FUNCTIONS`.
3. **Scoped tokens can never reach an admin gate.** They are rejected for `ADMIN_FUNCTIONS` before `requireAdmin`, and every non-function authed router mounts `blockWidget`.
4. **All `/api/admin/*` share one gate** (admin.routes.js:17).
5. **A function exists iff its file exists**, and the name must match the regex; both are checked before auth.
6. **`router.all`, not `router.post`** — HTTP method is not part of the authorization decision.

## Risks (as reported by the audit, not as intent)

- CORS defaults to reflect-any-origin with credentials when `CORS_ORIGIN` is unset or `*` (index.js:27-31). Whether a deployment sets it is not verifiable from server code.
- One coarse 300/min bucket covers all of `/api`; the in-code comment concedes costly AI/compile endpoints are not separately limited, so one expensive endpoint can exhaust the shared bucket.
- The admin SQL console classifies statements by first keyword only (`READ_SQL=/^\s*(SELECT|WITH)\b/i`, `WRITE_SQL=/^\s*(INSERT|UPDATE|DELETE)\b/i`, admin.routes.js:355-356) and any `WITH`-leading statement runs through `prisma.$queryRawUnsafe` without the `confirm` flag (:374-376, :388-389). A Postgres data-modifying CTE would match `READ_SQL` and could bypass the confirm gate if Postgres permits it through that call. Exploitability was not tested.
- Tokens are accepted from `req.query.token` (auth.js:37). The comment justifies it for popup/redirect OAuth GETs, but the same extractor — and therefore `requireAuth`, hence the whole API — accepts a query-string token on any method and path.
- `router.all('/:name')` means GET/DELETE reach mutating, credit-spending handlers; only the name allowlist and auth gate distinguish endpoints.
- No JSON 404 fallback for unmatched `/api/*`, so the frontend's `{error}` contract does not hold there.
- The global error middleware is a 4-arg Express 4 handler: rejected promises are **not** forwarded to it automatically. Route files wrap in try/catch and the dispatcher has its own catch, but a new async handler that forgets one will not hit it.
- Raw `err.message` is returned to clients in the global handler and most catch blocks, which can surface internal/DB detail.
- The admin DB console executes caller-supplied SQL via `$queryRawUnsafe` / `$executeRawUnsafe` after regex screening that is documented in-code as a scope filter, not a hardened parser.

## Open questions

- Whether the repo-root `nginx.conf` is the proxy actually deployed, and whether anything else rewrites `/api`. `index.js` assumes the full `/api/...` path arrives; `nginx.conf:17-27` proxies `location /api/` to `http://backend:4500` without stripping a prefix. Not verified.
- Whether `CORS_ORIGIN` is ever set to a real allowlist.
- Whether Postgres accepts a data-modifying CTE through `$queryRawUnsafe` (i.e. whether the `READ_SQL`/`WITH` branch is a real bypass). Not tested; no DB was queried.
- Whether any non-HTTP caller imports `server/src/functions/*` directly (scripts, `hosted-broker`, `dist/` output).
- Why the live `PUBLIC_FUNCTIONS` (7) and `ADMIN_FUNCTIONS` (12) differ from PORTING_GUIDE.md's older list of 4 public functions (PORTING_GUIDE.md:70-72).
- Whether `req.query.token` was intended for anything beyond the redirect callbacks; the extractor itself imposes no caller restriction.
- Whether the SPA is the only client — device tokens and the `/embed` widget surface are other documented callers.
