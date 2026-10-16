# cPanel Hosting Connector — Scoping Plan

**Status:** draft for review · **Date:** 15 October 2026 · **Repo:** morpheus-self-hosted

## 1. Objective

Add **cPanel** as a first-class connection type for Morpheus, alongside WordPress. A cPanel
connection does two jobs that share one credential:

1. **Management** — a "HOST" surface for the hosting backend the WordPress plugin cannot reach:
   files in the web root, PHP version, error/access logs, and (later) DNS, databases and email.
2. **Deploy target** — the same way self-dev can inject code into the frontend (Netlify) and the
   WordPress site (via the plugin), it can inject produced code into a cPanel-hosted site, with
   snapshot → verify → rollback rails.

Both jobs read the same encrypted cPanel **API token** (never a password) and the same
`lib/cpanel.js` client.

## 2. Why cPanel first

- cPanel is the control panel for **HostPapa and the large majority of shared hosting** — one
  connector covers a market segment, not just Rob's site.
- The thing that has already blocked us is exactly this layer: the physical `robots.txt` that needed
  "HostPapa → cPanel → File Manager" (see `KNOWN-HAZARDS` / the robots quarantine work). File
  management unblocks it.
- The pattern to copy already exists — the WordPress plugin is the same "customer's own connection,
  signed, narrow, verifiable" shape.

## 3. What exists today (the pattern we copy)

| Concern | Existing mechanism |
|---|---|
| Connection row | `PluginConnection` (`@@map("plugin_connections")`) — `kind`, `site_url`, `webhook_secret` (encrypted), `repo`, `meta` |
| Encrypted secrets | `server/src/lib/connectionSecrets.js` (`encodeConnections`/`decodeConnections`, via `crypto.js`) |
| Function dispatch | `server/src/routes/functions.routes.js` — one file per function in `server/src/functions/`, `requireAuth` + widget/device scope checks |
| Deploy target | `server/src/lib/delivery/` — `wordpress.js` (id `'wordpress'`), `selfDev.js`, `http.js` (probe) |
| Onboarding | SETUP wizard (`SetupTab.jsx`) — detects WordPress via `/status`, compares `plugin-manifest.json` |
| Prove-before-store | WordPress: signed POST to `/deploy` with an invalid commit → 400 (verified) vs 401 (wrong secret) |

The rule this plan follows, stated in the repo: **"it's always the customer's connection — we are
just facilitating."** No platform-owned cPanel account, no fallback credential.

## 4. Data model

New Prisma model `CpanelConnection` (additive migration, ship with a `.sql` like the other additive
migrations — hazard H8):

```prisma
model CpanelConnection {
  id             String   @id @default(uuid())
  created_by_id  String
  owner          User     @relation(fields: [created_by_id], references: [id], onDelete: Cascade)
  project_id     String
  project        Project  @relation(fields: [project_id], references: [id], onDelete: Cascade)

  host           String            // cPanel host (e.g. cpanel.<domain> or host:2083)
  username       String            // cPanel account login (needed to build the auth header)
  api_token      String   @db.Text // encrypted at rest (connectionSecrets.js)
  home_dir       String?           // cached /home/<user> from a probe
  php_version    String?           // cached from MultiPHP::get_php_version
  meta           String?  @db.Text // JSON — last status, last deploy snapshot ref, etc.

  created_date   DateTime @default(now())
  updated_date   DateTime @updatedAt

  @@unique([project_id])
  @@map("cpanel_connections")
}
```

One cPanel connection per project (unlike WordPress's `[project_id, kind]` composite unique, because
a project has one host; revisit if multi-host-per-project ever becomes real).

## 5. The cPanel client (`server/src/lib/cpanel.js`)

- **Auth:** `Authorization: cpanel <username>:<token>` header; base URL `https://<host>:2083/execute/`.
- **Prove before store** (mirror the WordPress lesson — `/status` `signing: true` only means *a*
  secret is set): on connect, call a harmless UAPI function and require a valid, expected-shape
  answer before saving the token. Invalid → refuse to store and say why. Never a silent "connected".
- **One value at a time** — never dump a whole UAPI response into a transcript/log (the runtime-env
  exposure lesson); read and hash what matters.

UAPI modules the client will wrap (exact function names re-verified against
`api.docs.cpanel.net` at build time, not recalled):

| Capability | UAPI module | Phase |
|---|---|---|
| Files (list / read / write / rename / trash) | `Fileman` | 1 |
| PHP version (account + per-domain) | `MultiPHP` | 1 |
| Error & access logs | `RawAccess` | 1 |
| DNS records | `ZoneEdit` | 3 |
| Databases | `Mysql` | 3 |
| Email accounts | `Email` | 3 |
| SSL / AutoSSL status | `SSLInfo` / `Market` | 3 |

## 6. Management surface ("HOST")

- New **HOST tab** in the app (app-panel only, like SETUP/EMBED — it needs the connection to exist).
- Functions in `server/src/functions/` (one file each): `cpanelStatus`, `cpanelFiles` (list/read),
  `cpanelFileWrite`, `cpanelLogs`, `cpanelPhpVersion`. Each follows the existing dispatcher rules.
