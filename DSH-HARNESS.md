# DSH harness setup

This repo is developed through **DSH** (DeepSeek Harness), replacing Claude Code.
Setup was installed on 2026-09-19. This document records what was changed, the
manual steps that remain, and how to verify or roll back.

## What was installed

### 1. Project skills — `.dsh/skills/`

DSH auto-discovers skills at `<projectRoot>/.dsh/skills/<name>/SKILL.md`, where
`projectRoot` is the nearest ancestor containing `.git`. They are catalogued at
session start and loaded on demand, so they cost nothing until relevant.

The skill list is **not repeated here** — it went stale here first (this table
said three skills when there were nine, and stopped at H10 when there were
twelve), and `AGENTS.md` now carries the maintained map with a check behind it.

| Where | What |
|---|---|
| `AGENTS.md` — "Agent harness (DSH)" | the maintained skill table and the hard rules; `verify-context.mjs` fails if a skill on disk is missing from it |
| `.dsh/skills/morpheus-hazards` | the H1–H20 checklist, condensed with each rule |

`KNOWN-HAZARDS.md` remains the authoritative hazard source — the skill mirrors it.

**One limitation worth knowing:** skills are catalogued **at session start**, so a
skill added during a session is not loadable until the next one — `skill <name>`
answers "unknown or no longer available" even though the file is on disk and
already merged. For this session, read the file directly; for the next, it is in
the catalog.


### 2. Push guardrail — `.githooks/pre-push`

Refuses any push to (or deletion of) `main`/`master`. Enabled with:

```bash
git config core.hooksPath .githooks
```

Already applied in this working copy. It is **local** enforcement — see
"Server-side enforcement" below for the part that cannot be bypassed.

`git push --no-verify` bypasses it. Do not use it.

### 3. Task helper — `scripts/dsh-new-task.sh`

```bash
scripts/dsh-new-task.sh fix-deck-widget-auth
```

Fetches `origin`, refuses to run on a dirty tree, and creates `dsh/<slug>` from
`origin/main`. This is the fix for H9's precondition: work can never be based on
a stale local snapshot.

### 4. Browser automation — Playwright CLI, not MCP

Browser work goes through the Playwright CLI (`@playwright/cli`), wrapped by
`scripts/pw`:

```bash
scripts/pw open http://localhost:5173
scripts/pw find "Command Deck"
scripts/pw close
```

This replaced the Playwright MCP server, which is kept commented out in
`~/.dsh/profiles/web/cordis.patch.yml` as a fallback.

**Why the CLI:** MCP tool schemas enter every request's prefix, and
`browser_snapshot` returns an entire accessibility tree inline. The CLI writes
snapshots to files and `find` returns only matching nodes — tens of thousands of
tokens saved per page interaction.

**Two sandbox constraints make the wrapper mandatory** (both solved, but a raw
`playwright-cli` call will still fail):

1. Playwright's daemon and browser registry are hardcoded to
   `$HOME/Library/Caches/ms-playwright` on macOS, with no env override, and the
   Seatbelt sandbox denies writes there. `scripts/pw` points `HOME` at
   `.playwright/home/`.
2. macOS forbids nested sandboxes, so Chrome cannot initialize its own sandbox
   inside Seatbelt. `.playwright/cli.config.json` launches it with `--no-sandbox`
   (Chrome's sandbox, not DSH's) plus a workspace-local profile directory.

Symptoms of bypassing the wrapper: `Target crashed`, or
`EPERM ... mkdir '.../ms-playwright/daemon'`.

The MCP fallback works under the sandbox *without* these fixes, because the
harness spawns MCP servers outside the agent's bash sandbox.

### 5. `AGENTS.md`

Gained an "Agent harness (DSH)" section stating the hard rules. DSH reads
`AGENTS.md` automatically on every session, so these rules are always in context.

## Manual steps that remain

Written on 2026-09-19. Most were done within a day; the statuses are below
because a list of "steps that remain" that is never updated is how a setup
document turns into a lie.

### a. ~~Re-authenticate `gh`~~ — DONE

