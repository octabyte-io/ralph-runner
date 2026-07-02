import { cursor, paint, spinnerFrame, truncate, formatElapsed, stripAnsi } from './ansi.ts'
import type { Snapshot } from '../scheduler.ts'

/**
 * Repainting multi-agent status block. Permanent event lines are printed
 * above the block; the block itself is redrawn in place (~10 fps).
 * Falls back to plain periodic lines when stdout is not a TTY.
 */
export class Dashboard {
  #out: NodeJS.WriteStream
  #color: boolean
  #snapshot: Snapshot = { rows: [], merged: [], failed: [], queued: [], ready: [] }
  #paintedLines = 0
  #tick = 0
  #timer: NodeJS.Timeout | undefined
  #mainRef: string

  constructor(out: NodeJS.WriteStream, mainRef: string) {
    this.#out = out
    this.#color = out.isTTY === true
    this.#mainRef = mainRef
  }

  start(): void {
    if (!this.#out.isTTY) return
    this.#out.write(cursor.hide)
    this.#timer = setInterval(() => {
      this.#tick++
      this.#repaint()
    }, 100)
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#clear()
    if (this.#out.isTTY) this.#out.write(cursor.show)
  }

  update(snapshot: Snapshot): void {
    this.#snapshot = snapshot
    if (!this.#out.isTTY) return
    this.#repaint()
  }

  /** Print a permanent line above the repainting block. */
  event(line: string): void {
    this.#clear()
    const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false })
    this.#out.write(`${paint(this.#color, 'dim', stamp)}  ${line}\n`)
    this.#repaint()
  }

  #clear(): void {
    if (this.#paintedLines > 0 && this.#out.isTTY) {
      this.#out.write(cursor.up(this.#paintedLines) + cursor.eraseDown)
    }
    this.#paintedLines = 0
  }

  #repaint(): void {
    if (!this.#out.isTTY) return
    this.#clear()
    const s = this.#snapshot
    const width = this.#out.columns ?? 120
    const lines: string[] = []

    const counts = [
      `${s.rows.length} running`,
      s.ready.length ? `${s.ready.length} ready` : '',
      s.queued.length ? `${s.queued.length} blocked` : '',
      `${s.merged.length} merged`,
      s.failed.length ? paint(this.#color, 'red', `${s.failed.length} failed`) : '',
    ]
      .filter(Boolean)
      .join(' · ')
    lines.push(`${paint(this.#color, 'bold', 'ralph')} ${paint(this.#color, 'dim', this.#mainRef)}  ${counts}`)

    for (const row of s.rows) {
      const spin =
        row.state === 'MERGING'
          ? paint(this.#color, 'yellow', spinnerFrame(this.#tick))
          : paint(this.#color, 'cyan', spinnerFrame(this.#tick))
      const elapsed = formatElapsed(Date.now() - row.startedAt)
      const head = ` ${paint(this.#color, 'bold', `#${row.issue}`)} ${spin} ${elapsed.padStart(6)}  `
      const room = Math.max(20, width - stripAnsi(head).length - 1)
      lines.push(head + truncate(row.activity || row.title, room))
    }

    if (s.queued.length) {
      const queued = s.queued
        .map((q) => `#${q.issue}${q.blockedBy.length ? `←(${q.blockedBy.map((b) => `#${b}`).join(',')})` : ''}`)
        .join('  ')
      lines.push(paint(this.#color, 'dim', ` blocked: ${truncate(queued, width - 10)}`))
    }

    const block = lines.map((l) => truncateAnsiSafe(l, width)).join('\n') + '\n'
    this.#out.write(block)
    this.#paintedLines = lines.length
  }
}

/** Guard against painted lines wrapping (which would corrupt the repaint math). */
function truncateAnsiSafe(line: string, width: number): string {
  return stripAnsi(line).length <= width ? line : truncate(stripAnsi(line), width)
}
