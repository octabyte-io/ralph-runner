import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeToolUse } from '../src/render/summarize.ts'

test('Bash prefers description over command', () => {
  assert.equal(summarizeToolUse('Bash', { description: 'Run tests', command: 'pnpm test' }), 'Run tests')
  assert.equal(summarizeToolUse('Bash', { command: 'pnpm test\necho done' }), 'pnpm test')
})

test('file tools relativize inside cwd and keep outside paths absolute', () => {
  assert.equal(summarizeToolUse('Edit', { file_path: '/repo/src/app.ts' }, '/repo'), 'src/app.ts')
  assert.equal(summarizeToolUse('Read', { file_path: '/elsewhere/x.ts' }, '/repo'), '/elsewhere/x.ts')
})

test('TodoWrite surfaces the in-progress item', () => {
  const todos = [
    { content: 'done thing', status: 'completed' },
    { content: 'current thing', status: 'in_progress' },
  ]
  assert.equal(summarizeToolUse('TodoWrite', { todos }), 'current thing')
  assert.equal(summarizeToolUse('TodoWrite', { todos: [{ content: 'a', status: 'pending' }] }), '1 todos')
})

test('unknown tools fall back to compact JSON, truncated', () => {
  const summary = summarizeToolUse('Mystery', { key: 'x'.repeat(300) })
  assert.ok(summary.startsWith('{"key"'))
  assert.ok(summary.length <= 101)
})

test('Grep includes pattern and optional path', () => {
  assert.equal(summarizeToolUse('Grep', { pattern: 'foo', path: '/repo/src' }, '/repo'), 'foo in src')
})
