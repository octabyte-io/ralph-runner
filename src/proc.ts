import { spawn } from 'node:child_process'

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface RunOptions {
  cwd?: string
  input?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

/** Run a command, capture stdout/stderr, never throw on non-zero exit. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timer: NodeJS.Timeout | undefined
    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
    }
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    if (opts.input !== undefined) child.stdin.write(opts.input)
    child.stdin.end()
  })
}

/** Run a command, throw with stderr context on non-zero exit, return trimmed stdout. */
export async function runOk(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const res = await run(cmd, args, opts)
  if (res.code !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} exited ${res.code}\n${res.stderr.trim() || res.stdout.trim()}`,
    )
  }
  return res.stdout.trim()
}

/** Retry an async operation with linear backoff (for flaky gh/network calls). */
export async function retry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 1000): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)))
    }
  }
  throw lastErr
}
