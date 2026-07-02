import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NdjsonDecoder } from '../src/stream.ts'

test('decoder handles events split across chunk boundaries', () => {
  const decoder = new NdjsonDecoder()
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })
  const events = [
    ...decoder.push(line.slice(0, 10)),
    ...decoder.push(line.slice(10) + '\n' + '{"type":"result","subt'),
    ...decoder.push('ype":"success"}\n'),
  ]
  assert.equal(events.length, 2)
  assert.equal(events[0]!.type, 'assistant')
  assert.equal(events[1]!.type, 'result')
})

test('decoder skips non-JSON noise lines', () => {
  const decoder = new NdjsonDecoder()
  const events = decoder.push('some CLI banner\n{"type":"system","subtype":"init"}\nnot json {\n')
  assert.equal(events.length, 1)
  assert.equal(events[0]!.type, 'system')
})

test('flush drains a final unterminated line', () => {
  const decoder = new NdjsonDecoder()
  assert.equal(decoder.push('{"type":"result"}').length, 0)
  const events = decoder.flush()
  assert.equal(events.length, 1)
  assert.equal(events[0]!.type, 'result')
})

test('objects without a type field are ignored', () => {
  const decoder = new NdjsonDecoder()
  assert.equal(decoder.push('{"foo":1}\n').length, 0)
})
