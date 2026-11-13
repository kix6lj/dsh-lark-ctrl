import assert from 'node:assert/strict'
import { test } from 'node:test'

import { findHelpTopic } from '../lib/help.js'

import {
  buildApprovalCard,
  buildArchiveDeletePreviewCard,
  buildArchiveResultCard,
  buildArchiveStatusCard,
  buildApprovalResolvedCard,
  buildEndCard,
  buildCreateSessionCard,
  buildCreateWorkspaceCard,
  buildHelpCard,
  buildHelpTopicCard,
  buildLevelCard,
  buildQuestionCard,
  buildSessionCreatedCard,
  buildSessionDetailCard,
  buildSessionsCard,
  buildStartCard,
  buildWorkspacesCard,
  buildStatusCard,
  extractFormAnswers,
  fitCard,
  normalizeFormValue,
  parseApprovalText,
  parseTextAnswer,
} from '../lib/cards.js'

const questions = [
  {
    id: 'cleanup',
    header: '清理',
    question: '是否删除这三个文件？',
    detail: '删除后不可恢复',
    options: [
      { label: '删除 (Recommended)', description: '删除 3 个文件' },
      { label: '保留' },
    ],
  },
  {
    id: 'keep',
    question: '要保留哪些？',
    options: [{ label: '日志' }, { label: '缓存' }],
    multiSelect: true,
  },
]

test('question card is a Card 2.0 form with one field pair per question', () => {
  const card = buildQuestionCard({ code: 'k3f9zq', title: '清理任务', questions })
  assert.equal(card.schema, '2.0')
  const tags = card.body.elements.map((element) => element.tag)
  assert.ok(tags.includes('form'))
  const form = card.body.elements.find((element) => element.tag === 'form')
  const names = form.elements.map((element) => element.name).filter(Boolean)
  assert.deepEqual(names, ['q0', 'c0', 'q1', 'c1', 'answer_submit'])
  assert.equal(form.elements.find((element) => element.name === 'q1').tag, 'multi_select_static')
})

test('form answers become the exact AskUserQuestionAnswer shape', () => {
  const card = buildQuestionCard({ code: 'k3f9zq', questions })
  assert.equal(JSON.parse(JSON.stringify(card)).schema, '2.0')
  const parsed = extractFormAnswers(
    JSON.stringify({ q0: '保留', c0: '', q1: ['日志'], c1: '也可以' }),
    questions,
  )
  assert.deepEqual(parsed.answers, [
    { id: 'cleanup', selected: ['保留'] },
    { id: 'keep', selected: ['日志'], custom: '也可以' },
  ])
})

test('custom text overrides a single-select answer', () => {
  const parsed = extractFormAnswers(JSON.stringify({ q0: '保留', c0: '都不对，先备份' }), questions.slice(0, 1))
  assert.deepEqual(parsed.answers, [
    { id: 'cleanup', selected: [], custom: '都不对，先备份' },
  ])
})

test('skipped questions keep the existing answer shape', () => {
  const parsed = extractFormAnswers({}, questions)
  assert.deepEqual(parsed.answers, [
    { id: 'cleanup', selected: [] },
    { id: 'keep', selected: [] },
  ])
})

test('empty form values are not a form submit', () => {
  assert.equal(normalizeFormValue(''), undefined)
  assert.equal(normalizeFormValue('not json'), undefined)
  assert.deepEqual(normalizeFormValue('{}'), {})
})

test('text reply supports index, label and custom text', () => {
  assert.deepEqual(parseTextAnswer('1', [questions[0]]).answers, [
    { id: 'cleanup', selected: ['删除 (Recommended)'] },
  ])
  assert.deepEqual(parseTextAnswer('保留', [questions[0]]).answers, [
    { id: 'cleanup', selected: ['保留'] },
  ])
  assert.deepEqual(parseTextAnswer('先别删', [questions[0]]).answers, [
    { id: 'cleanup', selected: [], custom: '先别删' },
  ])
})

