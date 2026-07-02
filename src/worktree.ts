import { copyFile, mkdir, access } from 'node:fs/promises'
import { readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { run, runOk } from './proc.ts'

/** Untracked config files an agent needs; copied into the worktree when present. */
const ENV_FILES = ['.env', '.envrc', 'backend/.env', 'backend/.env.test', 'frontend/.env', 'frontend/.env.local']

export function worktreePath(repoRoot: string, issue: number): string {
  return join(repoRoot, '.worktrees', `issue-${issue}`)
}

export function branchName(issue: number): string {
  return `ralph/issue-${issue}`
}

export async function createWorktree(repoRoot: string, issue: number): Promise<string> {
  const path = worktreePath(repoRoot, issue)
  await mkdir(dirname(path), { recursive: true })
  await runOk('git', ['worktree', 'add', path, '-b', branchName(issue), 'main'], { cwd: repoRoot })
  for (const rel of ENV_FILES) {
    const src = join(repoRoot, rel)
    try {
      await access(src)
      await mkdir(dirname(join(path, rel)), { recursive: true })
      await copyFile(src, join(path, rel))
    } catch {
      // file absent — fine
    }
  }
  await runOk('pnpm', ['install', '--prefer-offline'], { cwd: path, timeoutMs: 5 * 60_000 })
  return path
}

export async function removeWorktree(repoRoot: string, issue: number): Promise<void> {
  await run('git', ['worktree', 'remove', '--force', worktreePath(repoRoot, issue)], { cwd: repoRoot })
}

export async function deleteBranch(repoRoot: string, issue: number, force = false): Promise<void> {
  await run('git', ['branch', force ? '-D' : '-d', branchName(issue)], { cwd: repoRoot })
}

/** Commits on the issue branch that are not yet on main. */
export async function commitsAhead(repoRoot: string, issue: number): Promise<number> {
  const res = await run('git', ['rev-list', '--count', `main..${branchName(issue)}`], { cwd: repoRoot })
  return res.code === 0 ? Number(res.stdout.trim()) || 0 : 0
}

export interface StaleWorktree {
  issue: number
  path: string
  commits: number
}

/** Find leftovers from a previous run (after `git worktree prune`). */
export async function scanStaleWorktrees(repoRoot: string): Promise<StaleWorktree[]> {
  await run('git', ['worktree', 'prune'], { cwd: repoRoot })
  const dir = join(repoRoot, '.worktrees')
  if (!existsSync(dir)) return []
  const stale: StaleWorktree[] = []
  for (const entry of readdirSync(dir)) {
    const match = entry.match(/^issue-(\d+)$/)
    if (!match) continue
    const issue = Number(match[1])
    stale.push({ issue, path: join(dir, entry), commits: await commitsAhead(repoRoot, issue) })
  }
  return stale
}
