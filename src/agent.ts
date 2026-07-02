import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { NdjsonDecoder, assistantText } from './stream.ts'
import type { StreamEvent, AssistantEvent, ResultEvent } from './stream.ts'
import { TranscriptRenderer } from './render/transcript.ts'
import { commitsAhead } from './worktree.ts'

export interface AgentOutcome {
  status: 'done' | 'blocked' | 'failed'
  reason?: string
  commits: number
  resultText: string
  costUsd?: number
  durationMs?: number
  numTurns?: number
}

export interface RunAgentOptions {
  repoRoot: string
  issue: number
  worktree: string
  prompt: string
  chrome: boolean
  maxMinutes: number
  logDir: string
  claudeCmd: string
  onEvent?: (event: StreamEvent) => void
  signal?: AbortSignal
}

const BLOCKED_SENTINEL = /<ralph>\s*BLOCKED:?\s*([^<]*)<\/ralph>/i

/**
 * Run one fresh-context Claude Code process against one issue, inside its
 * worktree. Streams events to `onEvent`, mirrors the raw NDJSON and a
 * rendered transcript into the log dir, and classifies the outcome.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentOutcome> {
  mkdirSync(opts.logDir, { recursive: true })
  const rawLog = createWriteStream(join(opts.logDir, `issue-${opts.issue}.jsonl`))
  const renderedLog = createWriteStream(join(opts.logDir, `issue-${opts.issue}.log`))
  const transcript = new TranscriptRenderer({
    color: false,
    cwd: opts.worktree,
    write: (s) => renderedLog.write(s),
  })

  const args = [
    '--print',
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
  ]
  if (opts.chrome) args.push('--chrome')

  const child = spawn(opts.claudeCmd, args, {
    cwd: opts.worktree,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let killedForTimeout = false
  const termTimer = setTimeout(() => {
    killedForTimeout = true
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
  }, opts.maxMinutes * 60_000)

  const onAbort = () => child.kill('SIGTERM')
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const decoder = new NdjsonDecoder()
  let finalAssistantText = ''
  let resultEvent: ResultEvent | undefined
  let stderrTail = ''

  const handleEvents = (events: StreamEvent[]) => {
    for (const event of events) {
      if (event.type === 'assistant') {
        const text = assistantText(event as AssistantEvent)
        if (text.trim()) finalAssistantText = text
      } else if (event.type === 'result') {
        resultEvent = event as ResultEvent
      }
      transcript.handle(event)
      opts.onEvent?.(event)
    }
  }

  child.stdout.on('data', (chunk: Buffer) => {
    rawLog.write(chunk)
    handleEvents(decoder.push(chunk))
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.stdin.write(opts.prompt)
  child.stdin.end()

  const exitCode: number | null = await new Promise((resolve) => {
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code))
  })
  clearTimeout(termTimer)
  opts.signal?.removeEventListener('abort', onAbort)
  handleEvents(decoder.flush())
  rawLog.end()
  renderedLog.end()

  const commits = await commitsAhead(opts.repoRoot, opts.issue)
  const resultText = resultEvent?.result ?? finalAssistantText
  const outcomeBase = {
    commits,
    resultText,
    costUsd: resultEvent?.total_cost_usd,
    durationMs: resultEvent?.duration_ms,
    numTurns: resultEvent?.num_turns,
  }

  if (opts.signal?.aborted) {
    return { ...outcomeBase, status: 'failed', reason: 'run aborted' }
  }
  if (killedForTimeout) {
    return { ...outcomeBase, status: 'failed', reason: `timed out after ${opts.maxMinutes} minutes` }
  }
  const blocked = (resultText + finalAssistantText).match(BLOCKED_SENTINEL)
  if (blocked) {
    return { ...outcomeBase, status: 'blocked', reason: blocked[1]?.trim() || 'agent reported blocked' }
  }
  if (exitCode !== 0) {
    return {
      ...outcomeBase,
      status: 'failed',
      reason: `claude exited ${exitCode}${stderrTail ? `: ${stderrTail.split('\n').at(-1)}` : ''}`,
    }
  }
  if (resultEvent && (resultEvent.is_error || (resultEvent.subtype && resultEvent.subtype !== 'success'))) {
    return { ...outcomeBase, status: 'failed', reason: `agent result: ${resultEvent.subtype}` }
  }
  if (commits === 0) {
    return { ...outcomeBase, status: 'failed', reason: 'agent finished without committing anything' }
  }
  return { ...outcomeBase, status: 'done' }
}