test('multi-select text reply splits values', () => {
  assert.deepEqual(parseTextAnswer('日志, 缓存', [questions[1]]).answers, [
    { id: 'keep', selected: ['日志', '缓存'] },
  ])
})

test('text reply rejects a multi-question card', () => {
  assert.match(parseTextAnswer('1', questions).error, /多个问题/)
})

test('approval text keywords map to a decision', () => {
  assert.equal(parseApprovalText('1'), 'allow')
  assert.equal(parseApprovalText('允许一次'), 'allow')
  assert.equal(parseApprovalText('2'), 'reject')
  assert.equal(parseApprovalText('拒绝'), 'reject')
  assert.equal(parseApprovalText('maybe'), undefined)
})

test('notification cards carry the session code and stable structure', () => {
  const start = buildStartCard({
    code: 'k3f9zq',
    title: '清理',
    prompt: '帮我清理文件',
    cwd: '/tmp/cleanup',
    model: 'deepseek-flash',
    sessionId: 'session-1',
  })
  assert.equal(start.schema, '2.0')
  // The header carries what a human recognises (the title); the session code is
  // demoted to the footer meta line but stays inside the card for quoting.
  assert.match(start.header.title.content, /清理/)
  assert.match(JSON.stringify(start), /k3f9zq/)

  const end = buildEndCard({
    code: 'k3f9zq',
    title: '清理',
    summary: '已清理三个文件。',
    userText: '帮我清理文件',
    reasonText: '已完成',
    failed: false,
    durationText: '1m02s',
    toolCalls: 4,
    toolNames: ['bash', 'read'],
    usage: { inputTokens: 12000, outputTokens: 800 },
    sessionId: 'session-1',
  })
  assert.equal(end.header.template, 'green')
  assert.match(end.header.title.content, /清理/)
  assert.match(JSON.stringify(end), /k3f9zq/)
  assert.ok(end.body.elements.some((element) => element.tag === 'form'))

  const approval = buildApprovalCard({
    code: 'k3f9zq',
    toolName: 'bash',
    reason: '需要删除文件',
    approvalKey: 'a1',
  })
  assert.equal(approval.header.template, 'red')

  const status = buildStatusCard({ code: 'k3f9zq', title: '清理', running: true, statusText: '运行中' })
  assert.equal(status.header.template, 'blue')
})

test('oversized cards are reduced below the Lark limit', () => {
  const card = fitCard({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'x'.repeat(40000) }] } })
  assert.ok(JSON.stringify(card).length < 28000)
})

test('a single single-select question uses one-tap option buttons', () => {
  const card = buildQuestionCard({
    code: 'k3f9zq',
    questions: [{
      id: 'one',
      question: '继续吗？',
      options: [{ label: '继续' }, { label: '停止' }],
    }],
  })
  const buttons = card.body.elements.filter((element) => element.tag === 'button')
  assert.equal(buttons.length, 2)
  assert.deepEqual(buttons.map((item) => item.behaviors[0].value.op), ['answer', 'answer'])
  assert.deepEqual(buttons.map((item) => item.behaviors[0].value.label), ['继续', '停止'])
  assert.ok(!card.body.elements.some((element) => element.tag === 'form' && element.name === 'answer_form'))
  const custom = card.body.elements.find((element) => element.tag === 'form')
  assert.equal(custom.name, 'custom_form')
})

test('a multi-question card keeps the submit form', () => {
  const card = buildQuestionCard({ code: 'k3f9zq', questions })
  const form = card.body.elements.find((element) => element.tag === 'form')
  assert.equal(form.name, 'answer_form')
  assert.ok(form.elements.some((element) => element.name === 'answer_submit'))
})

