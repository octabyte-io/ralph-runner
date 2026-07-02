import { join } from 'node:path'
import type { RalphConfig } from './config.ts'
import { chromeEnabled } from './config.ts'
import { IssueTracker, parseBlockedBy, sortByPriority, isWorkable } from './issues.ts'
import type { Issue } from './issues.ts'
import { MergeQueue, mergeAndVerify } from './merge.ts'
import { createWorktree, removeWorktree, deleteBranch, branchName } from './worktree.ts'
import { runAgent } from './agent.ts'
import { buildPrompt } from './prompt.ts'
import { summarizeToolUse } from './render/summarize.ts'
import type { StreamEvent, AssistantEvent } from './stream.ts'

export type IssueState = 'BLOCKED' | 'READY' | 'RUNNING' | 'MERGING' | 'MERGED' | 'FAILED'

interface Tracked {
  issue: Issue
  state: IssueState
  blockers: number[]
  startedAt?: number
  activity?: string
  failReason?: string
}

export interface AgentRow {
  issue: number
  title: string
  state: 'RUNNING' | 'MERGING'
  startedAt: number
  activity: string
}

export interface Snapshot {
  rows: AgentRow[]
  merged: number[]
  failed: Array<{ issue: number; reason: string }>
  queued: Array<{ issue: number; blockedBy: number[] }>
  ready: number[]
}

export interface SchedulerUI {
  /** permanent one-line event (merged #24, FAILED #25 …) */
  event(line: string): void
  /** dashboard state push */
  update(snapshot: Snapshot): void
  /** raw stream event from a specific agent (live transcript / --follow) */
  agentEvent(issue: number, event: StreamEvent): void
}

export interface RunSummary {
  merged: number[]
  failed: Array<{ issue: number; reason: string }>
  stuck: Array<{ issue: number; blockedBy: number[] }>
}

export class Scheduler {
  #cfg: RalphConfig
  #ui: SchedulerUI
  #tracker: IssueTracker
  #queue = new MergeQueue()
  #tracked = new Map<number, Tracked>()
  #closedBlockers = new Set<number>()
  #inFlight = new Set<Promise<void>>()
  #abort: AbortSignal
  #wake: (() => void) | undefined

  constructor(cfg: RalphConfig, ui: SchedulerUI, abort: AbortSignal) {
    this.#cfg = cfg
    this.#ui = ui
    this.#abort = abort
    this.#tracker = new IssueTracker(cfg.ghCmd, cfg.repoRoot, cfg.labels.ready)
  }

  async run(): Promise<RunSummary> {
    while (!this.#abort.aborted) {
      await this.#poll()
      this.#fillSlots()
      this.#pushSnapshot()
      if (this.#isDone()) break
      await this.#sleep(this.#cfg.pollIntervalMs)
    }
    await Promise.allSettled([...this.#inFlight])
    this.#pushSnapshot()
    return this.#summary()
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let finished = false
      const done = () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        this.#abort.removeEventListener('abort', done)
        this.#wake = undefined
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.#abort.addEventListener('abort', done, { once: true })
      this.#wake = done
    })
  }

  #wakeUp(): void {
    this.#wake?.()
  }

  async #poll(): Promise<void> {
    let open: Issue[]
    try {
      open = await this.#tracker.listReady()
    } catch (err) {
      this.#ui.event(`poll failed (keeping last state): ${(err as Error).message.split('\n')[0]}`)
      return
    }
    const openNumbers = new Set(open.map((i) => i.number))

