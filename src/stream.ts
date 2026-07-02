/**
 * Typed shapes for `claude --output-format stream-json` NDJSON events,
 * plus an incremental decoder that survives chunk boundaries mid-line.
 */

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: unknown
  is_error?: boolean
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock

export interface SystemEvent {
  type: 'system'
  subtype?: string
  session_id?: string
  model?: string
}

export interface AssistantEvent {
  type: 'assistant'
  message: { content?: ContentBlock[] }
}

export interface UserEvent {
  type: 'user'
  message: { content?: ContentBlock[] }
}

export interface ResultEvent {
  type: 'result'
  subtype?: string
  result?: string
  is_error?: boolean
  duration_ms?: number
  total_cost_usd?: number
  num_turns?: number
}

export interface UnknownEvent {
  type: string
  [key: string]: unknown
}

export type StreamEvent = SystemEvent | AssistantEvent | UserEvent | ResultEvent | UnknownEvent

/**
 * Incremental NDJSON decoder. Feed it raw chunks; it emits one parsed event
 * per complete line that parses as a JSON object with a `type` field.
 * Non-JSON lines (CLI noise) are silently skipped, mirroring ralph.sh's grep '^{'.
 */
export class NdjsonDecoder {
  #buffer = ''

  push(chunk: string | Buffer): StreamEvent[] {
    this.#buffer += chunk.toString()
    const lines = this.#buffer.split('\n')
    this.#buffer = lines.pop() ?? ''
    return lines.flatMap((line) => this.#parse(line))
  }

  /** Call once at stream end to drain any final unterminated line. */
  flush(): StreamEvent[] {
    const rest = this.#buffer
    this.#buffer = ''
    return this.#parse(rest)
  }

  #parse(line: string): StreamEvent[] {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return []
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
        return [parsed as StreamEvent]
      }
    } catch {
      // partial or malformed line — skip
    }
    return []
  }
}

/** Extract all plain text from an assistant event's content blocks. */
export function assistantText(event: AssistantEvent): string {
  return (event.message.content ?? [])
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}
