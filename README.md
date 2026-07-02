# ralph — multi-agent issue runner for Claude Code

Supersedes `.project/ralph.sh` for issue-driven runs (the shell script remains as a generic single-prompt loop). Ralph polls GitHub Issues, builds a dependency graph from `## Blocked by` sections, and runs **one fresh-context Claude Code process per issue** — in parallel when issues don't block each other.

The core Ralph property is preserved by construction: every issue gets its own `claude --print` process, so context never leaks between issues.

## Usage

```bash
pnpm ralph                     # up to 3 agents in parallel
pnpm ralph -- -n 1             # serial, full live transcript (+ --chrome)
pnpm ralph -- -n 4 --follow 25 # 4 agents, stream #25's transcript live
pnpm ralph -- --dry-run        # print dependency graph + planned work, change nothing
pnpm ralph -- --issues 23,24   # restrict scope
pnpm ralph -- --smoke          # also run e2e at merge verification
pnpm ralph -- --clean          # remove empty leftovers from a crashed run
```

Note the `--` — flags after it reach ralph, not pnpm.

## How a run works

1. **Poll** open issues labeled `ready-for-agent` (every 30 s, and immediately after each merge). Issues titled `PRD: …` or labeled `in progress`/`under review` are skipped. Blockers come from the `## Blocked by` section; a blocker is cleared when its issue is closed.
2. **Schedule** ready issues into free slots, priority: bugs → tracer bullets → polish → refactors, then ascending number.
3. **Isolate**: each agent runs in `.worktrees/issue-N` on branch `ralph/issue-N` (forked from main), with env files copied and `pnpm install` done. Agents run unit tests only — never dev servers, the DB, or e2e.
4. **Integrate** (serialized by a merge lock): rebase onto main → fast-forward merge → `pnpm run test` (+ `pnpm run smoke` with `--smoke`) → on green, close the issue and delete worktree+branch. On red or conflict: roll main back, comment on the issue with the failure tail, label `under review`, keep the branch for a human.
5. **Unblock**: a merge immediately re-polls, so dependent issues start from the *new* main.

Chrome (`--chrome`) is auto-enabled only at concurrency 1 — parallel agents can't share the browser.

## Output

- Concurrency 1: live Claude-CLI-style transcript (`⏺ Bash(pnpm test)` / `  ⎿ result` lines).
- Concurrency >1: repainting status dashboard; every agent's full transcript is written to `.project/ralph-logs/issue-N.log` (rendered) and `.jsonl` (raw stream-json). `--follow <n>` streams one agent live.

## Interrupts and recovery

- Ctrl-C once: stop scheduling, terminate agents, keep worktrees/branches for inspection. Ctrl-C twice: force quit.
- After a crash: re-run refuses to start while stale worktrees exist; `--clean` removes commit-less leftovers, branches with commits are listed for manual resolution.

## Agent contract

The per-issue prompt is `prompt-template.md`. Agents must work only their assigned issue, commit with `RALPH: #N …`, never close/label issues or merge/push, and end with `<ralph>DONE</ralph>` or `<ralph>BLOCKED: reason</ralph>`. Everything else (labels, merge, verification, closing) is the orchestrator's job.

## Development

```bash
cd tools/ralph
pnpm install --ignore-workspace   # devDeps only (@types/node, typescript)
pnpm run typecheck
pnpm run test                     # node:test unit tests
bash test/e2e.sh                  # full run against a throwaway repo + fake claude/gh
```

Zero runtime dependencies — Node ≥ 24 runs the TypeScript directly. Deliberately **not** part of the pnpm workspace so `pnpm -r` (used by agents and merge verification) never touches it.

Test/env overrides: `RALPH_CLAUDE_CMD`, `RALPH_GH_CMD`, `RALPH_VERIFY_CMD`.
