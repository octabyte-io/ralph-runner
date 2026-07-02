import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MergeQueue } from '../src/merge.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('MergeQueue runs jobs strictly one at a time, in order', async () => {
  const queue = new MergeQueue()
  const log: string[] = []
  const job = (name: string, ms: number) => async () => {
    log.push(`${name}:start`)
    await sleep(ms)
    log.push(`${name}:end`)
    return name
  }
  const [a, b, c] = await Promise.all([
    queue.enqueue(job('a', 30)),
    queue.enqueue(job('b', 5)),
    queue.enqueue(job('c', 1)),
  ])
  assert.deepEqual([a, b, c], ['a', 'b', 'c'])
  assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'])
})

test('MergeQueue keeps serving after a job throws', async () => {
  const queue = new MergeQueue()
  await assert.rejects(queue.enqueue(async () => {
    throw new Error('boom')
  }))
  assert.equal(await queue.enqueue(async () => 42), 42)
})