test('every input stays within Lark\'s 1000-character max_length', () => {
  const cards = [
    buildEndCard({
      code: 'k3f9zq',
      title: 't',
      summary: 's',
      userText: 'u',
      reasonText: '已完成',
      failed: false,
      durationText: '1s',
      toolCalls: 1,
      toolNames: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      sessionId: 's1',
    }),
    buildQuestionCard({
      code: 'k3f9zq',
      questions: [{ id: 'q', question: 'q', options: [{ label: 'a' }, { label: 'b' }] }],
    }),
  ]
  const inputs = []
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (typeof value === 'object' && value !== null) {
      if (value.tag === 'input' && value.max_length !== undefined) inputs.push(value.max_length)
      for (const item of Object.values(value)) walk(item)
    }
  }
  for (const card of cards) walk(card)
  assert.ok(inputs.length > 0)
  for (const max of inputs) assert.ok(max <= 1000, `max_length ${max} exceeds 1000`)
})


test('sessions card exposes one open button per session', () => {
  const card = buildSessionsCard({
    rangeLabel: '最近 1 天',
    sessions: [
      { sessionId: 's1', code: 'abcxyz', title: '会话一', running: true, updatedAt: 1000 },
      { sessionId: 's2', code: 'def234', title: '会话二', running: false, updatedAt: 2000 },
    ],
  })
  assert.match(card.header.subtitle.content, /最近 1 天/)
  const buttons = card.body.elements.flatMap((element) => {
    if (element.tag !== 'column_set') return []
    return element.columns.flatMap((column) => column.elements).filter((item) => item.tag === 'button')
  })
  assert.equal(buttons.length, 2)
  assert.deepEqual(buttons.map((item) => item.behaviors[0].value.op), ['session_open', 'session_open'])
})

test('session detail card has prompt form, hash block and actions', () => {
  const card = buildSessionDetailCard({
    code: 'abcxyz',
    sessionId: 's1',
    title: '会话一',
    running: false,
    updatedAt: 1000,
    cwd: '/tmp',
  })
  const serialized = JSON.stringify(card)
  assert.match(serialized, /#abcxyz/)
  const form = card.body.elements.find((element) => element.tag === 'form')
  assert.equal(form.name, 'session_form')
  assert.ok(form.elements.some((element) => element.name === 'prompt'))
  assert.ok(!form.elements.some((element) => element.name === 'session_btw'))
  const ops = []
  const walk = (value) => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return }
    if (typeof value === 'object' && value !== null) {
      if (value.tag === 'button' && value.behaviors) ops.push(value.behaviors[0].value.op)
      for (const item of Object.values(value)) walk(item)
    }
  }
  walk(card)
  assert.ok(ops.includes('sessions'))
  assert.ok(ops.includes('status'))
})

test('level card exposes three level buttons and current state', () => {
  const card = buildLevelCard({ current: 1 })
  assert.match(JSON.stringify(card), /当前 L1/)
  const buttons = card.body.elements.flatMap((element) => {
    if (element.tag === 'column_set') return element.columns.flatMap((column) => column.elements)
    return []
  }).filter((item) => item.tag === 'button')
  assert.deepEqual(buttons.map((item) => item.behaviors[0].value.level), [0, 1, 2])
})

test('workspaces card groups sessions and offers creation actions', () => {
  const card = buildWorkspacesCard({
    rangeLabel: '最近 1 天',
    groups: [{
      workspace: { id: 'w1', title: '项目', path: '/tmp/project', missingDir: false },
      sessions: [{ sessionId: 's1', code: 'abcxyz', title: '会话', running: true, updatedAt: 1000 }],
    }],
    ungrouped: [],
  })
  const serialized = JSON.stringify(card)
  assert.match(serialized, /workspace_new_session/)
  assert.match(serialized, /workspace_new/)
  assert.match(serialized, /session_open/)
  assert.match(serialized, /最近 1 天/)
})

