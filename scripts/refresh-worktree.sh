#!/usr/bin/env bash
# refresh-worktree.sh — keep a git worktree rebased and its dependencies fresh.
#
# Portable, repo-agnostic. Auto-detects package manager via lockfile. Intended
# to be invoked by a Claude Code SessionStart hook (startup|clear|resume) or
# by hand. Safe to run repeatedly; no-ops unless there's work to do.
#
# Design rules:
#   - Only act inside a linked git worktree. The main checkout is never touched,
#     so the primary clone where humans do most work is protected.
#   - On "clear": hard-reset to upstream, remove untracked files, force deps
#     install. The new conversation starts with a pristine worktree.
#   - On "startup"/"resume": if the worktree is dirty, SKIP the rebase entirely
#     to preserve WIP. Never stash-then-rebase — `git stash` without
#     `--include-untracked` silently leaves untracked files unstashed, and a
#     conflicting stash-pop after rebase fails silently (||true), leaving WIP
#     in `git stash list` while the working tree shows the rebased upstream
#     state. Agents experience this as a silent revert.
#   - Never leave a broken git state: conflicting rebases are aborted.
#   - All diagnostics go to stdout so Claude sees them as session context.
#
# Configuration (all optional, via env var or .refresh-worktree.env at repo root):
#   REFRESH_UPSTREAM        Upstream to rebase onto (default: auto-detect
#                           origin/main → origin/master → origin/HEAD).
#   REFRESH_INCLUDE_MAIN    "1" to also run in the main checkout (default off).
#   REFRESH_SKIP_INSTALL    "1" to skip the dependency step entirely.
#   REFRESH_PM              Force package manager: pnpm|yarn|npm|bun (default auto).
#
# Source: https://github.com/markkropf/agent-scripts (canonical: ~/Developer/agent-scripts/worktree-refresh/lib/refresh-worktree.sh)

set -uo pipefail

# --- Parse event source from stdin (Claude Code passes JSON) ----------------
EVENT_SOURCE=""
if [ ! -t 0 ]; then
  INPUT="$(cat)"
  if command -v jq >/dev/null 2>&1; then
    EVENT_SOURCE="$(echo "$INPUT" | jq -r '.source // empty' 2>/dev/null || echo '')"
  else
    # Fallback: extract source with sed if jq is not available
    EVENT_SOURCE="$(echo "$INPUT" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  fi
fi

REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$REPO" 2>/dev/null || { echo "[refresh-worktree] cannot cd into $REPO"; exit 0; }

# Load optional per-repo overrides
if [ -f "$REPO/.refresh-worktree.env" ]; then
  # shellcheck disable=SC1091
  . "$REPO/.refresh-worktree.env"
fi

# --- Detect worktree status -------------------------------------------------
GIT_DIR="$(git rev-parse --git-dir 2>/dev/null || echo '')"
GIT_COMMON="$(git rev-parse --git-common-dir 2>/dev/null || echo '')"
if [ -z "$GIT_DIR" ] || [ -z "$GIT_COMMON" ]; then
  exit 0  # not a git repo
fi
GIT_DIR_ABS="$(cd "$GIT_DIR" && pwd)"
GIT_COMMON_ABS="$(cd "$GIT_COMMON" && pwd)"

if [ "$GIT_DIR_ABS" = "$GIT_COMMON_ABS" ] && [ "${REFRESH_INCLUDE_MAIN:-0}" != "1" ]; then
  # Main worktree — silently no-op to protect the primary checkout.
  exit 0
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'detached')"

# --- Serialize parallel invocations ----------------------------------------
LOCK_FILE="$GIT_DIR_ABS/.refresh-worktree.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || { echo "[refresh-worktree] another refresh is running — skipping"; exit 0; }
fi

STATUS_LINES=()
add_status() { STATUS_LINES+=("$1"); }

# --- 1. Fetch --------------------------------------------------------------
if ! git fetch origin --quiet 2>/dev/null; then
  add_status "fetch: failed (offline?) — continuing with local state"
fi

