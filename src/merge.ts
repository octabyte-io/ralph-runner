import type { RalphConfig } from './config.ts'
import { run, runOk } from './proc.ts'
import { branchName, worktreePath } from './worktree.ts'

/**
 * In-process serialization for everything that touches the main branch:
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
  cfg: RalphConfig
  issue: number
  onProgress?: (step: string) => void
}

export type MergeResult =
  | { ok: true }
  | { ok: false; reason: 'conflict' | 'tests-failed' | 'dirty-main'; detail: string }

/**
 * Rebase the issue branch onto the main branch, fast-forward it, run the
 * verify command, and roll back if it goes red. Caller must hold the MergeQueue.
 */
export async function mergeAndVerify(opts: MergeOptions): Promise<MergeResult> {
  const { cfg, issue } = opts
  const branch = branchName(issue)
  const worktree = worktreePath(cfg, issue)

  const dirty = await runOk('git', ['status', '--porcelain', '-uno'], { cwd: cfg.repoRoot })
  if (dirty) {
    return { ok: false, reason: 'dirty-main', detail: `${cfg.mainBranch} checkout has uncommitted changes` }
  }

  opts.onProgress?.(`rebasing onto ${cfg.mainBranch}`)
  const rebase = await run('git', ['rebase', cfg.mainBranch], { cwd: worktree })
  if (rebase.code !== 0) {
    await run('git', ['rebase', '--abort'], { cwd: worktree })
    return { ok: false, reason: 'conflict', detail: tail(rebase.stderr || rebase.stdout) }
  }

  const preSha = await runOk('git', ['rev-parse', cfg.mainBranch], { cwd: cfg.repoRoot })
  const merge = await run('git', ['merge', '--ff-only', branch], { cwd: cfg.repoRoot })
  if (merge.code !== 0) {
    return { ok: false, reason: 'conflict', detail: tail(merge.stderr || merge.stdout) }
  }

  opts.onProgress?.(`running ${cfg.verifyCommand}`)
  const verified = await verify(opts)
  if (!verified.ok) {
    await run('git', ['reset', '--hard', preSha], { cwd: cfg.repoRoot })
    return { ok: false, reason: 'tests-failed', detail: verified.detail }
  }
  return { ok: true }
}

async function verify(opts: MergeOptions): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { cfg } = opts
  const timeoutMs = 20 * 60_000
  const test = await run('bash', ['-c', cfg.verifyCommand], { cwd: cfg.repoRoot, timeoutMs })
  if (test.code !== 0) return { ok: false, detail: tail(test.stdout + test.stderr) }
  if (cfg.smoke) {
    opts.onProgress?.(`running ${cfg.smokeCommand}`)
    const smoke = await run('bash', ['-c', cfg.smokeCommand], { cwd: cfg.repoRoot, timeoutMs })
    if (smoke.code !== 0) return { ok: false, detail: tail(smoke.stdout + smoke.stderr) }
  }
  return { ok: true }
}

function tail(text: string, lines = 30): string {
  return text.trim().split('\n').slice(-lines).join('\n')
}
