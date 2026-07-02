import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPrompt } from '../src/prompt.ts'

const templatePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompt-template.md')

test('buildPrompt substitutes every placeholder in the real template', async () => {
  const prompt = await buildPrompt(templatePath, {
    issue: { number: 42, title: 'Fix the widget', body: 'Widget is broken. See #22.', labels: [] },
    comments: [{ author: 'nabeel', body: 'also check the flange' }],
    worktree: '/repo/.worktrees/issue-42',
    branch: 'ralph/issue-42',
  })
  assert.ok(prompt.includes('issue #42'))
  assert.ok(prompt.includes('Fix the widget'))
  assert.ok(prompt.includes('Widget is broken'))
  assert.ok(prompt.includes('**nabeel:**'))
  assert.ok(prompt.includes('/repo/.worktrees/issue-42'))
  assert.ok(prompt.includes('ralph/issue-42'))
  assert.ok(!/{{[A-Z]+}}/.test(prompt), 'no unreplaced placeholders remain')
})

test('buildPrompt renders a no-comments marker', async () => {
  const prompt = await buildPrompt(templatePath, {
    issue: { number: 1, title: 't', body: 'b', labels: [] },
    comments: [],
    worktree: '/w',
    branch: 'ralph/issue-1',
  })
  assert.ok(prompt.includes('(no comments)'))
})