test('create session card has mode/model/permission selects and a prompt form', () => {
  const card = buildCreateSessionCard({
    workspace: { id: 'w1', title: '项目', path: '/tmp/project' },
    agentPresets: [{ value: 'standard', text: 'Standard' }],
    models: [{ value: 'p::m', text: 'P · M' }],
    efforts: [{ value: '', text: '默认（模型决定）' }, { value: 'high', text: 'High' }],
    permissions: [{ value: 'safe', text: 'Safe' }],
    defaults: { agentPreset: 'standard', model: 'p::m', effort: 'high', permission: 'safe' },
  })
  const form = card.body.elements.find((element) => element.tag === 'form')
  const names = form.elements.map((item) => item.name)
  assert.deepEqual(names, ['agent_preset', 'model', 'effort', 'permission', 'prompt', 'session_create_submit'])
  const prompt = form.elements.find((item) => item.name === 'prompt')
  assert.ok(prompt.max_length <= 1000)
})

test('create workspace card asks for an absolute path and optional title', () => {
  const card = buildCreateWorkspaceCard()
  const form = card.body.elements.find((element) => element.tag === 'form')
  assert.deepEqual(form.elements.map((item) => item.name), ['path', 'title', 'workspace_create_submit'])
})

test('session created card opens the new session', () => {
  const card = buildSessionCreatedCard({ code: 'abcxyz', sessionId: 's1', title: '新会话', promptSent: true })
  assert.match(JSON.stringify(card), /session_open/)
  assert.match(card.header.title.content, /abcxyz/)
})


test('session detail form has separate send and btw submit buttons', () => {
  const card = buildSessionDetailCard({
    code: 'abcxyz',
    sessionId: 's1',
    title: '会话',
    running: false,
  })
  const form = card.body.elements.find((element) => element.tag === 'form')
  const buttons = form.elements.filter((element) => element.tag === 'button')
  assert.deepEqual(buttons.map((item) => item.name), ['session_send'])
  assert.ok(buttons.every((item) => item.form_action_type === 'submit'))
})

