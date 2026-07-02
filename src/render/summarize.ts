import { relative, isAbsolute } from 'node:path'
import { firstLine, truncate } from './ansi.ts'

const MAX_SUMMARY = 100

function relativize(filePath: string, cwd?: string): string {
  if (cwd && isAbsolute(filePath)) {
    const rel = relative(cwd, filePath)
    if (!rel.startsWith('..')) return rel
  }
  return filePath
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * One-line human summary of a tool invocation, in the spirit of the
 * Claude Code CLI's own tool lines: Bash(pnpm test), Edit(src/app.ts), …
 */
export function summarizeToolUse(
  name: string,
  input: Record<string, unknown>,
  cwd?: string,
): string {
  let summary: string
  switch (name) {
    case 'Bash':
      summary = str(input.description) || firstLine(str(input.command))
      break
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      summary = relativize(str(input.file_path), cwd)
      break
    case 'Grep':
      summary = str(input.pattern) + (input.path ? ` in ${relativize(str(input.path), cwd)}` : '')
      break
    case 'Glob':
      summary = str(input.pattern)
      break
    case 'Task':
    case 'Agent':
      summary = str(input.description)
      break
    case 'WebFetch':
      summary = str(input.url)
      break
    case 'WebSearch':
      summary = str(input.query)
      break
    case 'Skill':
      summary = str(input.skill) + (input.args ? ` ${str(input.args)}` : '')
      break
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : []
      const active = todos.find(
        (t) => t && typeof t === 'object' && (t as { status?: string }).status === 'in_progress',
      ) as { content?: string } | undefined
      summary = active?.content ?? `${todos.length} todos`
      break
    }
    default:
      summary = ''
  }
  if (!summary) {
    try {
      summary = JSON.stringify(input)
    } catch {
      summary = ''
    }
  }
  return truncate(firstLine(summary), MAX_SUMMARY)
}