# --- 2. Clear mode: hard-reset to upstream ---------------------------------
# On /clear the previous conversation is gone — any uncommitted work is orphaned.
# Reset to upstream so the new conversation starts clean.
if [ "$EVENT_SOURCE" = "clear" ]; then
  # Resolve upstream before using it
  CLEAR_UPSTREAM="${REFRESH_UPSTREAM:-}"
  if [ -z "$CLEAR_UPSTREAM" ]; then
    for candidate in origin/main origin/master origin/HEAD; do
      if git rev-parse --verify --quiet "$candidate" >/dev/null; then
        CLEAR_UPSTREAM="$candidate"
        break
      fi
    done
  fi

  if [ -n "$CLEAR_UPSTREAM" ]; then
    DIRTY_COUNT="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    UNTRACKED_COUNT="$(git status --porcelain 2>/dev/null | grep -c '^??' || true)"

    # Abort any in-progress git operations
    git rebase --abort 2>/dev/null || true
    git merge --abort 2>/dev/null || true
    git cherry-pick --abort 2>/dev/null || true

    # Hard-reset tracked files to upstream
    git reset --hard "$CLEAR_UPSTREAM" >/dev/null 2>&1

    # Remove untracked files and directories (but respect .gitignore)
    git clean -fd >/dev/null 2>&1

    add_status "clear: reset to $CLEAR_UPSTREAM, discarded $DIRTY_COUNT dirty files ($UNTRACKED_COUNT untracked)"

    # Force deps reinstall after clear (lockfile may have changed)
    MARKER="$GIT_DIR_ABS/.refresh-worktree-deps-marker"
    rm -f "$MARKER" 2>/dev/null
  else
    add_status "clear: no upstream branch resolvable — skipping reset"
  fi

  # Report and exit — no need for the stash-rebase path after a hard reset
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'detached')"

  # Still run deps install after clear
  # (fall through to deps section below)
fi

# --- 3. Rebase (startup/resume only) --------------------------------------
if [ "$EVENT_SOURCE" != "clear" ]; then
UPSTREAM="${REFRESH_UPSTREAM:-}"
if [ -z "$UPSTREAM" ]; then
  for candidate in origin/main origin/master origin/HEAD; do
    if git rev-parse --verify --quiet "$candidate" >/dev/null; then
      UPSTREAM="$candidate"
      break
    fi
  done
fi

if [ -z "$UPSTREAM" ]; then
  add_status "rebase: no upstream branch resolvable"
elif [ -d "$GIT_DIR_ABS/rebase-merge" ] || [ -d "$GIT_DIR_ABS/rebase-apply" ] \
     || [ -f "$GIT_DIR_ABS/MERGE_HEAD" ] || [ -f "$GIT_DIR_ABS/CHERRY_PICK_HEAD" ]; then
  add_status "rebase: git operation in progress — skipping"
else
  DIRTY="$(git status --porcelain 2>/dev/null)"
  BEHIND="$(git rev-list --count "HEAD..$UPSTREAM" 2>/dev/null || echo 0)"

  # Don't rebase the upstream branch onto itself
  CURRENT_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"
  UPSTREAM_SHA="$(git rev-parse "$UPSTREAM" 2>/dev/null || echo '')"

  if [ "$CURRENT_SHA" = "$UPSTREAM_SHA" ]; then
    add_status "rebase: on $UPSTREAM directly — nothing to do"
  elif [ "$BEHIND" = "0" ]; then
    add_status "rebase: up-to-date with $UPSTREAM"
  elif [ -n "$DIRTY" ]; then
    # WIP present (tracked edits and/or untracked new files). Skip the rebase
    # entirely rather than stash/pop — `git stash` without --include-untracked
    # silently leaves untracked files unstashed, and a conflicting stash-pop
    # after rebase fails silently (||true), leaving the WIP in `git stash list`
    # but the working tree showing the rebased upstream state. Agents see this
    # as a silent revert. Safer to leave the worktree behind than to risk it.
    DIRTY_LINE_COUNT="$(printf '%s\n' "$DIRTY" | wc -l | tr -d ' ')"
    add_status "rebase: $BEHIND commit(s) behind $UPSTREAM but worktree has $DIRTY_LINE_COUNT dirty path(s) — skipping to preserve WIP"
  else
    if git rebase "$UPSTREAM" >/dev/null 2>&1; then
      add_status "rebase: rebased $BEHIND commit(s) onto $UPSTREAM"
    else
      git rebase --abort >/dev/null 2>&1 || true
      add_status "rebase: conflict against $UPSTREAM — aborted, worktree unchanged"
    fi
  fi
