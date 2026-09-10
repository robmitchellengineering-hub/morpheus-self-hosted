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
echo "== harness (WordPress + PHP ${PHP_VERSION}) =="
$PG php --php "$PHP_VERSION" --wp latest --verbosity quiet \
  --auto-mount "$PLUGIN_DIR" \
  --mount "$PLUGIN_DIR/tests:/tests" \
  -- /tests/harness.php
