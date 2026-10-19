#!/usr/bin/env bash
#
# Start a task on a fresh DSH branch cut from the real remote tip.
#
# Always branches from freshly-fetched origin/main, so work can never be based
# on a stale local snapshot (KNOWN-HAZARDS.md H9).
#
# Usage:  scripts/dsh-new-task.sh <slug>
#   e.g.  scripts/dsh-new-task.sh fix-deck-widget-auth

set -euo pipefail

slug="${1:-}"
if [ -z "$slug" ]; then
  echo "usage: scripts/dsh-new-task.sh <slug>" >&2
  echo "  e.g. scripts/dsh-new-task.sh fix-deck-widget-auth" >&2
  exit 2
fi

case "$slug" in
  *[!a-z0-9-]*|'')
    echo "error: slug must be lowercase letters, digits and hyphens only" >&2
    exit 2
    ;;
esac

cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is dirty — commit or stash before starting a task." >&2
  echo "" >&2
  git status --short >&2
  exit 1
fi

echo "Fetching origin..."
git fetch origin --prune

if git show-ref --verify --quiet "refs/heads/dsh/$slug"; then
  echo "error: branch dsh/$slug already exists — pick another slug or delete it." >&2
  exit 1
fi

git switch -c "dsh/$slug" origin/main

echo ""
echo "On branch dsh/$slug"
echo "Based on origin/main @ $(git rev-parse --short origin/main)"
echo ""
echo "When done:"
echo "  npm run lint && npm run build"
echo "  git checkout -- src/MORPHEUS_DESIGN_PLAN.md   # build noise (H3)"
echo "  git push -u origin dsh/$slug && gh pr create --fill"
