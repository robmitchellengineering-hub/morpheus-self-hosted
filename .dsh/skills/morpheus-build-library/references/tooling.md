# Environment and tooling traps

## Background jobs and processes
* `pkill -f <pattern>` can kill the job you just started — a harness run matched
  its own Playground pattern and died mid-lint with no output. Check
  `job_list` first, and prefer the job's own `job_kill`.
* Piping a long-running job through `tail` buffers everything, so "no output"
  means "still running", not "silent failure". Write to a file and read it.
* A dev server started with `npm run dev` and a browser session are easy to lose
  track of: verify the ports are answering before blaming the code, and stop them
  when done.

## Browser automation (`scripts/pw`, playwright-cli)
* Element refs go stale after any navigation or re-render; re-snapshot before
  clicking something you looked up earlier.
* `localStorage` reads throw a `SecurityError` on an error page
  (`chrome-error://`), which silently turns a token comparison into
  "DIFFERENT". Navigate to a real origin first.
* `fill` can fail on a controlled input mid-render. Verify the value stuck before
  pressing Enter.
* Snapshot output collapses whitespace, so a multi-line message renders as one
  line. Do not conclude the newlines are missing.
* Prefer `find "<text>"` and a CSS selector (`button[title='Rename construct']`)
  over scraping refs by hand.

## GitHub
* The `gh` CLI token here has `gist, read:org, repo, workflow` — **not**
  `delete_repo`, so a repo created by a test cannot be deleted from the shell.
  The app's own OAuth connection does have it, which is what
  Settings → GitHub → DELETE uses.
* Creating a repo in a browser test leaves real clutter in someone's account.
  Prefer an existing scratch repo, or do not press the button.

## WordPress Playground (the plugin harness)
* Boots take 40–70 seconds; the first request after "Ready!" can still 302 while
  the site installs. Poll `/wp-json/morpheus/v1/status` until it answers JSON.
* `--login` puts the whole site behind an auth redirect, which a cookie-less API
  client cannot satisfy — useful for screenshotting wp-admin, useless as a probe
  target.
* The plugin is mounted from the working tree, so WordPress "upgrading" it would
  move files out of the repository. Upgrade a fixture plugin instead.
* Auto-mount reads live, so a PHP edit is picked up without a restart.

## macOS and this shell
* There is no `timeout` command. Use a background job plus your own deadline, or
  Node's own timeout.
* No system `php`, no `brew`: syntax-check PHP through Playground
  (`php -l`), which is also what the harness does.
* `node --check` validates syntax only — it never resolves an import. A wrong
  module *source* (`createHash` from `node:fs`) parses fine and dies at load.
  Run the thing and check the exit code rather than grepping its output.

## Edits
A multi-step scripted edit that aborts partway **looks applied** — one block
replaced the file, a later block raised, and the state was written while the UI
that reaches it never was. After any scripted edit, prove the change is in the
file (grep) and in the rendered output (the DOM), not just in the console output
that said it worked.

## Sandbox and toolchain

* **Browser automation goes through `scripts/pw`, not a raw `playwright-cli`.**
  Two constraints make the wrapper mandatory, and both were solved there rather
  than configured: Playwright hardcodes its daemon and browser registry to
  `$HOME/Library/Caches/ms-playwright` with no env override, so `scripts/pw`
  points `HOME` at `.playwright/home/`; and macOS forbids nested sandboxes, so
  Chrome cannot start its own sandbox inside DSH's and must be launched with
  `--no-sandbox` (Chrome's sandbox, not DSH's) plus a workspace-local profile.
  Symptoms of bypassing it: `Target crashed`, or
  `EPERM … mkdir '…/ms-playwright/daemon'`. Playwright MCP works without these
  fixes only because the harness spawns MCP servers outside the bash sandbox.
* **`npm`/`npx` can fail with a misleading `EPERM … root-owned files`.** That is
  the file sandbox denying writes to `~/.npm`, not a corrupt cache. Point
  `npm_config_cache` at a writable path.
* **`pnpm` is not installed**, which is why the profile resolves plugin packages
  through the CLI's own `node_modules` fallback. `corepack enable pnpm` only if
  you actually need to add packages.
* **Session logs are compressed** (`.jsonl.zstd`) — read them with
  `scripts/sessions.mjs`, not `zcat`-and-grep guesswork.
* **The push guardrail is local and bypassable.** `git config core.hooksPath
  .githooks` installs a `pre-push` hook that refuses any push to `main`; verify
  it with `echo "refs/heads/main a b c d" | ./.githooks/pre-push origin x` →
  exit 1. `git push --no-verify` skips it. Never use it — the hook is the
  mechanical form of the rule, and server-side branch protection is deliberately
  not enabled because self-dev's own delivery flow writes to `main` through the
  GitHub API and hooks cannot see it.
