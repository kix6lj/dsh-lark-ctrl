/**
 * The completion status is derived from the turn's evidence, not only from
 * `turn/end`'s reason (which is `completed` for almost every turn).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { foldTurnStats, statusOf } from '../lib/summary.js'

test('status distinguishes a real run from a plain answer', () => {
  assert.deepEqual(statusOf({ reason: { kind: 'completed' }, toolCalls: 4, toolErrors: 0 }), {
    text: '✅ 已完成',
    tone: 'green',
  })
  assert.deepEqual(statusOf({ reason: { kind: 'completed' }, toolCalls: 0 }), {
    text: '💬 已回答',
    tone: 'blue',
  })
})

test('status surfaces tool failures and pending questions', () => {
  assert.deepEqual(statusOf({ reason: { kind: 'completed' }, toolCalls: 3, toolErrors: 2 }), {
    text: '⚠️ 有工具报错（2）',
    tone: 'orange',
  })
  assert.deepEqual(statusOf({ reason: { kind: 'completed' }, toolCalls: 3, pendingQuestion: true }), {
    text: '🙋 等你回答',
    tone: 'yellow',
  })
})

test('status keeps the transport-level reasons', () => {
  assert.deepEqual(statusOf({ reason: { kind: 'error' } }), { text: '❌ 失败', tone: 'red' })
  assert.deepEqual(statusOf({ reason: { kind: 'aborted' } }), { text: '🛑 已停止', tone: 'grey' })
  assert.deepEqual(statusOf({ reason: { kind: 'blocked' } }), { text: '⏸️ 被阻塞', tone: 'yellow' })
  assert.deepEqual(statusOf({ reason: { kind: 'max-tokens' } }), { text: '✂️ 触到输出上限', tone: 'orange' })
  assert.deepEqual(statusOf({}), { text: '✅ 已完成', tone: 'green' })
})

test('foldTurnStats counts failed tool results', () => {
  const events = [
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'tool/call', time: 2, data: { name: 'bash' } },
    { type: 'tool/result', time: 3, data: { error: { name: 'tool', code: 'denied' } } },
    { type: 'tool/result', time: 4, data: {} },
    { type: 'turn/end', time: 5, data: { reason: { kind: 'completed' } } },
  ]
  const stats = foldTurnStats(events)
  assert.equal(stats.toolCalls, 1)
  assert.equal(stats.toolErrors, 1)
  assert.equal(stats.toolWarnings, 0)
})

test('foldTurnStats separates recovered failures and interruption bookkeeping', () => {
  const events = [
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    // Transient conflict, retried successfully later: a notice, not an error.
    { type: 'tool/call', time: 2, data: { name: 'edit', callId: 'a' } },
    { type: 'tool/result', time: 3, data: { toolCallId: 'a', error: { name: 'FsError', code: 'FS_STALE_VERSION' } } },
    { type: 'tool/call', time: 4, data: { name: 'edit', callId: 'b' } },
    { type: 'tool/result', time: 5, data: { toolCallId: 'b' } },
    // Another tool succeeding must not "recover" an unrelated failure.
    { type: 'tool/call', time: 6, data: { name: 'bash', callId: 'c' } },
    { type: 'tool/result', time: 7, data: { toolCallId: 'c', error: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' } } },
    { type: 'tool/call', time: 8, data: { name: 'read', callId: 'd' } },
    { type: 'tool/result', time: 9, data: { toolCallId: 'd' } },
    // DSH closes an interrupted call with a synthetic result: not a failure.
    { type: 'tool/call', time: 10, data: { name: 'bash', callId: 'e' } },
    { type: 'tool/result', time: 11, data: { toolCallId: 'e', error: { name: 'AbortError', code: 'TOOL_ABORTED_BEFORE_DISPATCH' } } },
    { type: 'turn/end', time: 12, data: { reason: { kind: 'completed' } } },
  ]
  const stats = foldTurnStats(events)
  assert.equal(stats.toolCalls, 5)
  assert.equal(stats.toolErrors, 1)
  assert.equal(stats.toolWarnings, 1)
})

test('status only surfaces unrecovered tool failures as errors', () => {
  assert.deepEqual(statusOf({ reason: { kind: 'completed' }, toolCalls: 5, toolErrors: 0 }), {
    text: '✅ 已完成',
    tone: 'green',
  })
})
