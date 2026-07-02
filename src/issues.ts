import { runOk, retry } from './proc.ts'
import type { LabelsConfig, PriorityConfig } from './config.ts'

export interface Issue {
  number: number
  title: string
  body: string
  labels: string[]
}

export interface IssueComment {
  author: string
  body: string
}

/**
 * Parse blocker issue numbers from a `## Blocked by` section.
 * The section ends at the next markdown heading or end of body.
 */
export function parseBlockedBy(body: string): number[] {
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((l) => /^#{2,}\s*blocked\s*by\b/i.test(l.trim()))
  if (start === -1) return []
  const section: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break
    section.push(line)
  }
  const refs = section.join('\n').matchAll(/#(\d+)/g)
  return [...new Set([...refs].map((m) => Number(m[1])))]
}

/** Lower rank = worked first; label ranks win over title patterns. */
export function priorityRank(issue: Issue, priority: PriorityConfig): number {
  const labels = issue.labels.map((l) => l.toLowerCase())
  const labelRanks = labels
    .map((l) => priority.labelRanks[l])
    .filter((r): r is number => r !== undefined)
  if (labelRanks.length > 0) return Math.min(...labelRanks)
  for (const rule of priority.titleRanks) {
    if (new RegExp(rule.pattern, 'i').test(issue.title)) return rule.rank
  }
  return priority.defaultRank
}

export function sortByPriority(issues: Issue[], priority: PriorityConfig): Issue[] {
  return [...issues].sort(
    (a, b) => priorityRank(a, priority) - priorityRank(b, priority) || a.number - b.number,
  )
}

/** PRD issues describe scope; they are not directly implementable. */
export function isWorkable(issue: Issue, cfgLabels: LabelsConfig): boolean {
  if (/^\s*prd\b[:\s]/i.test(issue.title)) return false
  const labels = issue.labels.map((l) => l.toLowerCase())
  return (
    !labels.includes(cfgLabels.inProgress.toLowerCase()) &&
    !labels.includes(cfgLabels.underReview.toLowerCase())
  )
}

export class IssueTracker {
  #gh: string
  #cwd: string
  #readyLabel: string

  constructor(ghCmd: string, cwd: string, readyLabel: string) {
    this.#gh = ghCmd
    this.#cwd = cwd
    this.#readyLabel = readyLabel
  }

  #run(args: string[]): Promise<string> {
    return retry(() => runOk(this.#gh, args, { cwd: this.#cwd }))
  }

  async listReady(): Promise<Issue[]> {
    const out = await this.#run([
      'issue', 'list',
      '--state', 'open',
      '--label', this.#readyLabel,
      '--limit', '200',
      '--json', 'number,title,body,labels',
    ])
    const raw = JSON.parse(out) as Array<{
      number: number
      title: string
      body: string
      labels: Array<{ name: string }>
    }>
    return raw.map((r) => ({
      number: r.number,
      title: r.title,
      body: r.body ?? '',
      labels: (r.labels ?? []).map((l) => l.name),
    }))
  }

  async state(number: number): Promise<'OPEN' | 'CLOSED'> {
    const out = await this.#run(['issue', 'view', String(number), '--json', 'state'])
    return (JSON.parse(out) as { state: string }).state === 'CLOSED' ? 'CLOSED' : 'OPEN'
  }

  async comments(number: number): Promise<IssueComment[]> {
    const out = await this.#run(['issue', 'view', String(number), '--json', 'comments'])
    const raw = JSON.parse(out) as { comments?: Array<{ author?: { login?: string }; body: string }> }
    return (raw.comments ?? []).map((c) => ({ author: c.author?.login ?? 'unknown', body: c.body }))
  }

  async comment(number: number, body: string): Promise<void> {
    await this.#run(['issue', 'comment', String(number), '--body', body])
  }

  async close(number: number, comment: string): Promise<void> {
    await this.#run(['issue', 'close', String(number), '--comment', comment])
  }

  /** Label edits tolerate missing labels — the repo may not define them all. */
  async setLabels(number: number, opts: { add?: string[]; remove?: string[] }): Promise<void> {
    const args = ['issue', 'edit', String(number)]
    for (const l of opts.add ?? []) args.push('--add-label', l)
    for (const l of opts.remove ?? []) args.push('--remove-label', l)
    try {
      await this.#run(args)
    } catch {
      // best-effort: label churn must never fail the run
    }
  }
}
