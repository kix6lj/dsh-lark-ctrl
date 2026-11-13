/**
 * Long answers get folded into a collapsible panel so the phone shows a short
 * preview instead of a cut-off wall of text.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildEndCard, fitCard } from '../lib/cards.js'

const base = {
  code: 'k3f9zq',
  title: '长回答',
  reasonText: '✅ 已完成',
  tone: 'green',
  userText: '写一份长报告',
  failed: false,
  durationText: '2m',
  toolCalls: 3,
  toolNames: ['bash'],
  usage: { inputTokens: 100, outputTokens: 200 },
  model: 'deepseek-flash',
  sessionId: 'session-1',
}

test('short answers keep no panel', () => {
  const card = buildEndCard({ ...base, summary: '一句话回答。', summaryFull: '一句话回答。' })
  assert.equal(JSON.stringify(card).includes('collapsible_panel'), false)
})

test('long answers fold the full text behind a collapsed panel', () => {
  const full = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行：这一行是正文内容，用来把卡片撑长。`).join('\n')
  const card = fitCard(buildEndCard({ ...base, summary: full.slice(0, 1500), summaryFull: full }))
  const panel = card.body.elements.find((element) => element.tag === 'collapsible_panel')
  assert.ok(panel !== undefined)
  assert.equal(panel.expanded, false)
  assert.match(panel.header.title.content, new RegExp(`展开完整回复（${full.length} 字）`))
  assert.equal(panel.elements[0].content, full)
  // The preview stays short so the collapsed card is readable on a phone.
  const preview = card.body.elements.find((element) => element.tag === 'markdown')
  assert.ok(preview.content.length <= 320)
  assert.ok(JSON.stringify(card).length < 28000)
})

test('a full answer beyond the cap keeps the card under the size limit', () => {
  const huge = '长'.repeat(30000)
  const card = fitCard(buildEndCard({ ...base, summary: huge.slice(0, 1500), summaryFull: '长'.repeat(6000), fullTruncated: true }))
  assert.ok(JSON.stringify(card).length < 28000)
  assert.match(JSON.stringify(card), /超过卡片上限/)
})
