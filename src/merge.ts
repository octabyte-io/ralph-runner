import { run, runOk } from './proc.ts'
import { branchName, worktreePath } from './worktree.ts'

/**
 * In-process serialization for everything that touches main:
 * merges, verification, and worktree creation (so a new worktree
 * never forks from a mid-merge main).
 */
export class MergeQueue {
  #chain: Promise<unknown> = Promise.resolve()

  enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(job, job)
    this.#chain = next.catch(() => {})
    return next
  }
}

export interface MergeOptions {
  repoRoot: string
  issue: number
  smoke: boolean
  /** test-only override for the verification command */
  verifyCmd?: string
  onProgress?: (step: string) => void
}

export type MergeResult =
  | { ok: true }
  | { ok: false; reason: 'conflict' | 'tests-failed' | 'dirty-main'; detail: string }

/**
 * Rebase the issue branch onto main, fast-forward main, run the full
 * suite, and roll main back if it goes red. Caller must hold the MergeQueue.
 */
export async function mergeAndVerify(opts: MergeOptions): Promise<MergeResult> {
  const { repoRoot, issue } = opts
  const branch = branchName(issue)
  const worktree = worktreePath(repoRoot, issue)

  const dirty = await runOk('git', ['status', '--porcelain', '-uno'], { cwd: repoRoot })
  if (dirty) {
    return { ok: false, reason: 'dirty-main', detail: 'main checkout has uncommitted changes' }
  }

  opts.onProgress?.('rebasing onto main')
  const rebase = await run('git', ['rebase', 'main'], { cwd: worktree })
  if (rebase.code !== 0) {
    await run('git', ['rebase', '--abort'], { cwd: worktree })
    return { ok: false, reason: 'conflict', detail: tail(rebase.stderr || rebase.stdout) }
  }

  const preSha = await runOk('git', ['rev-parse', 'main'], { cwd: repoRoot })
  const merge = await run('git', ['merge', '--ff-only', branch], { cwd: repoRoot })
  if (merge.code !== 0) {
    return { ok: false, reason: 'conflict', detail: tail(merge.stderr || merge.stdout) }
  }

  opts.onProgress?.('running pnpm run test')
  const verified = await verify(opts)
  if (!verified.ok) {
    await run('git', ['reset', '--hard', preSha], { cwd: repoRoot })
    return { ok: false, reason: 'tests-failed', detail: verified.detail }
  }
  return { ok: true }
}

async function verify(opts: MergeOptions): Promise<{ ok: true } | { ok: false; detail: string }> {
  const timeoutMs = 20 * 60_000
  if (opts.verifyCmd) {
    const res = await run('bash', ['-c', opts.verifyCmd], { cwd: opts.repoRoot, timeoutMs })
    return res.code === 0 ? { ok: true } : { ok: false, detail: tail(res.stdout + res.stderr) }
  }
  const test = await run('pnpm', ['run', 'test'], { cwd: opts.repoRoot, timeoutMs })
  if (test.code !== 0) return { ok: false, detail: tail(test.stdout + test.stderr) }
  if (opts.smoke) {
    opts.onProgress?.('running pnpm run smoke')
    const smoke = await run('pnpm', ['run', 'smoke'], { cwd: opts.repoRoot, timeoutMs })
    if (smoke.code !== 0) return { ok: false, detail: tail(smoke.stdout + smoke.stderr) }
  }
  return { ok: true }
}

function tail(text: string, lines = 30): string {
  return text.trim().split('\n').slice(-lines).join('\n')
}
