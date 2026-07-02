import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBlockedBy, priorityRank, sortByPriority, isWorkable } from '../src/issues.ts'
import type { Issue } from '../src/issues.ts'
import { DEFAULT_LABELS, DEFAULT_PRIORITY } from '../src/config.ts'

const issue = (partial: Partial<Issue>): Issue => ({
  number: 1,
  title: 't',
  body: '',
  labels: [],
  ...partial,
})

test('parseBlockedBy extracts refs from the Blocked by section', () => {
  const body = `## What to build\nStuff referencing #99 inline.\n\n## Blocked by\n\n- #26\n- #27\n\n## Acceptance\n- see #100`
  assert.deepEqual(parseBlockedBy(body), [26, 27])
})

test('parseBlockedBy ignores refs outside the section', () => {
  assert.deepEqual(parseBlockedBy('Parent PRD #22\nRelates to #5'), [])
})

test('parseBlockedBy handles empty and missing sections', () => {
  assert.deepEqual(parseBlockedBy('## Blocked by\n\n## Next\n#7'), [])
  assert.deepEqual(parseBlockedBy(''), [])
})

test('parseBlockedBy dedupes and reads section at end of body', () => {
  assert.deepEqual(parseBlockedBy('intro\n## Blocked by\n#3 and #3 and #4'), [3, 4])
})

test('priority: bug > tracer > polish > other > refactor', () => {
  const bug = issue({ number: 10, labels: ['bug'] })
  const tracer = issue({ number: 11, title: 'Tracer bullet: thin slice' })
  const polish = issue({ number: 12, title: 'Polish error messages' })
  const other = issue({ number: 13, title: 'Slice 4: something' })
  const refactor = issue({ number: 14, title: 'Refactor planner' })
  const sorted = sortByPriority([refactor, other, polish, tracer, bug], DEFAULT_PRIORITY)
  assert.deepEqual(
    sorted.map((i) => i.number),
    [10, 11, 12, 13, 14],
  )
})

test('priority ties break by ascending issue number', () => {
  const a = issue({ number: 25, title: 'Slice 3' })
  const b = issue({ number: 23, title: 'Slice 1' })
  assert.deepEqual(sortByPriority([a, b], DEFAULT_PRIORITY).map((i) => i.number), [23, 25])
})

test('priorityRank is stable for unknown shapes', () => {
  assert.equal(priorityRank(issue({ title: 'Slice 1: persistence' }), DEFAULT_PRIORITY), 3)
})

test('priorityRank honors custom label and title rules', () => {
  const custom = {
    labelRanks: { hotfix: 0 },
    titleRanks: [{ pattern: 'spike', rank: 5 }],
    defaultRank: 2,
  }
  assert.equal(priorityRank(issue({ labels: ['hotfix'] }), custom), 0)
  assert.equal(priorityRank(issue({ title: 'Spike: try the thing' }), custom), 5)
  assert.equal(priorityRank(issue({ labels: ['bug'] }), custom), 2) // 'bug' unknown here
})

test('isWorkable skips PRDs and in-flight labels', () => {
  assert.equal(isWorkable(issue({ title: 'PRD: Phase 3 — Generation' }), DEFAULT_LABELS), false)
  assert.equal(isWorkable(issue({ title: 'prd: lowercase' }), DEFAULT_LABELS), false)
  assert.equal(isWorkable(issue({ labels: ['in progress'] }), DEFAULT_LABELS), false)
  assert.equal(isWorkable(issue({ labels: ['under review'] }), DEFAULT_LABELS), false)
  assert.equal(isWorkable(issue({ title: 'Slice 1: build the thing' }), DEFAULT_LABELS), true)
})

test('isWorkable respects custom labels', () => {
  const labels = { ...DEFAULT_LABELS, inProgress: 'wip', underReview: 'needs-human' }
  assert.equal(isWorkable(issue({ labels: ['wip'] }), labels), false)
  assert.equal(isWorkable(issue({ labels: ['Needs-Human'] }), labels), false)
  assert.equal(isWorkable(issue({ labels: ['in progress'] }), labels), true)
})
