#!/usr/bin/env bash
# End-to-end exercise of the ralph orchestrator against a throwaway git repo,
# a fake claude (emits stream-json + commits) and a fake gh (canned issues).
# Verifies: worktree lifecycle, parallel agents, dependency unblocking after
# merge, serialized merge+verify, issue closing, cleanup.
set -euo pipefail

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d /tmp/ralph-e2e.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# --- toy repo ---------------------------------------------------------------
REPO="$WORK/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email ralph-e2e@example.com
git -C "$REPO" config user.name "ralph e2e"
git -C "$REPO" config commit.gpgsign false
cat > "$REPO/package.json" <<'EOF'
{ "name": "toy", "private": true, "scripts": { "test": "echo toy tests pass" } }
EOF
git -C "$REPO" -c commit.gpgsign=false add -A
git -C "$REPO" -c commit.gpgsign=false commit -qm "init"

# --- canned issues: #2 depends on #1, #3 independent -------------------------
export FAKE_GH_DIR="$WORK/gh"
mkdir -p "$FAKE_GH_DIR/issues"
cat > "$FAKE_GH_DIR/issues/1.json" <<'EOF'
{"number":1,"title":"Slice 1: base thing","body":"Do the base thing.","labels":[{"name":"ready-for-agent"}]}
EOF
cat > "$FAKE_GH_DIR/issues/2.json" <<'EOF'
{"number":2,"title":"Slice 2: dependent thing","body":"Builds on slice 1.\n\n## Blocked by\n\n- #1\n","labels":[{"name":"ready-for-agent"}]}
EOF
cat > "$FAKE_GH_DIR/issues/3.json" <<'EOF'
{"number":3,"title":"Independent polish","body":"No deps.","labels":[{"name":"ready-for-agent"}]}
EOF

# --- run ---------------------------------------------------------------------
export RALPH_CLAUDE_CMD="$TOOL_DIR/test/fake-claude.sh"
export RALPH_GH_CMD="$TOOL_DIR/test/fake-gh.sh"
export FAKE_CLAUDE_DELAY="${FAKE_CLAUDE_DELAY:-0.1}"

cd "$REPO"
node "$TOOL_DIR/src/main.ts" -n 2 --verify-cmd 'pnpm run test'

# --- assertions ---------------------------------------------------------------
failures=0
check() { # check <desc> <cmd...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "  ok: $desc"
  else
    echo "  FAIL: $desc"
    failures=$((failures + 1))
  fi
}

check "issue 1 closed" test -e "$FAKE_GH_DIR/closed-1"
check "issue 2 closed (unblocked after #1 merged)" test -e "$FAKE_GH_DIR/closed-2"
check "issue 3 closed" test -e "$FAKE_GH_DIR/closed-3"
check "3 RALPH commits on main" bash -c '[ "$(git -C '"$REPO"' log --oneline --grep=RALPH | wc -l)" -eq 3 ]'
check "no leftover worktrees" bash -c '! ls -d '"$REPO"'/.worktrees/issue-* 2>/dev/null'
check "no leftover ralph branches" bash -c '! git -C '"$REPO"' branch --list "ralph/*" | grep -q .'
check "issue 2 merged after issue 1" bash -c 'git -C '"$REPO"' log --oneline | grep -n "RALPH: #2" | cut -d: -f1 | head -1 | xargs -I{} test {} -lt "$(git -C '"$REPO"' log --oneline | grep -n "RALPH: #1" | cut -d: -f1 | head -1)"'

echo
if [ "$failures" -eq 0 ]; then
  echo "e2e: all checks passed"
else
  echo "e2e: $failures check(s) failed"
  exit 1
fi