    for (const issue of open) {
      if (this.#cfg.issues && !this.#cfg.issues.includes(issue.number)) continue
      const existing = this.#tracked.get(issue.number)
      if (existing) {
        existing.issue = issue
        continue
      }
      if (!isWorkable(issue, this.#cfg.labels)) continue
      this.#tracked.set(issue.number, {
        issue,
        state: 'BLOCKED',
        blockers: parseBlockedBy(issue.body),
      })
    }

    // An issue that disappeared from the open list (closed/unlabeled by a human)
    // while still queued here should stop being scheduled.
    for (const [number, t] of this.#tracked) {
      if ((t.state === 'BLOCKED' || t.state === 'READY') && !openNumbers.has(number)) {
        this.#tracked.delete(number)
      }
    }

    await this.#resolveBlockers()

    for (const t of this.#tracked.values()) {
      if (t.state !== 'BLOCKED') continue
      if (t.blockers.every((b) => this.#isBlockerCleared(b))) t.state = 'READY'
    }
  }

  async #resolveBlockers(): Promise<void> {
    const unknown = new Set<number>()
    for (const t of this.#tracked.values()) {
      if (t.state !== 'BLOCKED') continue
      for (const b of t.blockers) {
        if (!this.#isBlockerCleared(b) && !this.#isActive(b)) unknown.add(b)
      }
    }
    for (const number of unknown) {
      try {
        if ((await this.#tracker.state(number)) === 'CLOSED') this.#closedBlockers.add(number)
      } catch {
        // treat as open; re-checked next poll
      }
    }
  }

  #isBlockerCleared(number: number): boolean {
    return this.#closedBlockers.has(number) || this.#tracked.get(number)?.state === 'MERGED'
  }

  #isActive(number: number): boolean {
    const state = this.#tracked.get(number)?.state
    return state === 'READY' || state === 'RUNNING' || state === 'MERGING' || state === 'BLOCKED'
  }

  #fillSlots(): void {
    if (this.#abort.aborted) return
    const busy = [...this.#tracked.values()].filter(
      (t) => t.state === 'RUNNING' || t.state === 'MERGING',
    ).length
    const ready = sortByPriority(
      [...this.#tracked.values()].filter((t) => t.state === 'READY').map((t) => t.issue),
      this.#cfg.priority,
    )
    for (const issue of ready.slice(0, Math.max(0, this.#cfg.concurrency - busy))) {
      const task = this.#workIssue(this.#tracked.get(issue.number)!).catch((err) => {
        const t = this.#tracked.get(issue.number)
        if (t) {
          t.state = 'FAILED'
          t.failReason = (err as Error).message.split('\n')[0] ?? 'unknown error'
        }
        this.#ui.event(`FAILED #${issue.number}: ${(err as Error).message.split('\n')[0]}`)
      })
      this.#inFlight.add(task)
      task.finally(() => {
        this.#inFlight.delete(task)
        this.#wakeUp()
      })
    }
  }

  async #workIssue(t: Tracked): Promise<void> {
    const { number } = t.issue
    t.state = 'RUNNING'
    t.startedAt = Date.now()
    t.activity = 'creating worktree'
    this.#pushSnapshot()

    const labels = this.#cfg.labels
    await this.#tracker.setLabels(number, { add: [labels.inProgress], remove: [labels.todo] })
    // worktree creation forks from the main branch → serialize with merges
    const worktree = await this.#queue.enqueue(() => createWorktree(this.#cfg, number))
    this.#ui.event(`started #${number} ${t.issue.title}`)

    t.activity = 'agent starting'
    const comments = await this.#tracker.comments(number).catch(() => [])
    const prompt = await buildPrompt(this.#cfg.promptTemplatePath, {
      issue: t.issue,
      comments,
      worktree,
      branch: branchName(number),
    })

    const effectiveConcurrency = Math.min(
      this.#cfg.concurrency,
      this.#cfg.issues?.length ?? Number.POSITIVE_INFINITY,
    )
    const outcome = await runAgent({
      cfg: this.#cfg,
      issue: number,
      worktree,
      prompt,
      chrome: chromeEnabled(this.#cfg, effectiveConcurrency),
      signal: this.#abort,
      onEvent: (event) => {
        t.activity = describeActivity(event, worktree) ?? t.activity
        this.#ui.agentEvent(number, event)
        this.#pushSnapshot()
      },
    })

    if (this.#abort.aborted) return

    if (outcome.status !== 'done') {
      await this.#handleFailure(t, outcome.status, outcome.reason ?? 'unknown', outcome.commits)
      return
    }

    t.state = 'MERGING'
    t.activity = 'waiting for merge lock'
    this.#pushSnapshot()
    const result = await this.#queue.enqueue(() =>
      mergeAndVerify({
        cfg: this.#cfg,
        issue: number,
        onProgress: (step) => {
          t.activity = step
          this.#pushSnapshot()
        },
      }),
    )

    if (result.ok) {
      const cost = outcome.costUsd !== undefined ? ` ($${outcome.costUsd.toFixed(2)})` : ''
      await this.#tracker.close(
        number,
        `Completed by RALPH agent — merged to ${this.#cfg.mainBranch} and verified (\`${this.#cfg.verifyCommand}\`${this.#cfg.smoke ? ' + smoke' : ''} green).\n\n${outcome.resultText.slice(0, 1500)}`,
      )
      await this.#tracker.setLabels(number, { remove: [labels.inProgress] })
      await removeWorktree(this.#cfg, number)
      await deleteBranch(this.#cfg, number)
      t.state = 'MERGED'
      this.#ui.event(`merged #${number} ${t.issue.title}${cost}`)
      this.#wakeUp() // dependents may have unblocked
    } else {
      await this.#handleFailure(
        t,
        result.reason === 'conflict' ? 'rebase conflict' : 'tests failed after merge',
        result.detail,
        outcome.commits,
      )
    }
  }

  async #handleFailure(t: Tracked, kind: string, detail: string, commits: number): Promise<void> {
    const { number } = t.issue
    t.state = 'FAILED'
    t.failReason = `${kind}: ${detail.split('\n')[0]}`
    const logPath = join(this.#cfg.logDir, `issue-${number}.log`)
    const keepBranch = commits > 0
    await this.#tracker.comment(
      number,
      [
        `RALPH agent could not complete this issue (**${kind}**).`,
        '',
        '```',
        detail.slice(0, 3000),
        '```',
        '',
        keepBranch
          ? `Work is preserved on branch \`${branchName(number)}\` (rebased where possible).`
          : 'No commits were produced.',
        `Transcript: \`${logPath}\``,
      ].join('\n'),
    )
    await this.#tracker.setLabels(number, {
      remove: [this.#cfg.labels.inProgress],
      add: kind === 'blocked' ? [] : [this.#cfg.labels.underReview],
    })
    await removeWorktree(this.#cfg, number)
    if (!keepBranch) await deleteBranch(this.#cfg, number, true)
    this.#ui.event(`FAILED #${number} (${kind})${keepBranch ? ` — branch ${branchName(number)} kept` : ''}`)
  }

  #isDone(): boolean {
    const states = [...this.#tracked.values()].map((t) => t.state)
    if (states.some((s) => s === 'READY' || s === 'RUNNING' || s === 'MERGING')) return false
    // remaining BLOCKED issues are stuck: nothing active can unblock them
    return true
  }

  #summary(): RunSummary {
    const tracked = [...this.#tracked.values()]
    return {
      merged: tracked.filter((t) => t.state === 'MERGED').map((t) => t.issue.number),
      failed: tracked
        .filter((t) => t.state === 'FAILED')
        .map((t) => ({ issue: t.issue.number, reason: t.failReason ?? 'unknown' })),
      stuck: tracked
        .filter((t) => t.state === 'BLOCKED')
        .map((t) => ({
          issue: t.issue.number,
          blockedBy: t.blockers.filter((b) => !this.#isBlockerCleared(b)),
        })),
    }
  }

  #pushSnapshot(): void {
    const tracked = [...this.#tracked.values()]
    this.#ui.update({
      rows: tracked
        .filter((t) => t.state === 'RUNNING' || t.state === 'MERGING')
        .map((t) => ({
          issue: t.issue.number,
          title: t.issue.title,
          state: t.state as 'RUNNING' | 'MERGING',
          startedAt: t.startedAt ?? Date.now(),
          activity: t.activity ?? '',
        })),
      merged: tracked.filter((t) => t.state === 'MERGED').map((t) => t.issue.number),
      failed: tracked
        .filter((t) => t.state === 'FAILED')
        .map((t) => ({ issue: t.issue.number, reason: t.failReason ?? '' })),
      queued: tracked
        .filter((t) => t.state === 'BLOCKED')
        .map((t) => ({
          issue: t.issue.number,
          blockedBy: t.blockers.filter((b) => !this.#isBlockerCleared(b)),
        })),
      ready: tracked.filter((t) => t.state === 'READY').map((t) => t.issue.number),
    })
  }
}

function describeActivity(event: StreamEvent, cwd: string): string | undefined {
  if (event.type !== 'assistant') return undefined
  for (const block of (event as AssistantEvent).message.content ?? []) {
    if (block.type === 'tool_use') {
      return `⏺ ${block.name}(${summarizeToolUse(block.name, block.input, cwd)})`
    }
    if (block.type === 'thinking') return 'thinking…'
    if (block.type === 'text') return 'writing…'
  }
  return undefined
}
