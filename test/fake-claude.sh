#!/usr/bin/env bash
# Stand-in for the claude CLI used by ralph's e2e verification.
# Reads the prompt from stdin, emits a plausible stream-json feed, and makes
# a real commit in the current directory (which ralph expects to be a worktree).
# Env knobs:
#   FAKE_CLAUDE_MODE=done|blocked|nocommit   (default done)
#   FAKE_CLAUDE_DELAY=<seconds between events> (default 0.2)
set -euo pipefail

if [[ "${1:-}" == "--version" ]]; then
  echo "fake-claude 0.0.1"
  exit 0
fi

PROMPT="$(cat)"
ISSUE="$(grep -oE 'issue #[0-9]+' <<<"$PROMPT" | head -1 | grep -oE '[0-9]+' || echo 0)"
MODE="${FAKE_CLAUDE_MODE:-done}"
DELAY="${FAKE_CLAUDE_DELAY:-0.2}"

emit() { echo "$1"; sleep "$DELAY"; }

emit '{"type":"system","subtype":"init","session_id":"fake","model":"fake-model"}'
emit '{"type":"assistant","message":{"content":[{"type":"text","text":"Reading the issue and relevant source files."}]}}'
emit '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"'"$PWD"'/package.json"}}]}}'
emit '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"{ ... }","is_error":false}]}}'

if [[ "$MODE" == "done" ]]; then
  echo "fake change for issue #$ISSUE at $(date +%s%N)" >> ".ralph-fake-change-$ISSUE.txt"
  git add ".ralph-fake-change-$ISSUE.txt"
  git commit -q -m "RALPH: #$ISSUE fake change from stub agent"
  emit '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"description":"Commit the change"}}]}}'
  emit '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"committed","is_error":false}]}}'
  FINAL="Implemented issue #$ISSUE. <ralph>DONE</ralph>"
elif [[ "$MODE" == "blocked" ]]; then
  FINAL="Cannot proceed. <ralph>BLOCKED: missing schema decision</ralph>"
else
  FINAL="I explored but made no changes. <ralph>DONE</ralph>"
fi

emit "$(jq -cn --arg t "$FINAL" '{"type":"assistant","message":{"content":[{"type":"text","text":$t}]}}')"
emit "$(jq -cn --arg t "$FINAL" '{"type":"result","subtype":"success","result":$t,"duration_ms":1200,"total_cost_usd":0.05,"num_turns":3}')"
