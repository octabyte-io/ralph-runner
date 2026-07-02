import { copyFile, mkdir, access } from 'node:fs/promises'
import { readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { RalphConfig } from './config.ts'
import { run, runOk } from './proc.ts'

export function worktreePath(cfg: RalphConfig, issue: number): string {
  return join(cfg.worktreesDir, `issue-${issue}`)
}

export function branchName(issue: number): string {
  return `ralph/issue-${issue}`
}

export async function createWorktree(cfg: RalphConfig, issue: number): Promise<string> {
  const path = worktreePath(cfg, issue)
  await mkdir(dirname(path), { recursive: true })
  await runOk('git', ['worktree', 'add', path, '-b', branchName(issue), cfg.mainBranch], {
    cwd: cfg.repoRoot,
  })
  // untracked config files an agent needs; copied into the worktree when present
  for (const rel of cfg.envFiles) {
    const src = join(cfg.repoRoot, rel)
    try {
      await access(src)
      await mkdir(dirname(join(path, rel)), { recursive: true })
      await copyFile(src, join(path, rel))
    } catch {
      // file absent — fine
    }
  }
  await runOk('bash', ['-c', cfg.setupCommand], { cwd: path, timeoutMs: 5 * 60_000 })
  return path
}

export async function removeWorktree(cfg: RalphConfig, issue: number): Promise<void> {
  await run('git', ['worktree', 'remove', '--force', worktreePath(cfg, issue)], { cwd: cfg.repoRoot })
}

export async function deleteBranch(cfg: RalphConfig, issue: number, force = false): Promise<void> {
  await run('git', ['branch', force ? '-D' : '-d', branchName(issue)], { cwd: cfg.repoRoot })
}

/** Commits on the issue branch that are not yet on the main branch. */
export async function commitsAhead(cfg: RalphConfig, issue: number): Promise<number> {
  const res = await run('git', ['rev-list', '--count', `${cfg.mainBranch}..${branchName(issue)}`], {
    cwd: cfg.repoRoot,
  })
  return res.code === 0 ? Number(res.stdout.trim()) || 0 : 0
}

export interface StaleWorktree {
  issue: number
  path: string
  commits: number
}

/** Find leftovers from a previous run (after `git worktree prune`). */
export async function scanStaleWorktrees(cfg: RalphConfig): Promise<StaleWorktree[]> {
  await run('git', ['worktree', 'prune'], { cwd: cfg.repoRoot })
  if (!existsSync(cfg.worktreesDir)) return []
  const stale: StaleWorktree[] = []
  for (const entry of readdirSync(cfg.worktreesDir)) {
    const match = entry.match(/^issue-(\d+)$/)
    if (!match) continue
    const issue = Number(match[1])
    stale.push({ issue, path: join(cfg.worktreesDir, entry), commits: await commitsAhead(cfg, issue) })
  }
  return stale
}
