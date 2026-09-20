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

echo "== php -l (PHP ${PHP_VERSION}) =="
for f in $( cd "$PLUGIN_DIR" && find . -name '*.php' -not -path './tests/*' | sed 's|^\./||' ); do
  out=$( $PG php --php "$PHP_VERSION" --verbosity quiet --mount "$PLUGIN_DIR:/p" -- -l "/p/$f" 2>&1 \
         | grep -iE 'no syntax errors|parse error|syntax error' | head -1 )
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
echo "All plugin harnesses passed."
