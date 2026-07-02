import { styleText } from 'node:util'

export type Style = Parameters<typeof styleText>[0]

/** Style text for the terminal, or pass through unchanged when color is off. */
export function paint(color: boolean, style: Style, text: string): string {
  return color ? styleText(style, text) : text
}

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/** Truncate to a display width, appending an ellipsis when cut. */
export function truncate(text: string, maxWidth: number): string {
  const chars = [...text]
  if (chars.length <= maxWidth) return text
  return chars.slice(0, Math.max(0, maxWidth - 1)).join('') + '…'
}

/** Collapse a string to its first non-empty line. */
export function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  )
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

export const cursor = {
  up: (n: number) => (n > 0 ? `\x1b[${n}A` : ''),
  eraseDown: '\x1b[J',
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
}
