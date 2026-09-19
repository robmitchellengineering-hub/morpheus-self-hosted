# DSH harness setup

This repo is developed through **DSH** (DeepSeek Harness), replacing Claude Code.
Setup was installed on 2026-09-19. This document records what was changed, the
manual steps that remain, and how to verify or roll back.

## What was installed

### 1. Project skills — `.dsh/skills/`

DSH auto-discovers skills at `<projectRoot>/.dsh/skills/<name>/SKILL.md`, where
`projectRoot` is the nearest ancestor containing `.git`. They are catalogued at
session start and loaded on demand, so they cost nothing until relevant.

| Skill | Purpose |
|---|---|
| `morpheus-dev-protocol` | Branch/PR workflow, never-push-`main`, resync rules, the single-writer constraint |
| `morpheus-hazards` | The H1–H10 checklist, condensed with each rule |
| `morpheus-stack` | Stack map, key files, commands, verification requirements |

`KNOWN-HAZARDS.md` remains the authoritative hazard source — the skill mirrors it.

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

These need you — they cannot be done by the agent.

### a. Re-authenticate `gh` (blocking all PR work)

The token for `robmitchellengineering-hub` is invalid:

```bash
gh auth login -h github.com
gh auth status
```

Until this is done, no branch can be pushed and no PR opened.

### b. Open the repo as the DSH workspace

The agent's sandbox root is its workspace (`workspaceRoot: process.cwd()`). It
was `/Users/mac/Documents/DeepSeek`, so every write to this repo needed a manual
escalation approval. Open **`/Users/mac/code/morpheus-self-hosted`** as the
workspace in the DSH Web GUI (directory picker) for normal friction-free work.

### c. Restart DSH to activate the MCP server

Profile plugins load at boot. Until DSH is restarted, the Playwright tools do
not exist. Restarting ends the current chat session.

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
