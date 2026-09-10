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

The **armed write path** (v0.2) is driven with a fake GitHub client against
a scratch site root under `sys_get_temp_dir()`, asserting:

- happy path — new file written, changed file updated, removed file deleted,
  a denied path (`wp-config.php`) left untouched and reported, snapshot taken
- an unsafe path (`../evil`) in the change set aborts the whole deploy —
  nothing written, not even safe sibling files
- a failed post-write health check rolls back — changed files restored,
  created files removed, untouched files left alone
- a blob-sha mismatch (content corrupted in transit) rolls back
- `rollback_last()` — the operator "undo" — restores the previous deploy
- not armed → report only, files untouched

66 assertions, all green on PHP 7.4 and 8.2.
