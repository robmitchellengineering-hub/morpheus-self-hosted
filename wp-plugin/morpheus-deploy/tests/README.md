# Morpheus Deploy — tests

The plugin is tested in a **real WordPress** using [WordPress Playground
CLI](https://wordpress.github.io/wordpress-playground/) — WASM PHP, so no
Docker and no system PHP install. It's free and runs anywhere Node runs.

```bash
cd wp-plugin/morpheus-deploy
./tests/run.sh          # php -l all files, then the harness on PHP 8.2
./tests/run.sh 7.4      # minimum supported version
```

`harness.php` boots WordPress with the plugin mounted and active, then:

- checks the plugin loaded and registered its REST routes
- unit-tests the security-critical helpers — the hard deny-list,
  path-traversal safety, `git_blob_sha` (asserted against real
  `git hash-object` output), constant-time HMAC verification
- drives `/wp-json/morpheus/v1/status` and `/wp-json/morpheus/v1/deploy`
  through `rest_do_request()` — missing / bad / stale signatures, missing
  commit
- runs a **real dry-run** against the public `octocat/Hello-World` repo
  (outbound fetch to api.github.com), asserting the diff report

43 assertions, all green on PHP 7.4 and 8.2.

## What's not covered yet

The write path (v0.2, behind the `armed` toggle) — file writes, the
snapshot, the post-write health check, and auto-rollback. Those tests land
with that code, and will use a scratch WordPress tree in the Playground VFS
as the write target so nothing real is touched.
