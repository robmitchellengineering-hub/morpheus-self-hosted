=== Morpheus Deploy ===
Contributors: morpheus
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 0.1.0
License: GPLv2 or later

Deploys code changes to this site from a connected GitHub repo — no FTP.

== Description ==

Morpheus builds changes to your site through chat, opens a pull request on
your connected GitHub repo, and — once its checks pass and the PR merges —
calls this plugin's endpoint. The plugin verifies the request signature,
diffs the merge commit against what's on disk, and (from v0.2) writes only
the changed files, health-checks the site, and rolls back automatically if
anything breaks.

It never touches wp-config.php, wp-content/uploads, cache directories, .git,
.htaccess, or .env — that deny-list is enforced in the plugin's own code,
independent of your repo's .gitignore.

= Version 0.1.0 =

Dry-run only. The endpoint reports what a deploy *would* change and never
writes a file. Use it to connect the repo, set the shared secret, and
confirm the diff looks right before writes are enabled.

== Installation ==

1. Upload the `morpheus-deploy` folder to `wp-content/plugins/` and activate.
2. Settings → Morpheus Deploy: set the repo (`owner/repo`), branch, a GitHub
   token with Contents:read, and a deploy secret.
3. Give Morpheus the same secret and the endpoint URL shown on the settings
   screen.

== Endpoints ==

* `POST /wp-json/morpheus/v1/deploy` — signed (`X-Morpheus-Signature:
  sha256=<hmac>`), body `{ "commit": "<sha>", "reason": "...", "at": "<iso>" }`.
* `GET /wp-json/morpheus/v1/status` — unauthenticated; reports version and
  whether the plugin is configured.

== Changelog ==

= 0.1.0 =
* Initial release. Settings screen, signed deploy endpoint, dry-run diff.
