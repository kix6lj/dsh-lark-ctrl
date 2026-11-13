import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createRouter } from '../lib/router.js'
import { normalizeConfig } from '../lib/config.js'

/**
 * The event bridge stores `card:<event_id>` before invoking the handler. The
 * router must not deduplicate the same key again, or every callback is dropped.
 */
function harness() {
  const calls = []
  const cards = []
  const texts = []
  const prompts = []
  let link = { sessionId: 's1', kind: 'question', callId: 'c1' }
  let pushLevel = 2
  const workspace = {
    id: 'w1',
    title: '工作区',
    path: '/tmp/work',
    sessionIds: ['s1'],
    status: async () => 'ok',
  }
  let archivedSessionIds = []
  const workspaceRegistry = {
    list: () => [workspace],
    get: () => workspace,
    get archivedSessionIds() { return archivedSessionIds },
    resolveByPath: async () => undefined,
    create: async () => workspace,
  }
  const configCalls = []
  const permissionPresets = {
    catalog: () => ({
      options: [{ value: 'safe', name: 'Safe', description: 'read only' }],
      defaultPreset: 'safe',
    }),
    current: () => 'safe',
    set: (session, name) => configCalls.push(['permission', session.id, name]),
  }
  const btwCalls = []
  const transport = {
    isAllowed: () => true,
    sendCard: async (card) => { cards.push(card); return { messageId: 'om_out' } },
    patchCard: async (messageId, card) => { cards.push(card) },
    sendText: async (text) => { texts.push(text); return { messageId: 'om_text' } },
    react: async () => true,
  }
  const registry = {
    lookup: () => link,
    ensureCode: () => 'abcxyz',
    lastSession: () => 's1',
    resolveCode: async () => 's1',
    listSessions: async () => [
      { sessionId: 's1', title: '一天内的会话', running: false, updatedAt: Date.now() },
      { sessionId: 's2', title: '两天前的会话', running: false, updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 },
    ],
    describe: async () => ({ title: 't', updatedAt: 1000 }),
    rememberLast: () => {},
    link: () => {},
  }
  const answerer = {
    promoteSuppressed: async () => 0,
    answerFromChoice: async (...args) => {
      calls.push(['choice', ...args])
      return { ok: true }
    },
    answerFromForm: async (...args) => {
      calls.push(['form', ...args])
      return { ok: true }
    },
    answerFromText: async () => ({ ok: false, handled: false }),
    answerApproval: async () => ({ ok: true }),
  }
  const router = createRouter({
    ctx: {
      get: (name) => {
        if (name === 'workspaceRegistry') return workspaceRegistry
        if (name === 'permissionPresets') return permissionPresets
        return undefined
      },
      sessions: { get: () => ({ id: 's1' }) },
      sessionProjections: {
        snapshot: () => ({
          values: {
            modelSelection: { next: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
            permissions: { currentValue: 'safe' },
            agentPreset: 'standard',
          },
        }),
      },
      sessionController: {
        prompt: async (request) => { prompts.push(request); return { accepted: true } },
        cancel: () => {},
        modelCatalog: async () => ({
          default: { provider: 'p', model: 'm', reasoningEffort: 'high' },
          groups: [{
            id: 'p',
            name: 'Provider',
            models: [{
              id: 'm',
              name: 'Model',
              reasoning: { efforts: [{ id: 'high', name: 'High' }] },
            }],
          }],
        }),
        selectModel: async (request) => { configCalls.push(['model', request]) },
        list: async () => ({
          items: [{
            sessionId: 's1',
            updatedAt: Date.now(),
            running: true,
            projections: { values: { title: '会话' } },
          }],
        }),
      },
    },
    config: normalizeConfig({}),
    registry,
    transport,
    answerer,
    archive: {
      status: async () => ({
        configured: true,
        parentUrl: 'https://example.feishu.cn/wiki/archive',
        parentTitle: '回答归档',
        error: undefined,
        source: 'lark',
      }),
      setParentUrl: async (url) => ({
        url,
        title: '回答归档',
        nodeToken: 'node',
      }),
      clearParentUrl: () => {},
      configured: () => true,
      planDelete: async () => ({
        count: 2,
        dates: ['2026-10-30', '2026-10-31'],
        entries: [],
      }),
      deleteBefore: async () => ({ cutoff: '2026-11-01', deleted: 2, failed: [], total: 2 }),
      archiveAnswer: async () => ({
        url: 'https://example.feishu.cn/docx/child',
        parentUrl: 'https://example.feishu.cn/wiki/archive',
        parentTitle: '回答归档',
        indexed: true,
        alreadyArchived: true,
      }),
      validateCutoff: (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : undefined),
    },
    btw: {
      snapshot: async () => ({
        code: 'abcxyz',
        title: 't',
        running: false,
        cwd: '/tmp',
        model: 'm',
        pending: 0,
        queued: 0,
      }),
      ask: async (sessionId, question) => {
        btwCalls.push([sessionId, question])
        return { ok: true, answer: '旁问回答' }
      },
    },
    store: {
      rememberEvent: () => false,
      pushLevel: () => pushLevel,
      setPushLevel: (level) => { pushLevel = level },
      linkMessage: () => {},
    },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  })
  return {
    router,
    calls,
    cards,
    texts,
    prompts,
    btwCalls,
    configCalls,
    setLink(next) { link = next },
    setArchived(next) { archivedSessionIds = next },
  }
}

test('a card callback is not dropped by duplicate bridge dedupe', async () => {
  const { router, calls } = harness()
  await router.handleCardAction({
    event_id: 'e1',
    action_tag: 'button',
    action_value: JSON.stringify({ op: 'answer', qid: 'q1', label: '继续' }),
    message_id: 'om_card',
    operator_id: 'ou_me',
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'choice')
  assert.equal(calls[0][2].label, '继续')
})

test('a form submit goes to the form answerer', async () => {
  const { router, calls } = harness()
  await router.handleCardAction({
    event_id: 'e2',
    action_tag: 'button',
    form_value: JSON.stringify({ c0: '自定义' }),
    message_id: 'om_card',
    operator_id: 'ou_me',
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'form')
})

test('dropdown interaction events are ignored until submit', async () => {
  const { router, calls } = harness()
  await router.handleCardAction({
    event_id: 'e3',
    action_tag: 'select_static',
    option: '继续',
    message_id: 'om_card',
    operator_id: 'ou_me',
  })
  assert.equal(calls.length, 0)
})


test('sessions open button sends a session detail card', async () => {
  const { router, cards } = harness()
  await router.handleCardAction({
    event_id: 'e4',
    action_tag: 'button',
    action_value: JSON.stringify({ op: 'session_open', sessionId: 's1' }),
    message_id: 'om_list',
    operator_id: 'ou_me',
  })
  assert.equal(cards.length, 1)
  assert.match(JSON.stringify(cards[0]), /#abcxyz/)
})

test('sessions copy button sends the hash as a standalone message', async () => {
  const { router, texts } = harness()
  await router.handleCardAction({
    event_id: 'e5',
    action_tag: 'button',
    action_value: JSON.stringify({ op: 'session_copy', sessionId: 's1' }),
    message_id: 'om_list',
    operator_id: 'ou_me',
  })
  assert.equal(texts.length, 1)
  assert.match(texts[0], /#abcxyz/)
})

test('session detail form sends a prompt without a hash', async () => {
  const { router, prompts, setLink } = harness()
  setLink({ sessionId: 's1', kind: 'session' })
  await router.handleCardAction({
    event_id: 'e6',
    action_tag: 'button',
    form_value: JSON.stringify({ prompt: '继续实现登录页' }),
    message_id: 'om_detail',
    operator_id: 'ou_me',
  })
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 's1')
  assert.equal(prompts[0].content[0].text, '继续实现登录页')
})


test('/sessions 1d filters by update time and renders open buttons', async () => {
  const { router, cards } = harness()
  await router.handleMessage({
    sender_type: 'user',
    sender_id: 'ou_me',
    chat_id: 'oc',
    chat_type: 'p2p',
    message_id: 'om_cmd',
    message_type: 'text',
    content: '/sessions 1d',
  })
  const sessionsCard = cards.find((card) => card.header?.title?.content === '最近会话')
  assert.ok(sessionsCard)
  assert.match(JSON.stringify(sessionsCard), /1 个/)
  const serialized = JSON.stringify(sessionsCard)
  assert.match(serialized, /session_open/)
})


test('/level changes the persisted level and sends a level card', async () => {
  const { router, cards } = harness()
  await router.handleMessage({
    sender_type: 'user',
    sender_id: 'ou_me',
    chat_id: 'oc',
    chat_type: 'p2p',
    message_id: 'om_level',
    message_type: 'text',
    content: '/level 1',
  })
  const levelCard = cards.find((card) => card.header?.title?.content === '推送级别')
  assert.ok(levelCard)
  assert.match(JSON.stringify(levelCard), /当前 L1/)
})

test('/workspaces renders workspace groups and creation actions', async () => {
  const { router, cards } = harness()
  await router.handleMessage({
    sender_type: 'user',
    sender_id: 'ou_me',
    chat_id: 'oc',
    chat_type: 'p2p',
    message_id: 'om_ws',
    message_type: 'text',
    content: '/workspaces 1d',
  })
  const workspaceCard = cards.find((card) => card.header?.title?.content === '最近工作区')
  assert.ok(workspaceCard)
  assert.match(JSON.stringify(workspaceCard), /workspace_new_session/)
  assert.match(JSON.stringify(workspaceCard), /#abcxyz/)
})


test('session detail form 旁问 submits the prompt to btw instead of the session', async () => {
  const { router, prompts, btwCalls, setLink } = harness()
  setLink({ sessionId: 's1', kind: 'session' })
  await router.handleCardAction({
    event_id: 'e_btw',
    action_tag: 'button',
    action_name: 'session_btw',
    form_value: JSON.stringify({ prompt: '现在在做什么？' }),
    message_id: 'om_detail',
    operator_id: 'ou_me',
  })
  assert.equal(prompts.length, 0)
  assert.deepEqual(btwCalls, [['s1', '现在在做什么？']])
})


test('/sessions hides archived sessions', async () => {
  const { router, cards, setArchived } = harness()
  setArchived(['s1'])
  await router.handleMessage({
    sender_type: 'user',
    sender_id: 'ou_me',
    chat_id: 'oc',
    chat_type: 'p2p',
    message_id: 'om_archived',
    message_type: 'text',
    content: '/sessions 1d',
  })
  const sessionsCard = cards.find((card) => card.header?.title?.content === '最近会话')
  assert.ok(sessionsCard)
  assert.match(JSON.stringify(sessionsCard), /0 个/)
  assert.doesNotMatch(JSON.stringify(sessionsCard), /#abcxyz/)
})

test('/help /sessions sends the detailed command card', async () => {
  const { router, cards } = harness()
  await router.handleMessage({
    sender_type: 'user',
    sender_id: 'ou_me',
    chat_id: 'oc',
    chat_type: 'p2p',
    message_id: 'om_help_sessions',
    message_type: 'text',
    content: '/help /sessions',
  })
  const helpCard = cards.find((card) => card.header?.title?.content === '帮助 · /sessions')
  assert.ok(helpCard)
  assert.match(JSON.stringify(helpCard), /已归档/)
})

test('/help with an unknown topic reports it without sending a detail card', async () => {
  const { router, cards, texts } = harness()
  await router.handleMessage({
    sender_type: 'user',
    sender_id: 'ou_me',
    chat_id: 'oc',
    chat_type: 'p2p',
    message_id: 'om_help_unknown',
    message_type: 'text',
    content: '/help /nope',
  })
  assert.equal(cards.length, 0)
  assert.match(texts[0], /没有找到/)
})

test('help related-topic buttons open another detail card', async () => {
  const { router, cards } = harness()
  await router.handleCardAction({
    event_id: 'e_help_topic',
    action_tag: 'button',
    action_value: JSON.stringify({ op: 'help_topic', command: '/workspaces' }),
    message_id: 'om_help',
    operator_id: 'ou_me',
  })
  assert.ok(cards.some((card) => card.header?.title?.content === '帮助 · /workspaces'))
})


test('/status displays current configuration and applies the status form', async () => {
  const { router, cards, configCalls, setLink } = harness()
  await router.handleMessage({
    sender_type: 'user',
    sender_id: 'ou_me',
    chat_id: 'oc',
    chat_type: 'p2p',
    message_id: 'om_status_cmd',
    message_type: 'text',
    content: '/status',
  })
  const statusCard = cards.find((card) => card.header?.title?.content === '会话状态 · #abcxyz')
  assert.ok(statusCard)
  const serialized = JSON.stringify(statusCard)
  assert.match(serialized, /Provider · Model/)
  assert.match(serialized, /High/)
  assert.match(serialized, /Safe/)
  assert.match(serialized, /session_config_form/)
  assert.match(serialized, /archive_latest/)

  setLink({ sessionId: 's1', kind: 'status' })
  await router.handleCardAction({
    event_id: 'e_status_form',
    action_tag: 'button',
    action_name: 'config_submit',
    form_value: JSON.stringify({ permission: 'safe', model: 'p::m', effort: 'high' }),
    message_id: 'om_status',
    operator_id: 'ou_me',
  })
  assert.ok(configCalls.some((call) => call[0] === 'permission'))
  assert.ok(configCalls.some((call) => call[0] === 'model' && call[1].reasoningEffort === 'high'))
  assert.ok(cards.some((card) => card.header?.title?.content === '会话状态 · #abcxyz'))
})


test('/archive shows the configured archive and delete preview', async () => {
  const { router, cards } = harness()
  await router.handleMessage({
    sender_type: 'user',
    sender_id: 'ou_me',
    chat_id: 'oc',
    chat_type: 'p2p',
    message_id: 'om_archive',
    message_type: 'text',
    content: '/archive',
  })
  assert.ok(cards.some((card) => card.header?.title?.content === '回答归档'))

  await router.handleMessage({
    sender_type: 'user',
    sender_id: 'ou_me',
    chat_id: 'oc',
    chat_type: 'p2p',
    message_id: 'om_archive_delete',
    message_type: 'text',
    content: '/archive delete-before 2026-11-01',
  })
  const preview = cards.find((card) => card.header?.title?.content === '确认删除归档回答')
  assert.ok(preview)
  assert.match(JSON.stringify(preview), /archive_delete_confirm/)
})


test('/archive set saves the parent URL and /archive clear is available', async () => {
  const { router, texts } = harness()
  await router.handleMessage({
    sender_type: 'user',
    sender_id: 'ou_me',
    chat_id: 'oc',
    chat_type: 'p2p',
    message_id: 'om_archive_set',
    message_type: 'text',
    content: '/archive set https://example.feishu.cn/wiki/archive',
  })
  assert.ok(texts.some((text) => /归档父文档已保存/.test(text)))

  await router.handleMessage({
    sender_type: 'user',
    sender_id: 'ou_me',
    chat_id: 'oc',
    chat_type: 'p2p',
    message_id: 'om_archive_clear',
    message_type: 'text',
    content: '/archive clear',
  })
  assert.ok(texts.some((text) => /清除/.test(text)) === false)
})

test('status archive-latest action returns the existing archive link', async () => {
  const { router, cards } = harness()
  await router.handleCardAction({
    event_id: 'e_archive_latest',
    action_tag: 'button',
    action_value: JSON.stringify({ op: 'archive_latest', sessionId: 's1' }),
    message_id: 'om_status',
    operator_id: 'ou_me',
  })
  const result = cards.find((card) => card.header?.title?.content === '回答已归档过')
  assert.ok(result)
  assert.match(JSON.stringify(result), /example\.feishu\.cn\/docx\/child/)
})
