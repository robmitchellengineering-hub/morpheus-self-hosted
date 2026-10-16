# cPanel Hosting Connector — Technical Spec

**Status:** spec (pre-build) · **Date:** 15 October 2026 · **Repo:** morpheus-self-hosted
**Blocks on:** Rob's cPanel API token (no live access until then — everything below is spec-able and mock-testable without it).

---

## 1. What this builds

One new connection type, **cPanel**, with two faces sharing one encrypted credential:

1. **Management ("HOST")** — read/write files in the account's document root, read logs, read/set PHP
   version, read resource usage; later DNS / databases / email.
2. **Deploy target** — a `delivery/cpanel.js` adapter so the self-dev / build loop can inject produced
   code into a cPanel-hosted site, with snapshot → write → probe → rollback (the same discipline as
   `delivery/wordpress.js`, but the write goes over cPanel UAPI instead of a signed webhook to PHP).

The cPanel **API token** is the credential. Never the password. Never in chat — it is typed into a
Morpheus field and stored encrypted.

---

## 2. cPanel UAPI contract (verified against api.docs.cpanel.net)

**Transport:** `https://<host>:2083/execute/<Module>/<function>` · header `Authorization: cpanel <username>:<token>`.

**Response envelope** (every function):

```json
{ "apiversion": 3, "func": "list_files", "module": "Fileman",
  "result": { "status": 1, "errors": [], "messages": [], "warnings": [], "data": { } } }
```

`status: 1` = success, `0` = failure (read `errors[]`). Auth failure and route-missing come back
differently (HTTP 401 vs `result.errors` vs HTTP 404) — the client must distinguish all three, exactly
like the WordPress plugin's "too old answers two ways" lesson.

### Fileman (files)

| Function | Method | Key params | Used by |
|---|---|---|---|
| `list_files` | GET | `dir` (abs path), `types`, `limit`, `show_hidden` | HOST file tree |
| `get_file_content` | GET | `dir` (file path), `from_charset`, `to_charset` | read a file |
| `save_file_content` | GET | `dir` (file path), `content`, `to_charset` | write a file |
| `get_file_information` | GET | `dir`, `include_mime` | stat one path |
| `copy_file` / `move_file` / `rename_file` | GET | `source_file`, `dest_file` | move/copy |
| `trash_file` | GET | `file` | **reversible delete** |
| `delete_file` | GET | `file` | permanent delete — **never used by Morpheus** |
| `restore_from_trash` | GET | `file` | undo a trash |
| `upload_files` | POST (multipart) | `dir`, `file-0…` | deploy tree write |
| `autocompletedir` | GET | `path`, `include_files` | path hints |

### MultiPHP (PHP version)

| Function | Key params | Used by |
|---|---|---|
| `list_versions` | `user` | read available + current PHP version |
| `set_version` | `user`, `version` | change account PHP version (phase 2, gated) |

Per-domain (vhost) PHP is a separate variant (`LangPHP` / per-vhost functions) — deferred, verify at
phase 3. Phase 1 is account-level read only.

### ResourceUsage

| Function | Key params | Used by |
|---|---|---|
| `get_quota` | `user` | HOST panel: disk / inode / bandwidth / CPU |

### RawAccess (logs) — phase 1

`RawAccess::list_raw_access_logs` (or the current equivalent) returns the error/access log list + tail.
**Exact function name verified at build time** — the module name is `RawAccess`; do not recall the
function name.

### Phase-3 modules (DNS / DB / email / SSL) — names verified at phase 3

`ZoneEdit` (DNS records), `Mysql` (databases), `Email` (accounts), `SSLInfo`/`Market` (SSL/AutoSSL).
Listed here so the client is shaped to hold them, not spec'd down to the last param yet.

---

## 3. Data model (additive migration, ships with a `.sql` — hazard H8)

```prisma
model CpanelConnection {
  id             String   @id @default(uuid())
  created_by_id  String
  owner          User     @relation(fields: [created_by_id], references: [id], onDelete: Cascade)
  project_id     String
  project        Project  @relation(fields: [project_id], references: [id], onDelete: Cascade)

  host           String            // e.g. "cpanel.example.com" (no scheme, no port)
  username       String            // cPanel account login (builds the auth header)
  api_token      String   @db.Text // encrypted at rest via connectionSecrets.js
  home_dir       String?           // "/home/<user>" — from a connect-time probe
  doc_root       String?           // "/home/<user>/public_html" (or the project's vhost docroot)
  php_version    String?           // cached from MultiPHP::list_versions
  meta           String?  @db.Text // JSON — last status, last deploy snapshot ref

  created_date   DateTime @default(now())
  updated_date   DateTime @updatedAt

  @@unique([project_id])
  @@map("cpanel_connections")
}
```

