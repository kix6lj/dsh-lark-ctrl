/**
 * The status card exposes the transcript: a folded preview, plus a list where
 * each row opens one message in full.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { messagesFrom } from '../lib/btw.js'
import { buildHistoryCard, buildStatusCard } from '../lib/cards.js'

const userEvent = (text, time) => ({
  type: 'user/message',
  time,
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const assistantEvent = (text, time) => ({
  type: 'assistant/message',
  time,
  data: { message: { content: [{ type: 'text', text }] } },
})

test('messagesFrom keeps user and assistant text, skips the rest', () => {
  const events = [
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    userEvent('第一条', 2),
    { type: 'tool/call', time: 3, data: { name: 'bash' } },
    { type: 'tool/result', time: 4, data: {} },
    assistantEvent('第二条', 5),
    { type: 'user/message', time: 6, data: { source: { kind: 'subagent' }, content: [{ type: 'text', text: '子代理' }] } },
    { type: 'turn/end', time: 7, data: { reason: { kind: 'completed' } } },
  ]
  const rows = messagesFrom(events)
  assert.deepEqual(rows.map((row) => [row.role, row.text]), [['user', '第一条'], ['assistant', '第二条']])
})

test('the status card folds recent messages and offers the list', () => {
  const card = buildStatusCard({
    code: 'k3f9zq',
    title: '清理',
    running: false,
    statusText: '空闲',
    sessionId: 'session-1',
    history: [
      { role: 'user', text: '先建目录', at: 1 },
      { role: 'assistant', text: '建好了', at: 2 },
    ],
  })
  const text = JSON.stringify(card)
  assert.equal(text.includes('最近输入'), false)
  assert.equal(text.includes('最近回复'), false)
  const button = card.body.elements.find((element) => element.behaviors?.[0]?.value?.op === 'history')
  assert.ok(button !== undefined)
})

test('the history card gives every row an index-addressed button', () => {
  const card = buildHistoryCard({
    code: 'k3f9zq',
    sessionId: 'session-1',
    rows: [
      { role: 'user', text: '第一行', at: 1 },
      { role: 'assistant', text: '第二行', at: 2 },
    ],
  })
  const buttons = card.body.elements
    .flatMap((element) => element.columns ?? [])
    .flatMap((column) => column.elements)
    .filter((element) => element.behaviors?.[0]?.value?.op === 'history_item')
  assert.deepEqual(buttons.map((element) => element.behaviors[0].value.index), [0, 1])
})

test('the history card shows 16 rows and folds the rest, newest first', () => {
  const rows = Array.from({ length: 32 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `第 ${index} 条`,
    at: 1000 - index,
  }))
  const card = buildHistoryCard({ code: 'k3f9zq', sessionId: 'session-1', rows })
  const visible = card.body.elements.filter((element) => element.tag === 'column_set')
  assert.equal(visible.length, 16)
  const panel = card.body.elements.find((element) => element.tag === 'collapsible_panel')
  assert.ok(panel !== undefined)
  assert.match(panel.header.title.content, /更早的 16 条/)
  assert.equal(panel.elements.length, 16)
  const indexes = [...JSON.stringify(card).matchAll(/"index":(\d+)/g)].map((match) => Number(match[1]))
  assert.deepEqual(indexes, Array.from({ length: 32 }, (_, index) => index))
})