- **Read-only first.** `scan` and `apply` are separate permissions, same as the plugin's HEALTH
  (`scan_enabled` grants a scan and nothing else). Nothing may infer write from read.
- **No reimplementation of cPanel.** The HOST panel shows what cPanel reports and links into cPanel
  for what it does not wrap; it is not a second File Manager.

## 7. Deploy target (`server/src/lib/delivery/cpanel.js`)

A delivery adapter with id `'cpanel'`, registered in `delivery/index.js` next to `wordpress`. It is
how self-dev / build-loop output reaches a cPanel site:

- **ship** — take the produced tree, diff against the last-shipped tree, stage the changed files.
- **write** — `Fileman::save_file_content` / `upload_files` into the site's web root, with a
  **snapshot first** (copy each touched file to a timestamped backup beside it, never delete).
- **verify** — probe the site's key pages (`delivery/http.js` probe) after the write.
- **rollback** — restore the snapshot if the probe fails, and record the attempt.
- **deny-list** — the cPanel analogue of `PLUGIN_DENY_PATHS`: never touch `.env`, cPanel config,
  `.git`, credentials, or anything outside the site's own web root. Enforced in code, not by policy.
- **coverage verdict** — three states (`passed`/`failed`/`not_verified`), because a cPanel site is
  usually PHP/static and the JS-only syntax check covers zero files (hazard H17). Only `failed` blocks.

This is the "inject code from self-dev the same as the front end" requirement: the build loop gains
a cPanel destination with the same discipline as the WordPress adapter — the difference is the write
goes over cPanel UAPI instead of a signed webhook to a PHP plugin.

## 8. Onboarding wizard — the "what kind of site" branch

The SETUP wizard becomes a chooser with two (later more) branches:

1. **WordPress** — existing pairing (detected via the `/wp-json` signature or asked).
2. **cPanel / self-hosted** — ask for `host`, `username`, and a cPanel **API token** (scoped). Prove
   the token, then read-only recon (`home_dir`, `php_version`, site layout) and offer the HOST panel.

Future branches (explicitly out of scope now): static sites via git+SSH, and per-SaaS APIs. The
wizard's data model should be a **connection-type enum**, not more bespoke tabs.

## 9. Safety rails (the non-negotiable part)

Host file operations are more dangerous than WordPress ones — there is no plugin to quarantine
against. Every one of these is copied from a lesson the plugin already paid for:

1. **Deny-list enforced in code**, applied at ship time so a denied path never reaches a branch.
2. **Snapshot before write, restore on failed verify**, and a recorded attempt per change — a refusal
   leaves a record or it reads as a broken button.
3. **Byte comparison, not status** — "is this file served" = fetch the URL and compare bytes
   (`morpheus_bodies_match`'s lesson), never HTTP 200 alone.
4. **Never delete — rename/trash** to a timestamped name beside the original.
5. **Major/irreversible ops are never automatic** (account-level PHP version change on a live site,
   DNS record delete) — reported for a human.
6. **Prove before store** — the token is verified working before the connection row is written.

## 10. Phases

| Phase | Scope | Exit criterion |
|---|---|---|
| **1** | Connect + prove token; read-only recon; HOST panel: files (list/read), logs, PHP version read | Rob can open HOST for valiantmusic.com.au and see real files/logs/PHP |
| **2** | File **write** with snapshot/verify/rollback; `delivery/cpanel.js` adapter; self-dev can ship code to a cPanel site | A build loop pushes a change to a cPanel test site, verifies, and rolls back on a forced failure |
| **3** | DNS (`ZoneEdit`), databases (`Mysql`), email (`Email`), SSL status | Each is read-first then apply, gated like HEALTH |

## 11. Risks & unknowns

- **cPanel API version drift** between hosts (HostPapa may pin an older cPanel) — probe the version
  at connect and degrade explicitly rather than assume endpoints exist.
- **Token scope granularity** — not every host exposes fine-grained scoping; if a host only offers
  an all-privilege token, say so and warn, but still prefer token over password.
- **`Fileman` limits** — upload size / path traversal rules differ; cap and sanitize every path.
- **One host, one project** assumption may need revisiting (multi-site cPanel accounts exist).

## 12. What this is NOT

- Not a WHM/root server connector (that's a different, higher-privilege surface).
- Not a replacement for cPanel itself, and not a general "any website" adapter — static/SSH and SaaS
  are separate future connectors behind the same wizard.
- Not a panel inside the WordPress plugin — it is a sibling connection, not a wp-admin feature.

## 13. Decisions needed from Rob

1. **Phase 1 scope** — start read-only (files/logs/PHP) and land the HOST panel before any write
   path? (Recommended — writes are where the danger is, and read-only proves the token + UI first.)
2. **Target site** — valiantmusic.com.au on HostPapa for the first real connection.
3. **Token** — cPanel **API token** (scoped), generated in cPanel → Security → Manage API Tokens;
   it goes into a Morpheus field, never into chat.

---

*Grounded in: `server/prisma/schema.prisma` (PluginConnection), `server/src/lib/connectionSecrets.js`,
`server/src/lib/delivery/{index,wordpress,selfDev,http}.js`, `server/src/routes/functions.routes.js`,
and the build-library WordPress/connections cards. cPanel UAPI function names to be re-verified at
build time against api.docs.cpanel.net.*
