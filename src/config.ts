import { readFileSync, existsSync } from 'node:fs'
import { join, isAbsolute, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface LabelsConfig {
  /** issues carrying this label are picked up */
  ready: string
  inProgress: string
  underReview: string
  todo: string
}

export interface TitleRankRule {
  /** case-insensitive regex matched against the issue title */
  pattern: string
  rank: number
}

/** Lower rank = worked first. */
export interface PriorityConfig {
  labelRanks: Record<string, number>
  titleRanks: TitleRankRule[]
  defaultRank: number
}

export interface RalphConfig {
  repoRoot: string
  mainBranch: string
  concurrency: number
  /** 'auto' → chrome iff effective concurrency is 1 */
  chrome: 'auto' | 'on' | 'off'
  /** issue number whose transcript streams live in multi-agent mode */
  follow?: number
  /** restrict the run to these issue numbers */
  issues?: number[]
  maxMinutes: number
  smoke: boolean
  dryRun: boolean
  clean: boolean
  pollIntervalMs: number
  /** overridable for testing (RALPH_CLAUDE_CMD / RALPH_GH_CMD / RALPH_VERIFY_CMD) */
  claudeCmd: string
  ghCmd: string
  /** run in a fresh worktree after env files are copied (bash -c) */
  setupCommand: string
  /** run on main after a merge; red rolls the merge back (bash -c) */
  verifyCommand: string
  /** additionally run at merge verification with --smoke (bash -c) */
  smokeCommand: string
  /** untracked files copied from the main checkout into each worktree when present */
  envFiles: string[]
  labels: LabelsConfig
  priority: PriorityConfig
  /** all paths below are absolute after loadConfig */
  logDir: string
  worktreesDir: string
  promptTemplatePath: string
}

/** Shape of .ralph/config.json — every field optional, merged over defaults. */
export interface FileConfig {
  mainBranch?: string
  concurrency?: number
  maxMinutes?: number
  pollIntervalSeconds?: number
  labels?: Partial<LabelsConfig>
  setupCommand?: string
  verifyCommand?: string
  smokeCommand?: string
  envFiles?: string[]
  worktreesDir?: string
  logDir?: string
  promptPath?: string
  priority?: {
    labelRanks?: Record<string, number>
    titleRanks?: TitleRankRule[]
    defaultRank?: number
  }
}

/** Flags parsed in main.ts; undefined = not given on the command line. */
export interface CliOverrides {
  concurrency?: number
  chrome?: 'on' | 'off'
  follow?: number
  issues?: number[]
  maxMinutes?: number
  smoke?: boolean
  dryRun?: boolean
  clean?: boolean
  verifyCmd?: string
}

export const CONFIG_RELPATH = join('.ralph', 'config.json')

export const DEFAULT_LABELS: LabelsConfig = {
  ready: 'ready-for-agent',
  inProgress: 'in progress',
  underReview: 'under review',
  todo: 'todo',
}

export const DEFAULT_PRIORITY: PriorityConfig = {
  labelRanks: { bug: 0, documentation: 2 },
  titleRanks: [
    { pattern: 'tracer', rank: 1 },
    { pattern: 'polish', rank: 2 },
    { pattern: 'refactor', rank: 4 },
  ],
  defaultRank: 3,
}

export const DEFAULT_FILE_CONFIG: Required<Omit<FileConfig, 'labels' | 'priority'>> & {
  labels: LabelsConfig
  priority: PriorityConfig
} = {
  mainBranch: 'main',
  concurrency: 3,
  maxMinutes: 30,
  pollIntervalSeconds: 30,
  labels: DEFAULT_LABELS,
  setupCommand: 'pnpm install --prefer-offline',
  verifyCommand: 'pnpm run test',
  smokeCommand: 'pnpm run smoke',
  envFiles: ['.env', '.envrc'],
  worktreesDir: '.worktrees',
  logDir: join('.ralph', 'logs'),
  promptPath: join('.ralph', 'prompt.md'),
  priority: DEFAULT_PRIORITY,
}

/** Directory containing the installed package (parent of src/). */
export function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

export function readFileConfig(repoRoot: string): FileConfig {
  const path = join(repoRoot, CONFIG_RELPATH)
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${(err as Error).message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`)
  }
  return parsed as FileConfig
}

/**
 * Resolve the effective config: built-in defaults ← .ralph/config.json
 * ← env (RALPH_*_CMD) ← CLI flags. Paths come out absolute; the prompt
 * falls back to the template shipped with the package when the project
 * has no .ralph/prompt.md.
 */
export function loadConfig(repoRoot: string, cli: CliOverrides = {}, env = process.env): RalphConfig {
  const file = readFileConfig(repoRoot)
  const d = DEFAULT_FILE_CONFIG

  const abs = (p: string): string => (isAbsolute(p) ? p : join(repoRoot, p))

  const promptPath = abs(file.promptPath ?? d.promptPath)
  const promptTemplatePath = existsSync(promptPath)
    ? promptPath
    : join(packageRoot(), 'prompt-template.md')

  return {
    repoRoot,
    mainBranch: file.mainBranch ?? d.mainBranch,
    concurrency: Math.max(1, cli.concurrency ?? file.concurrency ?? d.concurrency),
    chrome: cli.chrome ?? 'auto',
    follow: cli.follow,
    issues: cli.issues,
    maxMinutes: Math.max(1, cli.maxMinutes ?? file.maxMinutes ?? d.maxMinutes),
    smoke: cli.smoke ?? false,
    dryRun: cli.dryRun ?? false,
    clean: cli.clean ?? false,
    pollIntervalMs: Math.max(1, file.pollIntervalSeconds ?? d.pollIntervalSeconds) * 1000,
    claudeCmd: env.RALPH_CLAUDE_CMD || 'claude',
    ghCmd: env.RALPH_GH_CMD || 'gh',
    setupCommand: file.setupCommand ?? d.setupCommand,
    verifyCommand: cli.verifyCmd || env.RALPH_VERIFY_CMD || file.verifyCommand || d.verifyCommand,
    smokeCommand: file.smokeCommand ?? d.smokeCommand,
    envFiles: file.envFiles ?? d.envFiles,
    labels: { ...DEFAULT_LABELS, ...file.labels },
    priority: {
      labelRanks: file.priority?.labelRanks ?? DEFAULT_PRIORITY.labelRanks,
      titleRanks: file.priority?.titleRanks ?? DEFAULT_PRIORITY.titleRanks,
      defaultRank: file.priority?.defaultRank ?? DEFAULT_PRIORITY.defaultRank,
    },
    logDir: abs(file.logDir ?? d.logDir),
    worktreesDir: abs(file.worktreesDir ?? d.worktreesDir),
    promptTemplatePath,
  }
}

export function chromeEnabled(cfg: RalphConfig, effectiveConcurrency: number): boolean {
  if (cfg.chrome === 'on') return true
  if (cfg.chrome === 'off') return false
  return effectiveConcurrency === 1
}
