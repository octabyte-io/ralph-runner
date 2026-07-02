#!/usr/bin/env bash
# Stand-in for the gh CLI used by ralph's e2e verification.
# Serves canned issues from $FAKE_GH_DIR/issues/*.json; `issue close` drops a
# marker file so subsequent list/view calls reflect the closed state.
set -euo pipefail
DIR="${FAKE_GH_DIR:?FAKE_GH_DIR must be set}"
mkdir -p "$DIR/issues"

log() { echo "$*" >> "$DIR/calls.log"; }

find_json_field() { # scan args for `--json <field>`
  local prev=""
  for arg in "$@"; do
    if [[ "$prev" == "--json" ]]; then echo "$arg"; return; fi
    prev="$arg"
  done
}

cmd="${1:-} ${2:-}"
case "$cmd" in
  "auth status")
    exit 0
    ;;
  "issue list")
    log "list $*"
    out="["
    sep=""
    for f in "$DIR"/issues/*.json; do
      [[ -e "$f" ]] || continue
      n="$(basename "$f" .json)"
      [[ -e "$DIR/closed-$n" ]] && continue
      out+="$sep$(cat "$f")"
      sep=","
    done
    echo "$out]"
    ;;
  "issue view")
    n="$3"
    log "view $*"
    field="$(find_json_field "$@")"
    if [[ "$field" == "state" ]]; then
      if [[ -e "$DIR/closed-$n" ]]; then echo '{"state":"CLOSED"}'; else echo '{"state":"OPEN"}'; fi
    elif [[ "$field" == "comments" ]]; then
      echo '{"comments":[]}'
    else
      echo '{}'
    fi
    ;;
  "issue close")
    n="$3"
    log "close $*"
    touch "$DIR/closed-$n"
    ;;
  "issue comment")
    log "comment $*"
    ;;
  "issue edit")
    log "edit $*"
    ;;
  *)
    log "UNKNOWN $*"
    exit 1
    ;;
esac