test('end card strips images and explains why the summary is shorter', () => {
  const card = buildEndCard({
    code: 'abcxyz',
    title: '会话',
    summary: '完成。\n![截图](https://example.com/screen.png)',
    userText: '看下截图 ![x](https://example.com/x.png)',
    reasonText: '已完成',
    failed: false,
    durationText: '1 秒',
    toolCalls: 0,
    usage: { inputTokens: 1, outputTokens: 2 },
    sessionId: 's1',
  })
  const serialized = JSON.stringify(card)
  assert.doesNotMatch(serialized, /!\[/)
  assert.match(serialized, /图片已省略/)
  assert.match(serialized, /（图片已省略）/)
})

test('help topic card contains usage, examples, notes and related actions', () => {
  const topic = findHelpTopic('/sessions')
  const card = buildHelpTopicCard(topic)
  const serialized = JSON.stringify(card)
  assert.equal(card.header.title.content, '帮助 · /sessions')
  assert.match(serialized, /\/sessions 1d/)
  assert.match(serialized, /已归档/)
  assert.match(serialized, /help_index/)
  assert.match(serialized, /help_topic/)
})

test('help index points at detailed help', () => {
  const serialized = JSON.stringify(buildHelpCard())
  assert.match(serialized, /\/help \/sessions/)
  assert.match(serialized, /#code/)
  assert.match(serialized, /\/workspaces/)
})

test('status card displays mode/model/thinking/permission and edits them', () => {
  const card = buildStatusCard({
    code: 'abcxyz',
    sessionId: 's1',
    title: '会话',
    running: true,
    statusText: '运行中',
    model: 'm',
    modelLabel: 'P · M',
    modelValue: 'p::m',
    agentPreset: 'standard',
    modeLabel: 'Standard',
    effort: 'high',
    effortLabel: 'High',
    permission: 'safe',
    permissionLabel: 'Safe',
    archiveAvailable: true,
    options: {
      models: [{ value: 'p::m', text: 'P · M' }],
      efforts: [{ value: '', text: '默认（模型决定）' }, { value: 'high', text: 'High' }],
      permissions: [{ value: 'safe', text: 'Safe' }],
    },
  })
  const serialized = JSON.stringify(card)
  assert.match(serialized, /模式/)
  assert.match(serialized, /P · M/)
  assert.match(serialized, /Thinking/)
  assert.match(serialized, /High/)
  assert.match(serialized, /权限/)
  assert.match(serialized, /Safe/)
  assert.match(serialized, /打开会话/)
  assert.match(serialized, /session_open/)
  assert.match(serialized, /archive_latest/)
  assert.match(serialized, /归档最近回答/)
  const form = card.body.elements.find((element) => element.tag === 'form')
  assert.ok(form)
  assert.deepEqual(form.elements.map((item) => item.name), ['permission', 'model', 'effort', 'config_submit'])
})

test('approval card shows the concrete command in a code block', () => {
  const card = buildApprovalCard({
    code: 'k3f9zq',
    toolName: 'bash',
    reason: '需要提升沙箱权限',
    approvalKey: 'a1',
    detail: { language: 'bash', text: 'rm -rf /tmp/demo && echo done' },
  })
  const serialized = JSON.stringify(card)
  assert.match(serialized, /将要执行的命令/)
  assert.match(serialized, /rm -rf \/tmp\/demo/)
  assert.match(serialized, /```bash/)
})

test('resolved approval card keeps command, reason and decision for audit', () => {
  const card = buildApprovalResolvedCard({
    code: 'k3f9zq',
    outcome: 'allowed-once',
    toolName: 'bash',
    reason: '需要提升沙箱权限',
    detail: { language: 'bash', text: 'rm -rf /tmp/demo' },
    source: 'lark',
    decidedAt: 1700000000000,
  })
  const serialized = JSON.stringify(card)
  assert.match(serialized, /已允许/)
  assert.match(serialized, /rm -rf \/tmp\/demo/)
  assert.match(serialized, /需要提升沙箱权限/)
  assert.match(serialized, /处理来源：飞书/)
  assert.match(serialized, /处理时间/)
})

test('archive status and delete preview expose the configured parent and confirmation actions', () => {
  const status = buildArchiveStatusCard({
    configured: true,
    parentUrl: 'https://example.feishu.cn/wiki/archive',
    parentTitle: '回答归档',
  })
  const statusText = JSON.stringify(status)
  assert.match(statusText, /回答归档/)
  assert.match(statusText, /open_url/)
  assert.match(statusText, /archive_form/)
  assert.match(statusText, /archive_url/)
  assert.match(statusText, /\/wiki\/archive/)

  const preview = buildArchiveDeletePreviewCard({
    cutoff: '2026-11-01',
    count: 2,
    dates: ['2026-10-30', '2026-10-31'],
    key: 'delete-key',
  })
  const previewText = JSON.stringify(preview)
  assert.match(previewText, /确认删除归档回答/)
  assert.match(previewText, /archive_delete_confirm/)
  assert.match(previewText, /archive_delete_cancel/)
  assert.match(previewText, /2026-10-30/)
})

test('long end card offers archive action with the turn marker', () => {
  const card = buildEndCard({
    code: 'abcxyz',
    title: '会话',
    summary: '很长的回答',
    reasonText: '已完成',
    failed: false,
    durationText: '1 秒',
    toolCalls: 0,
    usage: { inputTokens: 1, outputTokens: 2 },
    sessionId: 's1',
    turn: 3,
    archiveable: true,
  })
  const serialized = JSON.stringify(card)
  assert.match(serialized, /archive_answer/)
  assert.match(serialized, /"turn":3/)
})

test('archive result card opens the created document', () => {
  const card = buildArchiveResultCard({
    url: 'https://example.feishu.cn/docx/child',
    parentUrl: 'https://example.feishu.cn/wiki/archive',
    parentTitle: '回答归档',
  })
  assert.match(JSON.stringify(card), /回答已归档/)
  assert.match(JSON.stringify(card), /open_url/)
})