A `CpanelConnection` is **one account per project**. Multi-vhost-per-account is a later extension:
store the vhost/docroot in `meta` rather than a new table until it is actually needed.

---

## 4. The client — `server/src/lib/cpanel.js`

```js
// all async; all throw typed errors; NONE print a full UAPI response
cpanelRequest(conn, module, func, params, { method = 'GET' }) -> data          // unwraps result.data
cpanelProof(host, username, token)            -> { ok, home_dir?, error? }     // verify-before-store
cpanelListFiles(conn, { dir, types, limit })  -> { files: [{name,type,path,size,mtime,perms}] }
cpanelReadFile(conn, path, { maxBytes })      -> { content, truncated }
cpanelWriteFile(conn, path, content)          -> { ok, error? }
cpanelTrash(conn, path)                       -> { ok, error? }                // reversible delete only
cpanelListPhpVersions(conn)                   -> { current, available:[{version,handler,default}] }
cpanelSetPhpVersion(conn, version)            -> { ok, error? }                // gated, phase 2
cpanelQuota(conn)                             -> { disk_used, disk_quota, inode_used, inode_quota, ... }
cpanelListLogs(conn, { maxBytes })            -> { logs:[{path,bytes,content,truncated}] }
```

**Rules baked into the client:**

1. **Path safety** — every path is resolved against `doc_root` and refused if it escapes it
   (`path.resolve` + prefix check). No `..`, no absolute paths outside `doc_root`, no symlink escapes
   (resolve realpath first).
2. **One value at a time** — a caller asks for one field; the client returns it. Never `return res.json()`
   wholesale into a log/transcript (the runtime-env exposure lesson).
3. **Error triage** — maps to three named failures: `CPANEL_AUTH` (401 / bad token), `CPANEL_NOT_FOUND`
   (route/module missing → older cPanel), `CPANEL_UPSTREAM` (network/timeout/5xx). The UI renders each
   as an actionable message, never raw text.
4. **Prove-before-store** — `cpanelProof` calls `ResourceUsage::get_quota` with the token; a valid
   answer (status 1 + `home_dir`-adjacent data) is the proof. Wrong token → refuse to save, say so.

---

## 5. Function layer (`server/src/functions/`, one file each)

All follow the dispatcher's `requireAuth` + ownership pattern (`server/src/routes/functions.routes.js`).
No function is ADMIN-only; each re-checks the row's `created_by_id` and `project_id`.

| Function | Request body | Returns | Notes |
|---|---|---|---|
| `cpanelConnect` | `{ host, username, apiToken, projectId }` | `{ ok, home_dir, php_version }` | proof → recon → upsert |
| `cpanelStatus` | `{ projectId }` | `{ connected, host, username, php_version, doc_root, quota, lastDeploy }` | read-only |
| `cpanelFiles` | `{ projectId, dir, action: 'list'\|'read', path?, maxBytes? }` | tree or file content | read-only |
| `cpanelFileWrite` | `{ projectId, path, content, confirm? }` | `{ ok, snapshot?, verified? }` | phase 2; snapshot + verify |
| `cpanelLogs` | `{ projectId, maxBytes? }` | `{ logs:[...] }` | read-only |
| `cpanelPhpVersion` | `{ projectId, action: 'list'\|'set', version? }` | `{ current, available }` or `{ ok }` | `set` is phase 2, gated |
| `cpanelDisconnect` | `{ projectId }` | `{ ok }` | deletes the row |

Error responses use the platform's `{ ok:false, error, message, status }` shape with stable machine
codes (`CPANEL_AUTH`, `CPANEL_NOT_FOUND`, `CPANEL_UPSTREAM`, `PATH_OUTSIDE_DOCROOT`, `NOT_CONNECTED`).

---

## 6. Deploy adapter — `server/src/lib/delivery/cpanel.js`

Registered in `delivery/index.js` as `{ id: 'cpanel' }`, conforming to the same adapter interface the
wordpress one implements (`shipChange`, merge/rollback, health check, `coverageVerdict`).

**Config** (resolved from the connection): `{ host, username, token, docRoot, healthPaths }`.

**ship path (how self-dev injects code):**

1. **Diff** the produced tree against the last-shipped tree → list of changed files.
2. **Deny-check** every path against `CPANEL_DENY_PATHS` (below) — a denied path aborts, naming it.
3. **Snapshot** — for each changed file, `get_file_content` + copy to a timestamped backup beside it
   (`.morpheus-bak-<UTC>`), never delete.
