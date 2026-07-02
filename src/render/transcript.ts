import { paint, firstLine, truncate } from './ansi.ts'
import { summarizeToolUse } from './summarize.ts'
import type {
  StreamEvent,
  AssistantEvent,
  UserEvent,
  ResultEvent,
  SystemEvent,
  ToolResultBlock,
} from '../stream.ts'

export interface TranscriptOptions {
  color: boolean
  write: (text: string) => void
  cwd?: string
}

/**
 * Renders a stream-json event feed as a Claude-Code-style transcript:
 *
 *   ⏺ I'll start by reading the failing test…
 *   ⏺ Bash(pnpm --filter backend test)
 *     ⎿ 42 passed (8.2s)
 */
export class TranscriptRenderer {
  #opts: TranscriptOptions
  #pendingTools = new Map<string, string>()

  constructor(opts: TranscriptOptions) {
    this.#opts = opts
  }

  #out(text: string): void {
    this.#opts.write(text)
  }

  #style(style: Parameters<typeof paint>[1], text: string): string {
    return paint(this.#opts.color, style, text)
  }

  /** Minimal markdown → ANSI: bold, inline code, headers. */
  #markdown(text: string): string {
    if (!this.#opts.color) return text
    return text
      .replace(/^(#{1,6})\s+(.+)$/gm, (_, __, heading) => this.#style('bold', heading))
      .replace(/\*\*([^*]+)\*\*/g, (_, inner) => this.#style('bold', inner))
      .replace(/`([^`\n]+)`/g, (_, code) => this.#style('cyan', code))
  }

  handle(event: StreamEvent): void {
    switch (event.type) {
      case 'system': {
        const sys = event as SystemEvent
        if (sys.subtype === 'init') {
          this.#out(this.#style('dim', `· session started${sys.model ? ` (${sys.model})` : ''}\n`))
        }
        return
      }
      case 'assistant':
        return this.#assistant(event as AssistantEvent)
      case 'user':
        return this.#toolResults(event as UserEvent)
      case 'result':
        return this.#result(event as ResultEvent)
    }
  }

  #assistant(event: AssistantEvent): void {
    for (const block of event.message.content ?? []) {
      if (block.type === 'text' && block.text.trim()) {
        this.#out(`\n${this.#style('green', '⏺')} ${this.#markdown(block.text.trim())}\n`)
      } else if (block.type === 'thinking' && block.thinking.trim()) {
        const preview = truncate(firstLine(block.thinking), 100)
        this.#out(this.#style('dim', `✻ thinking… ${preview}\n`))
      } else if (block.type === 'tool_use') {
        const summary = summarizeToolUse(block.name, block.input, this.#opts.cwd)
        this.#pendingTools.set(block.id, block.name)
        this.#out(`${this.#style('green', '⏺')} ${this.#style('bold', block.name)}(${summary})\n`)
      }
    }
  }

  #toolResults(event: UserEvent): void {
    for (const block of event.message.content ?? []) {
      if (block.type !== 'tool_result') continue
      const result = block as ToolResultBlock
      this.#pendingTools.delete(result.tool_use_id)
      const text = toolResultPreview(result)
      const line = result.is_error
        ? this.#style('red', `error: ${text || 'failed'}`)
        : this.#style('dim', text || 'ok')
      this.#out(`  ⎿ ${line}\n`)
    }
  }

  #result(event: ResultEvent): void {
    const ok = !event.is_error && (!event.subtype || event.subtype === 'success')
    const header = ok ? this.#style('green', '── result ──') : this.#style('red', `── result (${event.subtype}) ──`)
    const stats: string[] = []
    if (event.duration_ms !== undefined) stats.push(`${(event.duration_ms / 1000).toFixed(0)}s`)
    if (event.num_turns !== undefined) stats.push(`${event.num_turns} turns`)
    if (event.total_cost_usd !== undefined) stats.push(`$${event.total_cost_usd.toFixed(2)}`)
    this.#out(`\n${header}\n`)
    if (event.result?.trim()) this.#out(`${this.#markdown(event.result.trim())}\n`)
    if (stats.length) this.#out(this.#style('dim', `${stats.join(' · ')}\n`))
  }
}

export function toolResultPreview(result: ToolResultBlock): string {
  const content = result.content
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .join(' ')
  }
  return truncate(firstLine(text), 120)
}