`gh auth status` reports a valid token for `robmitchellengineering-hub` with
scopes `gist, read:org, repo, workflow`. Note it does **not** include
`delete_repo`, so a repo created by a browser test cannot be deleted from the
shell — the app's own OAuth connection has that scope.

### b. ~~Open the repo as the DSH workspace~~ — SUPERSEDED

The workspace is still `/Users/mac/Documents/DeepSeek`, but the file policy is now
`danger-full-access`, so writes to the repo no longer need a per-operation
escalation. Opening the repo as the workspace would still be tidier; it is no
longer required to work.

### c. ~~Restart DSH to activate the MCP server~~ — DONE

The Playwright MCP tools are present in the session. Note that browser work
normally goes through the `scripts/pw` CLI instead — see section 4 for why the
wrapper exists.

### d. Server-side enforcement (strongly recommended)

The `pre-push` hook is local and bypassable. The enforceable version is GitHub
branch protection on `main`:

```bash
gh api -X PUT repos/robmitchellengineering-hub/morpheus-self-hosted/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -F "required_pull_request_reviews[required_approving_review_count]=1" \
  -F "enforce_admins=true" \
  -F "restrictions=" \
  -F "required_status_checks="
```

Note: the product's own self-dev flow (`pushSelfDevToGithub.js`) writes to
`main` through the GitHub API and is **not** affected by git hooks. Branch
protection would therefore also block that flow — decide deliberately before
enabling it, or scope the protection to require review only from non-bot pushes.

### e. Merge this branch

The setup is committed on `dsh/agent-harness-setup`. Push it and open a PR once
`gh` is re-authenticated:

```bash
git push -u origin dsh/agent-harness-setup
gh pr create --fill
```

## Watching usage

```bash
scripts/usage          # current session ($DSH_SESSION_ID)
scripts/usage --all    # every cached session
scripts/usage --json   # machine-readable
```

Reads the harness session projection cache — no model calls, nothing billed —
and estimates cost at DeepSeek `deepseek-flash` rates verified 2026-09-19. The
authoritative figure is https://platform.deepseek.com/usage.

The GUI's "{percent} of context used" indicator renders the same data. DSH
tracks tokens, not money: there is no cost display in the UI, so this script
is the only local estimate.

## Verification

```bash
# guardrail installed and blocking
cd /Users/mac/code/morpheus-self-hosted
git config core.hooksPath                       # -> .githooks
echo "refs/heads/main a b c d" | ./.githooks/pre-push origin x   # -> exit 1

# skills present
ls .dsh/skills/

# MCP row composed into the profile
dsh --profile web --dump-config | grep -A8 mcp-playwright
```

Browser smoke test (with the Vite dev server running on :5173):

```bash
scripts/pw open http://localhost:5173
scripts/pw find "Command Deck"
scripts/pw close
```

## Known environment issues

- **Sandbox vs. tool caches.** The DSH file sandbox denies writes outside the
  workspace. This makes `npm`/`npx` fail with a misleading
  `EPERM ... root-owned files` message, because they cannot write `~/.npm`. Use
  `npm_config_cache` pointed at a writable path (the commented-out MCP row shows
  the pattern). If you want a wider sandbox generally, launch with
  `DSH_PERMISSION_MODE` set (see `sandbox-policy` in the profile).
- **Browser automation needs `scripts/pw`.** See section 4 — the raw
  `playwright-cli` fails under the sandbox by design, not by misconfiguration.
- **`pnpm` is not installed**, so `dsh plugin --profile web add <pkg>` cannot
  run yet. It is not needed for this setup — the profile resolves plugin
  packages through the CLI's own `node_modules` fallback. Install pnpm
  (`corepack enable pnpm`) only if you need to add packages that aren't already
  present.

## Rollback

```bash
# profile patch (a timestamped backup was left beside it)
ls ~/.dsh/profiles/web/cordis.patch.yml.bak-*

# git guardrail
git config --unset core.hooksPath

# skills
rm -rf .dsh/skills
```
