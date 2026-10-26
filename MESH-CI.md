# Mesh CI — this repo's verification, without GitHub

**The command:**

```
node scripts/verify.mjs
```

It runs every `scripts/verify-*.mjs` guard, then `boot-smoke` (which boots `server/src/index.js` in
production mode and asserts `/api/health` returns 200), then `verify-schema-prod` and
`verify-billing-ledger` on their own — those two need a production credential and report
"not verified" (exit 2) rather than pass/fail. A missing credential is never a pass.

**Why this file exists.** `verify-ci-on-mesh` in the mesh repo fails a repo that has GitHub-hosted
workflows and no declared mesh path. This repo has seven GitHub workflows; four of its jobs are
already self-hosted (`studio mac (self-hosted)`), so GitHub is partly our own hardware already — but
the mesh path has to be stated, because on 2026-10-26 GitHub-hosted Actions failed on billing
("recent account payments have failed or your spending limit needs to be increased") and a
verification path that depends on a subscription is not a verification path.

**Where it runs:** the Mac, or a dispatched mesh node (Linux work goes to `studio-linux`, Windows to
`win-2`). `server/.env` must be present for the boot step and the two prod checks.
