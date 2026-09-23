#!/usr/bin/env bash
# Run the Morpheus plugin test harness in a real WordPress, using the free
# WordPress Playground CLI (WASM PHP — no Docker, no system PHP). First run
# downloads Playground + the PHP/WP images (~cached after).
#
#   ./tests/run.sh            # php -l all files, then the harness on PHP 8.2
#   ./tests/run.sh 7.4        # harness on a specific PHP version
#
set -euo pipefail

PHP_VERSION="${1:-8.2}"
PLUGIN_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
PG="npx --yes @wp-playground/cli@latest"

# Each boot mounts this directory at wp-content/plugins, so a blueprint that
# installs WooCommerce or Yoast for the tests writes them back INTO the plugin
# source — 89 MB of third-party code. Left there, the packer would zip it into
# the published update (it now refuses to, loudly). Clean it before and after,
# including on failure, so a harness run never leaves the tree full of it.
clean_test_plugins() { rm -rf "$PLUGIN_DIR/woocommerce" "$PLUGIN_DIR/wordpress-seo"; }
trap clean_test_plugins EXIT
clean_test_plugins

echo "== php -l (PHP ${PHP_VERSION}) =="
# `|| true` and no `| head -1` inside the substitution: with `set -euo pipefail`
# a pipeline that matches nothing (or whose `head` exits first and SIGPIPEs the
# grep) aborts the whole script with no output at all. That happened, and it
# read as a plugin failure when it was the harness's own flakiness — the worst
# kind of gate, because it fails for a reason that is not the code.
for f in $( cd "$PLUGIN_DIR" && find . -name '*.php' -not -path './tests/*' | sed 's|^\./||' ); do
  out=$( $PG php --php "$PHP_VERSION" --verbosity quiet --mount "$PLUGIN_DIR:/p" -- -l "/p/$f" 2>&1 \
         | grep -iE 'no syntax errors|parse error|syntax error' || true )
  out=$( printf '%s\n' "$out" | head -1 )
  echo "  $f -> ${out:-<no output>}"
  echo "$out" | grep -qi 'no syntax errors' || { echo "LINT FAILED"; exit 1; }
done

echo
echo "== harness: WordPress + WooCommerce + Yoast (PHP ${PHP_VERSION}) =="
# This boot installs WooCommerce so the Store-module tests run, and Yoast so
# the LIVE path exercised is "another SEO plugin is active" — the one where
# Morpheus must drive that plugin's keys and emit nothing itself.
$PG php --php "$PHP_VERSION" --wp latest --verbosity quiet \
  --blueprint "$PLUGIN_DIR/tests/blueprint.json" \
  --auto-mount "$PLUGIN_DIR" \
  --mount "$PLUGIN_DIR/tests:/tests" \
  -- /tests/harness.php

echo
echo "== harness: WordPress + WooCommerce, NO SEO plugin (PHP ${PHP_VERSION}) =="
# The other half of the duplicate-tag rule. A plugin loaded by a blueprint
# cannot be un-loaded mid-run, so "Morpheus owns the head outright" needs its
# own boot — including the rendered <head> assertions and the STORE module's
# page SEO fields, which used to be a silent no-op without Yoast.
$PG php --php "$PHP_VERSION" --wp latest --verbosity quiet \
  --blueprint "$PLUGIN_DIR/tests/blueprint-noyoast.json" \
  --auto-mount "$PLUGIN_DIR" \
  --mount "$PLUGIN_DIR/tests:/tests" \
  -- /tests/harness-noyoast.php

echo
echo "== harness: one-click update through WordPress's own upgrader (PHP ${PHP_VERSION}) =="
# A third boot on purpose: this one runs Plugin_Upgrader for real, which needs
# a writable plugins directory it can install into, and it must never run
# against the same WordPress instance as the assertions above.
$PG php --php "$PHP_VERSION" --wp latest --verbosity quiet \
  --auto-mount "$PLUGIN_DIR" \
  --mount "$PLUGIN_DIR/tests:/tests" \
  -- /tests/harness-updates.php

echo
echo "== harness: site maintenance — snapshot, update, verify, restore (PHP ${PHP_VERSION}) =="
# Its own boot because it manipulates a fixture plugin and a backup directory;
# sharing a WordPress with the assertions above would leave state behind.
$PG php --php "$PHP_VERSION" --wp latest --verbosity quiet \
  --blueprint "$PLUGIN_DIR/tests/blueprint.json" \
  --auto-mount "$PLUGIN_DIR" \
  --mount "$PLUGIN_DIR/tests:/tests" \
  -- /tests/harness-maintenance.php

echo
echo "== harness: the dock — who gets the tag, and who must never get it (PHP ${PHP_VERSION}) =="
# No blueprint: the dock is a plain-WordPress feature — it has nothing to do
# with WooCommerce or with which SEO plugin is active, and a boot without them
# is the one that proves the tag does not depend on either. Its own boot for the
# same reason as the others: it creates a user and writes the plugin's settings
# option, and a shared WordPress could show either to the next harness.
$PG php --php "$PHP_VERSION" --wp latest --verbosity quiet \
  --auto-mount "$PLUGIN_DIR" \
  --mount "$PLUGIN_DIR/tests:/tests" \
  -- /tests/harness-dock.php

echo
echo "All plugin harnesses passed."
