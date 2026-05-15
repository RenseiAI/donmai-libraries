#!/bin/bash
# Publish a package to the active npm registry if @version is not already there.
# Usage: publish-if-needed.sh <package-name> <version> [extra-pnpm-publish-args...]
#
# The "active" registry is whatever .npmrc points the scope at — set by an
# upstream `actions/setup-node` step (default for the npm.org publish phase,
# https://npm.pkg.github.com for the GitHub Packages phase). `npm view` and
# `pnpm publish` both inherit that config, so no per-call --registry flag.
#
# Exit 0 on either successful publish OR "already exists" — idempotent under
# re-runs, which is essential when a partial publish chain needs continuation.

set -euo pipefail

PKG="$1"
VERSION="$2"
shift 2

if npm view "$PKG@$VERSION" version >/dev/null 2>&1; then
  echo "::notice::$PKG@$VERSION already published — skipping"
  exit 0
fi

echo "Publishing $PKG@$VERSION..."
pnpm --filter "$PKG" publish --no-git-checks "$@"