fi
fi  # end startup/resume rebase block

# --- 4. Dependencies -------------------------------------------------------
if [ "${REFRESH_SKIP_INSTALL:-0}" = "1" ]; then
  add_status "deps: skipped (REFRESH_SKIP_INSTALL=1)"
else
  MARKER="$GIT_DIR_ABS/.refresh-worktree-deps-marker"

  # Detect package manager (or honor REFRESH_PM override)
  PM="${REFRESH_PM:-}"
  LOCKFILE=""
  if [ -z "$PM" ]; then
    if   [ -f pnpm-lock.yaml ]; then PM="pnpm"
    elif [ -f bun.lockb ] || [ -f bun.lock ]; then PM="bun"
    elif [ -f yarn.lock ]; then PM="yarn"
    elif [ -f package-lock.json ]; then PM="npm"
    fi
  fi

  case "$PM" in
    pnpm) LOCKFILE="pnpm-lock.yaml"; INSTALL_CMD="pnpm install --frozen-lockfile --prefer-offline" ;;
    yarn) LOCKFILE="yarn.lock";      INSTALL_CMD="yarn install --immutable" ;;
    npm)  LOCKFILE="package-lock.json"; INSTALL_CMD="npm ci --prefer-offline" ;;
    bun)  LOCKFILE="$([ -f bun.lockb ] && echo bun.lockb || echo bun.lock)"; INSTALL_CMD="bun install --frozen-lockfile" ;;
    "")   : ;;
    *)    add_status "deps: unknown REFRESH_PM='$PM' — skipping" ;;
  esac

  if [ -z "$PM" ]; then
    add_status "deps: no JS lockfile detected — skipping"
  elif [ -n "$LOCKFILE" ] && [ -n "$INSTALL_CMD" ]; then
    NEED=0
    if [ ! -f "$MARKER" ]; then NEED=1
    elif [ "$LOCKFILE" -nt "$MARKER" ]; then NEED=1
    elif [ -f package.json ] && [ package.json -nt "$MARKER" ]; then NEED=1
    fi

    if [ "$NEED" = "0" ]; then
      add_status "deps: up-to-date (no $LOCKFILE / package.json changes)"
    else
      if eval "$INSTALL_CMD" >/dev/null 2>&1; then
        touch "$MARKER"
        add_status "deps: $PM install ran"
      else
        add_status "deps: '$INSTALL_CMD' FAILED — run manually"
      fi
    fi
  fi
fi

# --- 5. Report -------------------------------------------------------------
echo "[refresh-worktree] $BRANCH"
for line in "${STATUS_LINES[@]}"; do
  echo "  - $line"
done

# --- 6. Breadcrumb log -----------------------------------------------------
# Append a single JSONL line per invocation so future incidents have a trail.
# Best-effort; failures are non-fatal.
LOG_DIR="$REPO/.dev-logs"
LOG_FILE="$LOG_DIR/worktree-refresh.jsonl"
if mkdir -p "$LOG_DIR" 2>/dev/null; then
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  HEAD_SHA="${CURRENT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo '')}"
  UP_SHA="${UPSTREAM_SHA:-$(git rev-parse "${UPSTREAM:-HEAD}" 2>/dev/null || echo '')}"
  if [ -n "${DIRTY:-}" ]; then
    DIRTY_COUNT_LOG="$(printf '%s\n' "$DIRTY" | wc -l | tr -d ' ')"
  else
    DIRTY_COUNT_LOG=0
  fi
  STATUS_JOINED="$(printf '%s; ' "${STATUS_LINES[@]:-}" | sed 's/; $//' | tr -d '\n' | sed 's/"/\\"/g')"
  printf '{"ts":"%s","pid":%d,"source":"%s","branch":"%s","head":"%s","upstream":"%s","upstream_sha":"%s","dirty_paths":%s,"actions":"%s"}\n' \
    "$TS" "$$" "${EVENT_SOURCE:-}" "$BRANCH" "$HEAD_SHA" "${UPSTREAM:-}" "$UP_SHA" "$DIRTY_COUNT_LOG" "$STATUS_JOINED" \
    >> "$LOG_FILE" 2>/dev/null || true
fi

exit 0