4. **Write** — `save_file_content` (small files) or `upload_files` (bulk) into `docRoot`.
5. **Probe** — fetch the site's `healthPaths` and compare bytes (status alone is not "up").
6. **On failure** — restore every snapshot, then report `{ ok:false, rolled_back:true, reason }`.
7. **Record** — write `{ outcome, code, message, at }` into the connection `meta` (a refusal leaves a
   record, or it reads as a broken button).

**`CPANEL_DENY_PATHS`** (enforced in code at ship time, never by convention):

```
/\.env($|\/)/           credentials
/\.git\//               repo internals
/\.htaccess$/           server config (gated, not auto)
/\.htpasswds?\//        auth files
/\.cpanel\//            cPanel's own dir
/\.well-known\/acme-challenge\//   SSL issuance
any path resolving outside docRoot
```

**`coverageVerdict`** — three states, like WordPress: `passed` (JS/TS covered), `failed` (syntax error),
`not_verified` (PHP/static-only change → report code 2, ships but says so). Only `failed` blocks. A
cPanel site is usually PHP/static, so `not_verified` is the normal answer, not an accident.

---

## 7. Onboarding wizard — the "what kind of site" branch

`SetupTab.jsx` gains a chooser **before** the WordPress-specific steps:

1. **"What is this site?"** → `WordPress` | `cPanel / self-hosted` (future: `static / SSH`, `Shopify`, …).
2. If **cPanel**: ask `host`, `username`, and the **API token** (password field, masked). Copy says the
   token is scoped and revocable, and is stored encrypted. Link: "How to get a token" → cPanel → Security
   → Manage API Tokens.
3. **Connect** → `cpanelConnect` → prove → recon (`home_dir`, `php_version`, quota) → HOST tab appears.
4. Every failure state links somewhere: bad token → "re-check the token / regenerate it"; unreachable
   host → "is the host reachable on :2083 / is the token scoped to it"; old cPanel → "this host's cPanel
   predates Fileman, update or contact the host".

The chooser is a **connection-type enum**, not more bespoke tabs — so static/SSH and SaaS slots in later
without reworking the wizard.

---

## 8. HOST panel (app surface)

Tabs: **Overview** (quota, PHP version, host, docroot), **Files** (tree + read + write/rename/trash —
write gated and phase 2), **Logs** (error/access tails), **PHP** (list + set, set gated). Later: DNS,
Databases, Email, SSL.

Read-only by default; a `scan_enabled`-style switch gates writes, and `set` operations are never
swept into a bulk action (same rule as HEALTH/AI-fix).

---

## 9. Mock harness — build and test without live cPanel

UAPI is plain HTTP, so the harness is a tiny mock server (like the WordPress dock-rig / plugin harness):

- Serves `/execute/Module/function` with fixture JSON per function.
- `ResourceUsage::get_quota` → fixed quota; `Fileman::list_files` → fixture tree; `get_file_content` /
  `save_file_content` → in-memory file store so a write is observable and revertible.
- A **stateful** host for the deploy path: after `save_file_content`, `/health` serves the new bytes;
  a `?mode=broken` fixture makes the probe fail so the rollback path is exercised end-to-end.
- A dev-only route `/__fixture/…` to flip host state across the scan→write boundary (the debug-log
  harness seam, reused).

This is what lets phase 1 and phase 2 be built and verified **before** Rob's token arrives; the only
thing a live token adds is the final smoke against HostPapa.

---

## 10. Migration + deployment

- Additive `server/prisma/add-cpanel-connections.sql` + schema change; `verify-schema-prod.mjs` must
  exit 0 after the migration lands (hazard H11 — a migration file is not proof it ran).
- Every read in `lib/cpanel.js` degrades to `NOT_CONNECTED`/`503` when the table is absent (the
  smallest-blast-radius pattern, per `AppCapabilityGrant`).

---

## 11. Deferred until credentials (the only things left)

1. **Live smoke** against valiantmusic.com.au / HostPapa: prove token → real `list_files` on
   `public_html` → real log tail → real quota.
2. **Host-specific quirks** — HostPapa's cPanel version (does `Fileman`/`MultiPHP`/`RawAccess` match?),
   any firewall/proxy on `:2083`, and whether scoped token privileges are available or it's all-or-nothing.
3. **Per-domain vs account PHP** — whether the site is its own vhost (per-domain `set_version`) or the
   account default is enough.

Everything else above is buildable now against the mock harness.

---

*UAPI function names verified against api.docs.cpanel.net (Fileman) and cpanel-rs 0.3.0 (MultiPHP,
ResourceUsage) on 2026-10-15. RawAccess / phase-3 module names to be re-verified at build time.*
