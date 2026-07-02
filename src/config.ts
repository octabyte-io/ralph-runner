export interface RalphConfig {
  repoRoot: string
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
  verifyCmd?: string
  logDir: string
  worktreesDir: string
  promptTemplatePath: string
}

export const READY_LABEL = 'ready-for-agent'
export const IN_PROGRESS_LABEL = 'in progress'
export const UNDER_REVIEW_LABEL = 'under review'
export const TODO_LABEL = 'todo'

export function chromeEnabled(cfg: RalphConfig, effectiveConcurrency: number): boolean {
  if (cfg.chrome === 'on') return true
  if (cfg.chrome === 'off') return false
  return effectiveConcurrency === 1
}
