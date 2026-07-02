# ralph-runner — multi-agent issue runner for Claude Code

Ralph polls GitHub Issues, builds a dependency graph from `## Blocked by` sections, and runs **one fresh-context Claude Code process per issue** — in parallel when issues don't block each other.

The core Ralph property is preserved by construction: every issue gets its own `claude --print` process, so context never leaks between issues.

## Install

```bash
pnpm add -D github:octabyte-io/ralph-runner#v0.1.0   # or npm i -D / yarn add -D
pnpm ralph init                                       # scaffold .ralph/
```

**pnpm ≥ 10 users:** pnpm blocks dependency build scripts by default, and ralph-runner compiles itself on install. Allow it first:

```jsonc
// package.json
"pnpm": { "onlyBuiltDependencies": ["ralph-runner"] }
```

(or run `pnpm approve-builds` after adding). npm and yarn need nothing extra.

Requires **Node ≥ 24**, zero runtime dependencies, plus `git`, an authenticated `gh` CLI, and the `claude` CLI.

`ralph init` writes:

- `.ralph/config.json` — all settings at their defaults; edit to fit your project
- `.ralph/prompt.md` — the per-issue agent prompt; **edit this** to describe your stack, test commands, and rules
- `.gitignore` entries for `.worktrees/` and `.ralph/logs/`

## Usage

```bash
pnpm ralph                     # up to 3 agents in parallel
pnpm ralph -n 1                # serial, full live transcript (+ --chrome)
pnpm ralph -n 4 --follow 25    # 4 agents, stream #25's transcript live
pnpm ralph --dry-run           # print dependency graph + planned work, change nothing
pnpm ralph --issues 23,24      # restrict scope
pnpm ralph --smoke             # also run the smoke command at merge verification
pnpm ralph --clean             # remove empty leftovers from a crashed run
```

## Configuration — `.ralph/config.json`

Every field is optional; omitted fields use the defaults shown. CLI flags win over config.

| Field | Default | Meaning |
| --- | --- | --- |
| `mainBranch` | `"main"` | branch agents fork from and merge into |
| `concurrency` | `3` | max parallel agents (`-n` overrides) |
| `maxMinutes` | `30` | per-agent timeout (`--max-minutes` overrides) |
| `pollIntervalSeconds` | `30` | issue poll cadence |
| `labels.ready` | `"ready-for-agent"` | issues with this label are picked up |
| `labels.inProgress` | `"in progress"` | set while an agent works an issue |
| `labels.underReview` | `"under review"` | set when an agent fails; issue skipped until removed |
| `labels.todo` | `"todo"` | removed when work starts |
| `setupCommand` | `"pnpm install --prefer-offline"` | run in each fresh worktree (bash -c) |
| `verifyCommand` | `"pnpm run test"` | run on the main branch after each merge; red rolls back |
| `smokeCommand` | `"pnpm run smoke"` | additionally run with `--smoke` |
| `envFiles` | `[".env", ".envrc"]` | untracked files copied into each worktree when present |
| `worktreesDir` | `".worktrees"` | where per-issue worktrees live |
| `logDir` | `".ralph/logs"` | per-issue transcripts (`issue-N.log` rendered, `.jsonl` raw) |
| `promptPath` | `".ralph/prompt.md"` | per-issue prompt template; falls back to the shipped generic one |
| `priority.labelRanks` | `{"bug": 0, "documentation": 2}` | label → rank (lower = worked first) |
| `priority.titleRanks` | tracer 1, polish 2, refactor 4 | case-insensitive title regex → rank |
| `priority.defaultRank` | `3` | rank when nothing matches |

The prompt template supports the placeholders `{{NUMBER}}`, `{{TITLE}}`, `{{BODY}}`, `{{COMMENTS}}`, `{{WORKTREE}}`, `{{BRANCH}}`.

## How a run works

1. **Poll** open issues carrying the ready label (every `pollIntervalSeconds`, and immediately after each merge). Issues titled `PRD: …` or labeled in-progress/under-review are skipped. Blockers come from the `## Blocked by` section; a blocker is cleared when its issue is closed.
2. **Schedule** ready issues into free slots by priority rank, then ascending number.
3. **Isolate**: each agent runs in `<worktreesDir>/issue-N` on branch `ralph/issue-N` (forked from the main branch), with env files copied and the setup command run. Agents run fast unit checks only — never dev servers, shared databases, or e2e.
4. **Integrate** (serialized by a merge lock): rebase onto the main branch → fast-forward merge → verify command (+ smoke with `--smoke`) → on green, close the issue and delete worktree+branch. On red or conflict: roll the main branch back, comment on the issue with the failure tail, label under-review, keep the branch for a human.
5. **Unblock**: a merge immediately re-polls, so dependent issues start from the *new* main.

Chrome (`--chrome`) is auto-enabled only at concurrency 1 — parallel agents can't share the browser.

## Output

- Concurrency 1: live Claude-CLI-style transcript (`⏺ Bash(pnpm test)` / `  ⎿ result` lines).
- Concurrency >1: repainting status dashboard; every agent's full transcript is written to `<logDir>/issue-N.log` (rendered) and `.jsonl` (raw stream-json). `--follow <n>` streams one agent live.

## Interrupts and recovery

- Ctrl-C once: stop scheduling, terminate agents, keep worktrees/branches for inspection. Ctrl-C twice: force quit.
- After a crash: re-run refuses to start while stale worktrees exist; `--clean` removes commit-less leftovers, branches with commits are listed for manual resolution.

## Cross-project contract (conventions, not config)

These are fixed conventions ralph relies on across all projects:

- **`## Blocked by` section** in an issue body lists blocking issues as `#N` references; the section ends at the next heading.
- **`PRD:` title prefix** marks scope-description issues; they are never worked directly.
- **`RALPH: #N`** prefixes every agent commit message.
- **`<ralph>DONE</ralph>`** / **`<ralph>BLOCKED: reason</ralph>`** must end the agent's final message; BLOCKED routes the issue to a human without marking it failed-by-code.
- **`ralph/issue-N`** branch naming and `issue-N` worktree naming.

Agents must work only their assigned issue, never close/label issues or merge/push — labels, merge, verification, and closing are the orchestrator's job.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run test                     # node:test unit tests
bash test/e2e.sh                  # full run against a throwaway repo + fake claude/gh
```

Test/env overrides: `RALPH_CLAUDE_CMD`, `RALPH_GH_CMD`, `RALPH_VERIFY_CMD`.
