import { parseArgs } from 'node:util'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RalphConfig } from './config.ts'
import { run, runOk } from './proc.ts'
import { IssueTracker, parseBlockedBy, sortByPriority, isWorkable, priorityRank } from './issues.ts'
import { scanStaleWorktrees, removeWorktree, deleteBranch, branchName } from './worktree.ts'
import { Scheduler } from './scheduler.ts'
import type { SchedulerUI, Snapshot } from './scheduler.ts'
import { Dashboard } from './render/dashboard.ts'
import { TranscriptRenderer } from './render/transcript.ts'
import type { StreamEvent } from './stream.ts'
import { paint } from './render/ansi.ts'

const HELP = `ralph — multi-agent issue runner for Claude Code

Usage: pnpm ralph [-- flags]

  -n, --concurrency <int>   parallel agents (default 3)
      --chrome / --no-chrome  force Chrome on/off (default: on iff concurrency is 1)
      --follow <issue>      stream one agent's transcript live in multi-agent mode
      --issues <csv>        restrict the run to these issue numbers
      --max-minutes <int>   per-agent timeout (default 30)
      --smoke               also run 'pnpm run smoke' at merge verification
      --dry-run             print the dependency graph and planned work, change nothing
      --clean               remove stale worktrees/labels from a previous run
  -h, --help

Env overrides (testing): RALPH_CLAUDE_CMD, RALPH_GH_CMD, RALPH_VERIFY_CMD
`

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      concurrency: { type: 'string', short: 'n', default: '3' },
      chrome: { type: 'boolean' },
      'no-chrome': { type: 'boolean' },
      follow: { type: 'string' },
      issues: { type: 'string' },
      'max-minutes': { type: 'string', default: '30' },
      smoke: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      clean: { type: 'boolean', default: false },
      'verify-cmd': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    process.stdout.write(HELP)
    return
  }

  const repoRoot = await runOk('git', ['rev-parse', '--show-toplevel'])
  const toolDir = dirname(dirname(fileURLToPath(import.meta.url)))
  const cfg: RalphConfig = {
    repoRoot,
    concurrency: Math.max(1, Number(values.concurrency) || 3),
    chrome: values.chrome ? 'on' : values['no-chrome'] ? 'off' : 'auto',
    follow: values.follow ? Number(values.follow) : undefined,
    issues: values.issues
      ? values.issues.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
      : undefined,
    maxMinutes: Math.max(1, Number(values['max-minutes']) || 30),
    smoke: values.smoke,
    dryRun: values['dry-run'],
    clean: values.clean,
    pollIntervalMs: 30_000,
    claudeCmd: process.env.RALPH_CLAUDE_CMD || 'claude',
    ghCmd: process.env.RALPH_GH_CMD || 'gh',
    verifyCmd: values['verify-cmd'] || process.env.RALPH_VERIFY_CMD || undefined,
    logDir: join(repoRoot, '.project', 'ralph-logs'),
    worktreesDir: join(repoRoot, '.worktrees'),
    promptTemplatePath: join(toolDir, 'prompt-template.md'),
  }

  if (cfg.dryRun) {
    await dryRun(cfg)
    return
  }

  await preflight(cfg)

  const abortController = new AbortController()
  let interrupts = 0
  process.on('SIGINT', () => {
    interrupts++
    if (interrupts === 1) {
      process.stderr.write(
        '\nralph: interrupt — stopping scheduling, terminating agents (worktrees/branches kept). Ctrl-C again to force quit.\n',
      )
      abortController.abort()
    } else {
      process.exit(130)
    }
  })

  const mainSha = await runOk('git', ['rev-parse', '--short', 'main'], { cwd: repoRoot })
  const effectiveConcurrency = Math.min(cfg.concurrency, cfg.issues?.length ?? Number.POSITIVE_INFINITY)
  const ui = createUI(cfg, `main@${mainSha}`, effectiveConcurrency)

  const scheduler = new Scheduler(cfg, ui.schedulerUI, abortController.signal)
  const summary = await scheduler.run()
  ui.stop()

  const color = process.stdout.isTTY === true
  const out: string[] = ['', paint(color, 'bold', 'ralph run summary')]
  out.push(`  merged: ${summary.merged.length ? summary.merged.map((n) => `#${n}`).join(', ') : 'none'}`)
  for (const f of summary.failed) out.push(paint(color, 'red', `  failed: #${f.issue} — ${f.reason}`))
  for (const s of summary.stuck)
    out.push(paint(color, 'yellow', `  stuck:  #${s.issue} — blocked by ${s.blockedBy.map((n) => `#${n}`).join(', ')} (needs human)`))
  out.push(`  logs: ${cfg.logDir}`, '')
  process.stdout.write(out.join('\n'))
  process.exitCode = summary.failed.length > 0 ? 1 : 0
}

interface UIBundle {
  schedulerUI: SchedulerUI
  stop: () => void
}

function createUI(cfg: RalphConfig, mainRef: string, effectiveConcurrency: number): UIBundle {
  const color = process.stdout.isTTY === true
  if (effectiveConcurrency === 1) {
    const transcript = new TranscriptRenderer({
      color,
      write: (s) => process.stdout.write(s),
      cwd: cfg.repoRoot,
    })
    return {
      schedulerUI: {
        event: (line) => process.stdout.write(`${paint(color, 'dim', '·')} ${line}\n`),
        update: () => {},
        agentEvent: (_issue: number, event: StreamEvent) => transcript.handle(event),
      },
      stop: () => {},
    }
  }

  const dashboard = new Dashboard(process.stdout, mainRef)
  dashboard.start()
  const followTranscript =
    cfg.follow !== undefined
      ? new TranscriptRenderer({ color: false, write: (s) => process.stdout.write(s), cwd: cfg.repoRoot })
      : undefined
  return {
    schedulerUI: {
      event: (line) => dashboard.event(line),
      update: (snapshot: Snapshot) => dashboard.update(snapshot),
      agentEvent: (issue, event) => {
        if (followTranscript && issue === cfg.follow) followTranscript.handle(event)
      },
    },
    stop: () => dashboard.stop(),
  }
}

async function preflight(cfg: RalphConfig): Promise<void> {
  const branch = await runOk('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: cfg.repoRoot })
  if (branch !== 'main') fail(`must run from main (currently on '${branch}')`)

  const dirty = await runOk('git', ['status', '--porcelain', '-uno'], { cwd: cfg.repoRoot })
  if (dirty) fail(`main checkout has uncommitted changes — commit or stash first:\n${dirty}`)

  const gh = await run(cfg.ghCmd, ['auth', 'status'], { cwd: cfg.repoRoot })
  if (gh.code !== 0) fail(`gh is not authenticated:\n${gh.stderr.trim()}`)

  const claude = await run(cfg.claudeCmd, ['--version'], { timeoutMs: 30_000 }).catch(() => null)
  if (!claude || claude.code !== 0) fail(`cannot run '${cfg.claudeCmd} --version' — is Claude Code installed?`)

  const stale = await scanStaleWorktrees(cfg.repoRoot)
  if (stale.length > 0) {
    if (!cfg.clean) {
      fail(
        `stale worktrees from a previous run:\n` +
          stale.map((s) => `  ${s.path} (${s.commits} commit(s) ahead of main)`).join('\n') +
          `\nRe-run with --clean to remove empty ones, or resolve branches with commits manually.`,
      )
    }
    const withCommits = stale.filter((s) => s.commits > 0)
    if (withCommits.length > 0) {
      fail(
        `refusing to clean worktrees whose branches have unmerged commits:\n` +
          withCommits.map((s) => `  ${branchName(s.issue)} (${s.commits} commit(s))`).join('\n') +
          `\nMerge or delete those branches manually, then re-run.`,
      )
    }
    for (const s of stale) {
      await removeWorktree(cfg.repoRoot, s.issue)
      await deleteBranch(cfg.repoRoot, s.issue, true)
      process.stdout.write(`cleaned stale worktree for #${s.issue}\n`)
    }
  }
}

async function dryRun(cfg: RalphConfig): Promise<void> {
  const tracker = new IssueTracker(cfg.ghCmd, cfg.repoRoot)
  const all = await tracker.listReady()
  const scoped = cfg.issues ? all.filter((i) => cfg.issues!.includes(i.number)) : all
  const workable = scoped.filter(isWorkable)
  const skipped = scoped.filter((i) => !isWorkable(i))

  const numbers = new Set(workable.map((i) => i.number))
  const closedCache = new Map<number, boolean>()
  const isCleared = async (n: number): Promise<boolean> => {
    if (numbers.has(n)) return false // will be worked this run, not yet closed
    if (!closedCache.has(n)) {
      closedCache.set(n, await tracker.state(n).then((s) => s === 'CLOSED').catch(() => false))
    }
    return closedCache.get(n)!
  }

  const lines: string[] = [`ralph dry run — ${workable.length} workable issue(s), concurrency ${cfg.concurrency}`, '']
  for (const issue of sortByPriority(workable)) {
    const blockers = parseBlockedBy(issue.body)
    const open: number[] = []
    for (const b of blockers) if (!(await isCleared(b))) open.push(b)
    const status = open.length === 0 ? 'READY' : `blocked by ${open.map((n) => `#${n}`).join(', ')}`
    lines.push(`  #${issue.number}  [p${priorityRank(issue)}] ${status.padEnd(24)} ${issue.title}`)
  }
  for (const issue of skipped) {
    lines.push(`  #${issue.number}  skipped (${/^\s*prd\b/i.test(issue.title) ? 'PRD' : 'label'})       ${issue.title}`)
  }
  lines.push('', 'per ready issue, ralph would:')
  lines.push(`  git worktree add .worktrees/issue-N -b ralph/issue-N main && pnpm install`)
  lines.push(`  ${cfg.claudeCmd} --print --dangerously-skip-permissions --output-format stream-json --verbose  (cwd=worktree, prompt on stdin)`)
  lines.push(`  git rebase main && git merge --ff-only && pnpm run test${cfg.smoke ? ' && pnpm run smoke' : ''} && gh issue close`)
  process.stdout.write(lines.join('\n') + '\n')
}

function fail(message: string): never {
  process.stderr.write(`ralph: ${message}\n`)
  process.exit(2)
}

main().catch((err) => {
  process.stderr.write(`ralph: ${(err as Error).stack ?? err}\n`)
  process.exit(1)
})
