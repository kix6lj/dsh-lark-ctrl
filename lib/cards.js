/**
 * Card 2.0 builders and answer parsing.
 *
 * Every card is a plain JSON object; the transport layer serializes it for
 * `lark-cli im +messages-send --msg-type interactive`. Keeping this module
 * free of Host services makes the card shapes unit-testable.
 */

import { helpTopics } from './help.js'
import { formatTokens, formatTime, hasImages, stripImages, truncate } from './util.js'

const MAX_CARD_BYTES = 28000
const MAX_CUSTOM = 1000

/* ------------------------------------------------------------------------- */
/* Primitives                                                                */
/* ------------------------------------------------------------------------- */

/** @param {string} content */
export function markdown(content) {
  return { tag: 'markdown', content }
}

/** @param {string} content */
export function plain(content) {
  return { tag: 'div', text: { tag: 'plain_text', content } }
}

/** @param {string} content */
export function note(content) {
  return { tag: 'div', text: { tag: 'plain_text', content, text_size: 'notation', text_color: 'grey' } }
}

/**
 * Fence arbitrary tool text without letting embedded backticks close the
 * block. CommonMark allows a longer fence than the longest run inside.
 * @param {string} language
 * @param {string} content
 */
function fencedCode(language, content) {
  const value = String(content ?? '')
  const runs = value.match(/`+/g) ?? []
  const fenceLength = Math.max(3, ...runs.map((run) => run.length + 1))
  const fence = '`'.repeat(fenceLength)
  const tag = String(language ?? '').replace(/[^a-z0-9+#.-]/gi, '')
  return `${fence}${tag}\n${value}\n${fence}`
}

/** @param {string[]} lines */
export function lines(...lines) {
  return markdown(lines.filter(Boolean).join('\n'))
}

export function hr() {
  return { tag: 'hr' }
}

/**
 * @param {object} input
 * @param {string} input.text
 * @param {string} [input.type]
 * @param {Record<string, unknown>} [input.value]
 * @param {Record<string, unknown>} [input.behaviors]
 * @param {string} [input.width]
 * @param {boolean} [input.disabled]
 */
export function button(input) {
  const result = {
    tag: 'button',
    text: { tag: 'plain_text', content: truncate(input.text, 100) },
    type: input.type ?? 'default',
    ...(input.width ? { width: input.width } : {}),
    ...(input.disabled === true ? { disabled: true } : {}),
    ...(input.value ? { behaviors: [{ type: 'callback', value: input.value }] } : {}),
  }
  return result
}

/**
 * @param {Array<{ width?: string, weight?: number, elements: Array<Record<string, unknown>> }>} columns
 */
export function columns(columns) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: columns.map((column) => ({
      tag: 'column',
      width: column.width ?? 'weighted',
      ...(column.width === 'weighted' || column.width === undefined ? { weight: column.weight ?? 1 } : {}),
      elements: column.elements,
    })),
  }
}

/**
 * @param {object} input
 * @param {string} input.title
 * @param {string} [input.subtitle]
 * @param {string} [input.template]
 * @param {Array<{ text: string, color?: string }>} [input.tags]
 * @param {Record<string, unknown>} [input.icon]
 */
export function header(input) {
  return {
    title: { tag: 'plain_text', content: truncate(input.title, 120) },
    ...(input.subtitle ? { subtitle: { tag: 'plain_text', content: truncate(input.subtitle, 120) } } : {}),
    template: input.template ?? 'blue',
    ...(input.tags
      ? {
          text_tag_list: input.tags.map((tag) => ({
            tag: 'text_tag',
            text: { tag: 'plain_text', content: truncate(tag.text, 20) },
            color: tag.color ?? 'blue',
          })),
        }
      : {}),
    ...(input.icon ? { icon: input.icon } : {}),
  }
}

/**
 * @param {Record<string, unknown>} headerValue
 * @param {Array<Record<string, unknown>>} elements
 */
export function card(headerValue, elements) {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: truncate(headerValue?.title?.content ?? 'DSH', 60) },
    },
    header: headerValue,
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      elements,
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Notification cards                                                        */
/* ------------------------------------------------------------------------- */

/**
 * @param {object} input
 * @param {string} input.code
 * @param {string} input.title
 * @param {string} input.prompt
 * @param {string} [input.cwd]
 * @param {string} [input.model]
 * @param {string} [input.sessionId]
 */
export function buildStartCard(input) {
  const title = input.title || '新会话'
  const meta = []
  if (input.cwd) meta.push(input.workspace || `📁 ${input.cwd}`)
  if (input.model) meta.push(`🧠 ${input.model}`)
  if (input.code) meta.push(`#${input.code}`)

  return card(
    header({
      title: `会话开始 · ${truncate(title, 46)}`,
      subtitle: '',
      template: 'blue',
      tags: [{ text: '运行中', color: 'blue' }],
    }),
    [
      input.prompt
        ? markdown(`**本次输入**\n> ${truncate(stripImages(input.prompt), 500).split('\n').join('\n> ')}`)
        : markdown('_（本轮没有新的用户输入，可能是 goal 续跑）_'),
      ...(meta.length > 0 ? [note(meta.join('   '))] : []),
      columns([
        {
          elements: [
            button({
              text: '查看状态',
              type: 'default',
              value: { op: 'status', sessionId: input.sessionId ?? '' },
            }),
          ],
        },
        {
          elements: [
            button({
              text: '停止',
              type: 'danger',
              value: { op: 'cancel', sessionId: input.sessionId ?? '' },
            }),
          ],
        },
      ]),
      note(`回复本条消息即可继续对话；或发送 #${input.code} <内容>`),
    ],
  )
}

/**
 * @param {object} input
 * @param {string} input.code
 * @param {string} input.title
 * @param {string} input.summary
 * @param {string} input.userText
 * @param {string} input.reasonText
 * @param {boolean} input.failed
 * @param {string} [input.errorMessage]
 * @param {string} input.durationText
 * @param {number} input.toolCalls
 * @param {{ inputTokens: number, outputTokens: number }} input.usage
 * @param {string} [input.model]
 * @param {string} [input.sessionId]
 * @param {number} [input.turn]
 * @param {boolean} [input.archiveable]
 * @param {string[]} [input.toolNames]
 */
export function buildEndCard(input) {
  const title = input.title || '会话'
  const summaryHadImages = input.imagesOmitted === true || hasImages(input.summary)
  const summaryText = stripImages(input.summary)
  // Long answers: keep a short preview and fold the rest behind a panel.
  const fullText = typeof input.summaryFull === 'string' ? stripImages(input.summaryFull) : ''
  const hasFull = fullText !== '' && fullText.length > summaryText.length
  const previewText = hasFull ? truncate(summaryText, 320) : summaryText
  const userText = stripImages(input.userText)
  const template = input.tone || (input.failed ? 'red' : 'green')
  const meta = [
    `⏱ ${input.durationText}`,
    `🛠 ${input.toolCalls} 次`,
    `⬆️ ${formatTokens(input.usage.inputTokens)} / ⬇️ ${formatTokens(input.usage.outputTokens)}`,
  ]
  if (input.code) meta.push(`#${input.code}`)
  const tools = Array.isArray(input.toolNames) && input.toolNames.length > 0
    ? `工具：${input.toolNames.slice(0, 8).join('、')}${input.toolNames.length > 8 ? '…' : ''}`
    : ''

  return card(
    header({
      title: `${input.reasonText} · ${truncate(title, 46)}`,
      subtitle: '',
      template,
      tags: [{ text: input.reasonText, color: input.failed ? 'red' : 'green' }],
    }),
    [
      ...(input.workspace ? [note(input.workspace)] : []),
      input.errorMessage
        ? markdown(`**错误**\n\`\`\`\n${truncate(input.errorMessage, 800)}\n\`\`\``)
        : previewText !== ''
          ? markdown(previewText)
          : markdown('_（本轮没有可展示的回复）_'),
      ...(hasFull ? [{
        tag: 'collapsible_panel',
        expanded: false,
        header: {
          title: {
            tag: 'markdown',
            content: `**💬 展开完整回复（${fullText.length} 字）** 点击展开…`,
          },
          vertical_align: 'center',
          icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
          icon_position: 'right',
          icon_expanded_angle: -180,
        },
        border: { color: 'blue', corner_radius: '6px' },
        vertical_spacing: '8px',
        padding: '8px 8px 8px 8px',
        elements: [markdown(fullText)],
      }] : []),
      ...(hasFull && input.fullTruncated === true
        ? [note('完整回复超过卡片上限，更长的内容请在 Web 会话查看。')]
        : []),
      ...(summaryHadImages ? [note(summaryImageNote(input.imagesOmitted, input.imageCount))] : []),
      ...(userText !== '' ? [note(`本轮输入：${truncate(userText, 200)}`)] : []),
      note(meta.join('   ')),
      ...(tools ? [note(tools)] : []),
      ...(input.archiveable === true
        ? [button({
            text: '归档完整回答到飞书文档',
            type: 'primary',
            width: 'fill',
            value: {
              op: 'archive_answer',
              sessionId: input.sessionId ?? '',
              turn: input.turn,
            },
          })]
        : []),
      { tag: 'form', name: 'continue_form', elements: [
        {
          tag: 'input',
          name: 'prompt',
          placeholder: { tag: 'plain_text', content: '继续对话…（输入后提交）' },
          input_type: 'multiline_text',
          rows: 2,
          auto_resize: true,
          max_length: 1000,
        },
        {
          tag: 'button',
          name: 'continue_submit',
          text: { tag: 'plain_text', content: '发送' },
          type: 'primary_filled',
          width: 'fill',
          form_action_type: 'submit',
        },
      ] },
      // Two rows of equal-width buttons: navigation first, then extras.
      columns([
        {
          elements: [
            button({ text: '最近会话', type: 'default', width: 'fill', value: { op: 'sessions' } }),
          ],
        },
        {
          elements: [
            button({ text: '更多命令', type: 'default', width: 'fill', value: { op: 'help_index' } }),
          ],
        },
      ]),
      columns([
        {
          elements: [
            button({ text: '查看状态 · 历史消息', type: 'default', width: 'fill', value: { op: 'status', sessionId: input.sessionId ?? '' } }),
          ],
        },
        {
          elements: [
            button({ text: '旁问', type: 'default', width: 'fill', value: { op: 'btw_prompt', sessionId: input.sessionId ?? '' } }),
          ],
        },
      ]),
      note(`也可以发送 #${input.code} <内容>，或 /btw #${input.code} 你的问题`),
    ],
  )
}

/* ------------------------------------------------------------------------- */
/* Question cards                                                            */
/* ------------------------------------------------------------------------- */

/**
 * @param {object} input
 * @param {string} input.code
 * @param {string} [input.title]
 * @param {Array<Record<string, any>>} input.questions
 * @param {string} [input.statusNote]
 */
export function buildQuestionCard(input) {
  const questions = Array.isArray(input.questions) ? input.questions : []
  const plan = questions.find((question) => question?.intent?.kind === 'plan-review')
  const elements = []

  if (plan?.detail) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'plain_text', content: '查看计划正文' },
        icon_position: 'left',
      },
      elements: [markdown(truncate(stripImages(plan.detail), 6000))],
    })
  }

  // A single single-select question is the common "needs a decision" shape.
  // Render its options as one-tap buttons so a phone user does not have to
  // operate a dropdown *and* remember to press submit.
  const only = questions[0]
  const simple = questions.length === 1
    && only !== undefined
    && Array.isArray(only.options)
    && only.options.length > 0
    && only.options.length <= 5
    && only.multiSelect !== true

  const replyHint = questions.length === 1
    ? `也可直接回复本条消息：${(questions[0]?.options ?? []).slice(0, 6).map((option, index) => `${index + 1}=${truncate(String(option.label), 30)}`).join('  ')}${(questions[0]?.options ?? []).length > 0 ? '，其他内容按自定义回答处理' : ''}`
    : '也可直接回复本条消息；多个问题时请使用卡片提交'

  if (simple) {
    const options = only.options
    elements.push(markdown(questionBodyText(only)))
    elements.push(markdown(optionListText(options)))
    for (let index = 0; index < options.length; index += 1) {
      const label = String(options[index].label)
      elements.push(button({
        text: truncate(label, 100),
        type: index === 0 ? 'primary_filled' : 'default',
        width: 'fill',
        value: { op: 'answer', qid: String(only.id), label },
      }))
    }
    elements.push({
      tag: 'form',
      name: 'custom_form',
      elements: [
        {
          tag: 'input',
          name: 'c0',
          placeholder: { tag: 'plain_text', content: '都不合适？输入自定义回答后提交' },
          max_length: MAX_CUSTOM,
          input_type: 'multiline_text',
          rows: 2,
        },
        {
          tag: 'button',
          name: 'custom_submit',
          text: { tag: 'plain_text', content: '提交自定义回答' },
          type: 'default',
          width: 'fill',
          form_action_type: 'submit',
        },
      ],
    })
    elements.push(...(input.statusNote ? [note(input.statusNote)] : []), note(replyHint))
    return card(
      header({
        title: `需要你的确认 · #${input.code}`,
        subtitle: input.title ? truncate(input.title, 100) : 'DeepSeek Harness 正在等待你的回答',
        template: 'orange',
        tags: [{ text: '待回答', color: 'orange' }],
      }),
      elements,
    )
  }

  const formElements = []
  questions.forEach((question, index) => {
    formElements.push(markdown(questionBodyText(question)))
    const options = Array.isArray(question.options) ? question.options : []
    if (options.length > 0) {
      formElements.push(markdown(optionListText(options)))
      if (question.multiSelect === true) {
        formElements.push({
          tag: 'multi_select_static',
          name: `q${index}`,
          placeholder: { tag: 'plain_text', content: '可多选' },
          options: options.map((option) => ({
            text: { tag: 'plain_text', content: truncate(String(option.label), 100) },
            value: String(option.label),
          })),
          width: 'fill',
        })
      } else {
        formElements.push({
          tag: 'select_static',
          name: `q${index}`,
          placeholder: { tag: 'plain_text', content: '请选择' },
          options: options.map((option) => ({
            text: { tag: 'plain_text', content: truncate(String(option.label), 100) },
            value: String(option.label),
          })),
          width: 'fill',
        })
      }
    }
    formElements.push({
      tag: 'input',
      name: `c${index}`,
      placeholder: {
        tag: 'plain_text',
        content: options.length > 0 ? '其他（可选，填写后覆盖上面的选择）' : '请输入你的回答',
      },
      max_length: MAX_CUSTOM,
      ...(options.length === 0 ? { input_type: 'multiline_text', rows: 2 } : {}),
    })
  })

  formElements.push({
    tag: 'button',
    name: 'answer_submit',
    text: { tag: 'plain_text', content: '提交回答' },
    type: 'primary_filled',
    width: 'fill',
    form_action_type: 'submit',
  })
  elements.push({ tag: 'form', name: 'answer_form', elements: formElements })

  return card(
    header({
      title: `需要你的确认 · #${input.code}`,
      subtitle: input.title ? truncate(input.title, 100) : 'DeepSeek Harness 正在等待你的回答',
      template: 'orange',
      tags: [{ text: '待回答', color: 'orange' }],
    }),
    [...elements, ...(input.statusNote ? [note(input.statusNote)] : []), note(replyHint)],
  )
}

/** @param {Record<string, any>} question */
function questionBodyText(question) {
  const headerText = question.header ? `**${escapeInline(String(question.header))}**` : ''
  const body = headerText
    ? `${headerText}\n${escapeInline(String(question.question ?? ''))}`
    : escapeInline(String(question.question ?? ''))
  const detail = question.detail && question.intent?.kind !== 'plan-review'
    ? `\n${truncate(String(question.detail), 800)}`
    : ''
  return `${body}${detail}`
}

/** @param {Array<Record<string, any>>} options */
function optionListText(options) {
  return options.map((option, index) => {
    const description = option.description ? ` — ${truncate(String(option.description), 160)}` : ''
    return `${index + 1}. **${escapeInline(String(option.label))}**${description}`
  }).join('\n')
}

/**
 * @param {object} input
 * @param {string} input.code
 * @param {Array<Record<string, any>>} input.questions
 * @param {Array<Record<string, any>>} input.answers
 * @param {string} input.source
 * @param {string} [input.title]
 */
export function buildAnsweredCard(input) {
  const lines = input.answers.map((answer) => {
    const selected = Array.isArray(answer.selected) && answer.selected.length > 0
      ? answer.selected.map((item) => `\`${item}\``).join('、')
      : ''
    const custom = typeof answer.custom === 'string' && answer.custom !== '' ? `自定义：${truncate(stripImages(answer.custom), 300)}` : ''
    const question = input.questions.find((item) => item.id === answer.id)
    const label = question?.header || question?.question || answer.id
    const value = [selected, custom].filter(Boolean).join(' · ') || '（跳过）'
    return `- **${escapeInline(String(label))}**：${value}`
  })

  return card(
    header({
      title: `已回答 · #${input.code}`,
      subtitle: input.title ? truncate(input.title, 100) : '问题已答复',
      template: 'green',
      tags: [{ text: '已完成', color: 'green' }],
    }),
    [
      markdown(lines.join('\n')),
      note(input.source === 'web' ? '已在 DSH Web 端回答；飞书这张卡片无需再操作。' : '回答已发送给 DSH。'),
    ],
  )
}

/**
 * @param {object} input
 * @param {string} input.code
 * @param {string} [input.title]
 * @param {string} input.reason
 */
export function buildExpiredQuestionCard(input) {
  return card(
    header({
      title: `提问已失效 · #${input.code}`,
      subtitle: input.title ? truncate(input.title, 100) : '',
      template: 'grey',
    }),
    [markdown(stripImages(input.reason)), note('可以在 DSH Web 会话中继续处理。')],
  )
}

/* ------------------------------------------------------------------------- */
/* Approval cards                                                            */
/* ------------------------------------------------------------------------- */

/**
 * @param {object} input
 * @param {string} input.code
 * @param {string} [input.title]
 * @param {string} input.toolName
 * @param {string} [input.reason]
 * @param {string} input.approvalKey
 */
export function buildApprovalCard(input) {
  const reason = input.reason && stripImages(input.reason).trim() !== ''
    ? stripImages(input.reason).trim()
    : '该工具调用需要你的授权。'
  const detail = input.detail
  const detailText = typeof detail?.text === 'string' ? truncate(detail.text, 3000) : ''
  const command = detail?.language === 'bash'
  return card(
    header({
      title: `需要授权 · #${input.code}`,
      subtitle: input.title ? truncate(input.title, 100) : 'DeepSeek Harness 正在等待你的决定',
      template: 'red',
      tags: [{ text: '待授权', color: 'red' }],
    }),
    [
      markdown(`**工具**：\`${escapeInline(input.toolName || 'unknown')}\``),
      markdown(`**原因**\n> ${truncate(reason, 900).split('\n').join('\n> ')}`),
      detailText !== ''
        ? markdown(`**${command ? '将要执行的命令' : '工具参数'}**\n${fencedCode(detail.language, detailText)}`)
        : markdown('_未能从会话日志中读取具体参数；请结合工具和原因判断，或到 Web 端查看完整工具调用。_'),
      columns([
        {
          elements: [
            button({
              text: '允许一次',
              type: 'primary_filled',
              value: { op: 'approval', key: input.approvalKey, decision: 'allow' },
            }),
          ],
        },
        {
          elements: [
            button({
              text: '拒绝',
              type: 'danger',
              value: { op: 'approval', key: input.approvalKey, decision: 'reject' },
            }),
          ],
        },
      ]),
      note('也可直接回复本条消息：1=允许，2=拒绝'),
    ],
  )
}

/**
 * @param {object} input
 * @param {string} input.code
 * @param {string} input.outcome
 * @param {string} [input.toolName]
 */
export function buildApprovalResolvedCard(input) {
  const allowed = input.outcome === 'allowed-once'
  const expired = input.outcome === 'expired' || input.outcome === 'cancelled'
  const title = allowed ? '已允许' : expired ? '审批已结束' : '已拒绝'
  const reason = typeof input.reason === 'string' ? stripImages(input.reason).trim() : ''
  const detailText = typeof input.detail?.text === 'string' ? truncate(input.detail.text, 3000) : ''
  const source = input.source === 'lark' ? '飞书' : input.source === 'web' ? 'Web' : ''
  const noteParts = [
    source ? `处理来源：${source}` : '',
    input.decidedAt ? `处理时间：${formatTime(input.decidedAt)}` : '',
  ].filter(Boolean)
  return card(
    header({
      title: `${title} · #${input.code}`,
      subtitle: input.toolName ? truncate(input.toolName, 100) : '',
      template: allowed ? 'green' : 'grey',
      tags: [{ text: '已处理', color: allowed ? 'green' : 'grey' }],
    }),
    [
      markdown(`**工具**：\`${escapeInline(input.toolName || 'unknown')}\``),
      ...(reason !== '' ? [markdown(`**原因**\n> ${truncate(reason, 900).split('\n').join('\n> ')}`)] : []),
      ...(detailText !== ''
        ? [markdown(`**审批内容**\n${fencedCode(input.detail.language, detailText)}`)]
        : [markdown('_本次审批没有可读取的工具参数。_')]),
      markdown(`**结果**：${allowed
        ? '已允许本次工具调用。'
        : expired
          ? '审批请求已结束，未做出允许/拒绝决定。'
          : '已拒绝本次工具调用。'}`),
      ...(noteParts.length > 0 ? [note(noteParts.join(' · '))] : []),
    ],
  )
}

/* ------------------------------------------------------------------------- */
/* Status / list / help                                                      */
/* ------------------------------------------------------------------------- */

/**
 * @param {object} input
 * @param {string} input.code
 * @param {string} input.title
 * @param {boolean} input.running
 * @param {string} input.statusText
 * @param {string} [input.lastUser]
 * @param {string} [input.lastAssistant]
 * @param {string} [input.cwd]
 * @param {string} [input.model]
 * @param {string} [input.elapsed]
 * @param {number} [input.pending]
 * @param {number} [input.queued]
 * @param {string} [input.sessionId]
 * @param {string[]} [input.tools]
 * @param {boolean} [input.archiveAvailable]
 */
export function buildStatusCard(input) {
  const modelLabel = input.modelLabel || input.model || ''
  const modeLabel = input.modeLabel || input.agentPreset || ''
  const permissionLabel = input.permissionLabel || input.permission || ''
  const effortLabel = input.effortLabel || input.effort || ''
  const rows = [
    `**状态**：${input.statusText}`,
    input.elapsed ? `**已运行**：${input.elapsed}` : '',
    input.cwd ? `**目录**：\`${truncate(input.cwd, 160)}\`` : '',
    modeLabel ? `**模式**：\`${truncate(modeLabel, 80)}\`` : '',
    modelLabel ? `**模型**：\`${truncate(modelLabel, 120)}\`` : '',
    effortLabel ? `**Thinking**：\`${truncate(effortLabel, 60)}\`` : '',
    permissionLabel ? `**权限**：\`${truncate(permissionLabel, 80)}\`` : '',
    input.queued ? `**排队**：${input.queued} 条` : '',
    input.pending ? `**待处理交互**：${input.pending} 个` : '',
    input.tools && input.tools.length > 0 ? `**最近工具**：${input.tools.join('、')}` : '',
  ].filter(Boolean)

  const permissionOptions = Array.isArray(input.options?.permissions) ? input.options.permissions : []
  const modelOptions = Array.isArray(input.options?.models) ? input.options.models : []
  const effortOptions = Array.isArray(input.options?.efforts) ? [...input.options.efforts] : []
  if (input.effort && effortOptions.length > 0 && !effortOptions.some((option) => option.value === input.effort)) {
    effortOptions.push({ value: input.effort, text: input.effort })
  }
  const selects = []
  const select = (name, placeholder, options, initial) => ({
    tag: 'select_static',
    name,
    placeholder: { tag: 'plain_text', content: placeholder },
    options: options.map((option) => ({
      text: { tag: 'plain_text', content: truncate(option.text, 100) },
      value: option.value,
    })),
    ...(initial !== undefined && options.some((option) => option.value === initial) ? { initial_option: initial } : {}),
    width: 'fill',
  })
  if (permissionOptions.length > 0) {
    selects.push(select('permission', '权限（沙箱 + 审批）', permissionOptions, input.permission))
  }
  if (modelOptions.length > 0) {
    selects.push(select('model', '模型', modelOptions, input.modelValue))
  }
  if (modelOptions.length > 0 && effortOptions.length > 1) {
    selects.push(select('effort', 'Thinking effort', effortOptions, input.effort ?? ''))
  }

  const elements = [
    markdown(`**${escapeInline(input.title || '会话')}**`),
    markdown(rows.join('\n')),
    // Recent messages replace the old one-line 最近输入/最近回复 pair: folded by
    // default, with the full transcript one tap away below.
    button({
      text: '历史记录列表',
      type: 'default',
      width: 'fill',
      value: { op: 'history', sessionId: input.sessionId ?? '' },
    }),
  ]
  if (selects.length > 0) {
    elements.push(markdown('**修改配置**'))
    elements.push({
      tag: 'form',
      name: 'session_config_form',
      elements: [
        ...selects,
        {
          tag: 'button',
          name: 'config_submit',
          text: { tag: 'plain_text', content: '应用配置' },
          type: 'primary_filled',
          width: 'fill',
          form_action_type: 'submit',
        },
      ],
    })
    elements.push(note('权限修改立即生效；模型/Thinking 在下一轮请求生效；模式在首轮后锁定。'))
  } else {
    elements.push(note('当前部署未提供可修改的模型/权限目录。'))
  }
  if (input.archiveAvailable === true) {
    elements.push(button({
      text: '归档最近回答到飞书文档',
      type: 'default',
      width: 'fill',
      value: { op: 'archive_latest', sessionId: input.sessionId ?? '' },
    }))
  }
  elements.push(columns([
    {
      elements: [
        button({
          text: '打开会话',
          type: 'primary_filled',
          width: 'fill',
          value: { op: 'session_open', sessionId: input.sessionId ?? '' },
        }),
      ],
    },
    {
      elements: [
        button({
          text: '刷新',
          type: 'default',
          width: 'fill',
          value: { op: 'status', sessionId: input.sessionId ?? '' },
        }),
      ],
    },
    {
      elements: [
        button({
          text: '停止',
          type: 'danger',
          width: 'fill',
          disabled: input.running !== true,
          value: { op: 'cancel', sessionId: input.sessionId ?? '' },
        }),
      ],
    },
  ]))
  elements.push(note('点「打开会话」进入 prompt 表单；也可在卡片内直接修改模型/权限。'))
  return card(
    header({
      title: `会话状态 · #${input.code}`,
      subtitle: truncate(input.title || '会话', 100),
      template: input.running ? 'blue' : 'grey',
      tags: [{ text: input.running ? '运行中' : '空闲', color: input.running ? 'blue' : 'grey' }],
    }),
    elements,
  )
}

/**
 * @param {object} input
 * @param {Array<{ code: string, title: string, running: boolean, updatedAt: number }>} input.sessions
 */
export function buildSessionsCard(input) {
  const sessions = Array.isArray(input.sessions) ? input.sessions : []
  const rows = sessions.map((session) => {
    const state = session.running ? '🟢' : '⚪'
    const status = session.running ? '运行中' : '空闲'
    return columns([
      {
        width: 'weighted',
        weight: 3,
        elements: [
          markdown(`${state} **${escapeInline(stripImages(session.title) || '（未命名）')}**\n　#${session.code} · ${formatTime(session.updatedAt)} · ${status}`),
        ],
      },
      {
        width: 'weighted',
        weight: 1,
        elements: [
          button({
            text: '打开',
            type: session.running ? 'primary_filled' : 'default',
            width: 'fill',
            value: { op: 'session_open', sessionId: session.sessionId },
          }),
        ],
      },
    ])
  })
  return card(
    header({
      title: '最近会话',
      subtitle: input.rangeLabel ? `${input.rangeLabel} · ${sessions.length} 个` : `${sessions.length} 个`,
      template: 'blue',
      tags: [{ text: `${sessions.length} 个`, color: 'blue' }],
    }),
    [
      ...(rows.length > 0 ? rows : [markdown('_该时间范围内没有会话_')]),
      note('点「打开」进入会话操作；也可以直接发送 #<code> <内容>。'),
    ],
  )
}

/**
 * One session's action panel: copyable hash, a prompt form, and shortcuts.
 * @param {object} input
 * @param {string} input.code
 * @param {string} input.sessionId
 * @param {string} input.title
 * @param {boolean} input.running
 * @param {number} [input.updatedAt]
 * @param {string} [input.cwd]
 * @param {string} [input.model]
 * @param {number} [input.pending]
 * @param {number} [input.queued]
 */
export function buildSessionDetailCard(input) {
  const state = input.running ? '运行中' : '空闲'
  const fields = [
    `**状态**：${state}`,
    input.cwd ? `**目录**：\`${truncate(input.cwd, 160)}\`` : '',
    input.model ? `**模型**：\`${input.model}\`` : '',
    input.pending ? `**待处理交互**：${input.pending} 个` : '',
    input.queued ? `**排队**：${input.queued} 条` : '',
    input.updatedAt ? `**最近更新**：${formatTime(input.updatedAt)}` : '',
  ].filter(Boolean)

  return card(
    header({
      title: `${state} · ${truncate(input.title || '会话', 46)}`,
      subtitle: '',
      template: input.running ? 'green' : 'grey',
    }),
    [
      markdown(fields.join('\n')),
      note(`#${input.code}  ← 长按可复制`),
      {
        tag: 'form',
        name: 'session_form',
        elements: [
          {
            tag: 'input',
            name: 'prompt',
            placeholder: { tag: 'plain_text', content: '输入 prompt，再点下面的按钮发送' },
            input_type: 'multiline_text',
            rows: 2,
            auto_resize: true,
            max_length: 1000,
          },
          {
            tag: 'button',
            name: 'session_send',
            text: { tag: 'plain_text', content: '发送到该会话' },
            type: 'primary_filled',
            width: 'fill',
            form_action_type: 'submit',
          },
        ],
      },
      columns([
        {
          elements: [
            button({ text: '最近会话', type: 'default', width: 'fill', value: { op: 'sessions' } }),
          ],
        },
        {
          elements: [
            button({ text: '更多命令', type: 'default', width: 'fill', value: { op: 'help_index' } }),
          ],
        },
      ]),
      columns([
        {
          elements: [
            button({
              text: '查看状态 · 历史消息',
              type: 'default',
              width: 'fill',
              value: { op: 'status', sessionId: input.sessionId },
            }),
          ],
        },
        {
          elements: [
            button({
              text: '旁问',
              type: 'default',
              width: 'fill',
              value: { op: 'btw_prompt', sessionId: input.sessionId },
            }),
          ],
        },
      ]),
      note('「发送到该会话」写入会话；「旁问」走 /btw，不写入。'),
    ],
  )
}

export function buildHelpCard() {
  return card(
    header({ title: 'dsh-lark-ctrl 使用说明', subtitle: '手机上的 DeepSeek Harness 遥控器', template: 'blue' }),
    [
      markdown([
        '**命令总览**',
        ...helpTopics().map((topic) => `- \`${topic.command}\` — ${topic.summary}`),
        '',
        '发送 `/help /sessions` 查看单个命令的完整用法、示例和限制。',
        '',
        '**不用记 code 的方式**',
        '- 发送 `/workspaces 1d`，在工作区里「新建会话」，选模式/模型/权限后直接写 prompt',
        '- 发送 `/sessions 1d`，点会话的「打开」，在详情卡里输入 prompt 后点「发送」或「旁问」',
        '- 直接回复任意一条会话通知，内容会发给该会话',
        '- 回复提问卡/审批卡可文字作答（无需卡片回调权限）',
      ].join('\n')),
    ],
  )
}

/**
 * One command's detailed help: usage block, description, examples, notes and
 * related-topic buttons.
 * @param {import('./help.js').HelpTopic} topic
 */
export function buildHelpTopicCard(topic) {
  const examples = (topic.examples ?? []).map((example) =>
    `- \`${example.command}\` — ${example.note}`)
  const actions = [
    button({
      text: '返回帮助',
      type: 'primary_filled',
      width: 'fill',
      value: { op: 'help_index' },
    }),
    ...(topic.related ?? []).slice(0, 3).map((command) => button({
      text: command,
      type: 'default',
      width: 'fill',
      value: { op: 'help_topic', command },
    })),
  ]

  return card(
    header({
      title: `帮助 · ${topic.command}`,
      subtitle: truncate(topic.summary, 100),
      template: 'blue',
      tags: [{ text: '命令详情', color: 'blue' }],
    }),
    [
      markdown('**用法**\n```\n' + (topic.usage ?? []).join('\n') + '\n```'),
      markdown((topic.description ?? []).join('\n')),
      ...(examples.length > 0 ? [markdown('**示例**\n' + examples.join('\n'))] : []),
      ...(Array.isArray(topic.notes) && topic.notes.length > 0
        ? [markdown('**限制**\n' + topic.notes.map((item) => `- ${item}`).join('\n'))]
        : []),
      columns(actions.map((action) => ({ elements: [action] }))),
      note('发送 /help 查看全部命令；发送 /help /<命令> 查看其他命令详情。'),
    ],
  )
}

/**
 * @param {object} input
 * @param {string} input.code
 * @param {string} [input.title]
 * @param {string} input.question
 * @param {string} [input.answer]
 * @param {boolean} [input.available]
 * @param {string} [input.note]
 * @param {string} [input.model]
 */
export function buildBtwCard(input) {
  return card(
    header({
      title: `旁问 · #${input.code}`,
      subtitle: input.title ? truncate(input.title, 100) : '不写入会话上下文',
      template: 'turquoise',
      tags: [{ text: 'BTW', color: 'turquoise' }],
    }),
    [
      markdown(`**问题**\n> ${truncate(stripImages(input.question), 1200).split('\n').join('\n> ')}`),
      input.answer
        ? markdown(`**回答**\n${truncate(stripImages(input.answer), 6000)}`)
        : markdown(input.available === false
            ? '_未安装 dsh-btw，当前只能提供状态快照。_'
            : '_正在生成旁问回答…_'),
      ...(input.model ? [note(`模型：${input.model}`)] : []),
      note(input.note || '旁问不调用工具、不打断会话、不进入模型上下文。'),
    ],
  )
}

/**
 * @param {object} input
 * @param {string} [input.code]
 * @param {string} input.title
 * @param {string} input.message
 */
export function buildErrorCard(input) {
  return card(
    header({
      title: input.title,
      subtitle: input.code ? `#${input.code}` : 'dsh-lark-ctrl',
      template: 'red',
    }),
    [markdown(truncate(stripImages(input.message), 4000))],
  )
}

/**
 * @param {string} message
 * @param {string} [code]
 */
export function buildNoticeCard(message, code) {
  return card(
    header({
      title: 'dsh-lark-ctrl',
      subtitle: code ? `#${code}` : 'Lark bridge',
      template: 'grey',
    }),
    [markdown(truncate(stripImages(message), 4000))],
  )
}

/* ------------------------------------------------------------------------- */
/* Form parsing                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Convert a Lark `form_value` object into the exact AskUserQuestionAnswer
 * shape the Host answerer expects.
 *
 * @param {unknown} formValue
 * @param {Array<Record<string, any>>} questions
 * @returns {{ answers?: Array<{ id: string, selected: string[], custom?: string }>, error?: string }}
 */
export function extractFormAnswers(formValue, questions) {
  const form = normalizeFormValue(formValue)
  if (form === undefined) return { error: '无法读取卡片表单内容，请在 Web 端回答或重试。' }
  if (!Array.isArray(questions) || questions.length === 0) return { error: '问题列表为空。' }

  const answers = []
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]
    const options = Array.isArray(question.options) ? question.options : []
    const labels = new Set(options.map((option) => String(option.label)))
    const rawSelected = form[`q${index}`]
    const custom = normalizeCustom(form[`c${index}`])
    let selected = normalizeSelected(rawSelected, question.multiSelect === true)
    selected = selected.filter((label) => labels.has(label))

    if (question.multiSelect === true) {
      answers.push({
        id: String(question.id),
        selected,
        ...(custom !== undefined ? { custom } : {}),
      })
    } else if (custom !== undefined) {
      answers.push({ id: String(question.id), selected: [], custom })
    } else {
      answers.push({ id: String(question.id), selected: selected.slice(0, 1) })
    }
  }
  return { answers }
}

/**
 * Parse a plain-text reply to a question card. Only single-question calls are
 * supported here; batch questions must use the card form.
 *
 * @param {string} text
 * @param {Array<Record<string, any>>} questions
 * @returns {{ answers?: Array<{ id: string, selected: string[], custom?: string }>, error?: string }}
 */
export function parseTextAnswer(text, questions) {
  const input = String(text ?? '').trim()
  if (input === '') return { error: '回答为空。' }
  if (!Array.isArray(questions) || questions.length !== 1) {
    return { error: '这个问题包含多个问题，请使用卡片表单提交。' }
  }
  const question = questions[0]
  const options = Array.isArray(question.options) ? question.options : []
  const labels = options.map((option) => String(option.label))
  const tokens = question.multiSelect === true
    ? input.split(/[,，、\s]+/).filter(Boolean)
    : [input]

  const selected = []
  const customParts = []
  for (const token of tokens) {
    const index = parseIndex(token)
    if (index !== undefined && index >= 1 && index <= labels.length) {
      selected.push(labels[index - 1])
      continue
    }
    const exact = labels.find((label) => label.toLowerCase() === token.toLowerCase())
    if (exact !== undefined) {
      selected.push(exact)
      continue
    }
    // A prefix is accepted only when it identifies exactly one option.
    const prefix = labels.filter((label) => label.toLowerCase().startsWith(token.toLowerCase()))
    if (prefix.length === 1) {
      selected.push(prefix[0])
      continue
    }
    customParts.push(token)
  }

  const uniqueSelected = [...new Set(selected)]
  const customText = customParts.join(question.multiSelect === true ? '，' : ' ').trim()
  const custom = customText === '' ? undefined : truncate(customText, MAX_CUSTOM)

  if (question.multiSelect === true) {
    return {
      answers: [{
        id: String(question.id),
        selected: uniqueSelected,
        ...(custom !== undefined ? { custom } : {}),
      }],
    }
  }
  if (uniqueSelected.length > 0) {
    return { answers: [{ id: String(question.id), selected: [uniqueSelected[0]] }] }
  }
  return {
    answers: [{
      id: String(question.id),
      selected: [],
      ...(custom !== undefined ? { custom } : { selected: [] }),
    }],
  }
}

/**
 * @param {string} text
 * @returns {'allow' | 'reject' | undefined}
 */
export function parseApprovalText(text) {
  const value = String(text ?? '').trim().toLowerCase()
  if (value === '') return undefined
  if (['1', 'y', 'yes', 'allow', 'approve', 'ok', '允许', '同意', '通过', '✅', '👍'].includes(value)) return 'allow'
  if (['2', 'n', 'no', 'reject', 'deny', '拒绝', '不允许', '否', '❌', '👎'].includes(value)) return 'reject'
  if (value.startsWith('允许') || value.startsWith('同意') || value.startsWith('approve')) return 'allow'
  if (value.startsWith('拒绝') || value.startsWith('不允许') || value.startsWith('reject') || value.startsWith('deny')) return 'reject'
  return undefined
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
export function normalizeFormValue(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    try {
      const parsed = JSON.parse(trimmed)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value
  return undefined
}

/** @param {unknown} value @param {boolean} multi */
function normalizeSelected(value, multi) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
  if (typeof value === 'string') {
    if (value === '') return []
    return multi ? value.split(',').map((item) => item.trim()).filter(Boolean) : [value]
  }
  return []
}

/** @param {unknown} value */
function normalizeCustom(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return truncate(trimmed, MAX_CUSTOM)
}

/** @param {string} token */
function parseIndex(token) {
  const match = /^(\d+)[.、)]?$/.exec(token.trim())
  if (!match) return undefined
  const value = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(value) ? value : undefined
}

/* ------------------------------------------------------------------------- */
/* Utilities                                                                 */
/* ------------------------------------------------------------------------- */

/** @param {string} value */
function escapeInline(value) {
  return String(value ?? '').replace(/[*_`[\]]/g, '\\$&')
}

/**
 * Keep the serialized card below Lark's 30 KB card limit. Long strings are
 * truncated first; an oversized card collapses to a short notice.
 * @param {Record<string, unknown>} value
 * @param {number} [maxBytes]
 */
export function fitCard(value, maxBytes = MAX_CARD_BYTES) {
  let serialized = JSON.stringify(value)
  if (serialized.length <= maxBytes) return value
  truncateStrings(value, 1200)
  serialized = JSON.stringify(value)
  if (serialized.length <= maxBytes) return value
  truncateStrings(value, 400)
  serialized = JSON.stringify(value)
  if (serialized.length <= maxBytes) return value
  return buildErrorCard({
    title: '内容过长',
    message: '卡片内容超过飞书限制，请在 DSH Web 端查看完整内容。',
  })
}

/** @param {unknown} value @param {number} max */
function truncateStrings(value, max) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) truncateStrings(item, max)
    return value
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && item.length > max) value[key] = truncate(item, max)
      else truncateStrings(item, max)
    }
  }
  return value
}

/* ------------------------------------------------------------------------- */
/* Push level / workspaces / creation                                        */
/* ------------------------------------------------------------------------- */

/**
 * @param {object} input
 * @param {0|1|2} input.current
 */
export function buildLevelCard(input) {
  const levels = [
    { level: 0, label: '0 静默', description: '不推送；提问/审批交给 Web' },
    { level: 1, label: '1 仅阻塞', description: '只推送提问卡和审批卡' },
    { level: 2, label: '2 全部', description: '提问/审批 + 开始/结束摘要' },
  ]
  return card(
    header({
      title: '推送级别',
      subtitle: `当前 L${input.current}`,
      template: input.current === 0 ? 'grey' : 'blue',
      tags: [{ text: `L${input.current}`, color: input.current === 0 ? 'grey' : 'blue' }],
    }),
    [
      markdown(levels.map((item) => `- **${item.label}**：${item.description}`).join('\n')),
      columns(levels.map((item) => ({
        elements: [
          button({
            text: item.label,
            type: item.level === input.current ? 'primary_filled' : 'default',
            width: 'fill',
            value: { op: 'set_level', level: item.level },
          }),
        ],
      }))),
      note('也可以直接发送 /level 0、/level 1、/level 2。切换后立即生效；命令回复始终发送。'),
    ],
  )
}

/** @param {Record<string, any>} session */
function sessionRow(session) {
  const state = session.running ? '🟢' : '⚪'
  const status = session.running ? '运行中' : '空闲'
  return columns([
    {
      width: 'weighted',
      weight: 3,
      elements: [
        markdown(`${state} **#${session.code}** ${escapeInline(stripImages(session.title) || '（未命名）')}\n　${formatTime(session.updatedAt)} · ${status}`),
      ],
    },
    {
      width: 'weighted',
      weight: 1,
      elements: [
        button({
          text: '打开',
          type: 'default',
          width: 'fill',
          value: { op: 'session_open', sessionId: session.sessionId },
        }),
      ],
    },
  ])
}

/**
 * @param {object} input
 * @param {Array<{ workspace: Record<string, any>, sessions: Array<Record<string, any>> }>} input.groups
 * @param {Array<Record<string, any>>} [input.ungrouped]
 * @param {string} input.rangeLabel
 * @param {boolean} [input.truncated]
 */
export function buildWorkspacesCard(input) {
  const elements = []
  for (let index = 0; index < input.groups.length; index += 1) {
    const group = input.groups[index]
    const workspace = group.workspace
    const inner = [
      markdown(`\`${truncate(workspace.path, 300)}\`${workspace.missingDir ? '  ⚠️ 目录不存在' : ''}`),
    ]
    if (group.sessions.length === 0) {
      inner.push(note('该时间范围内没有会话'))
    } else {
      for (const session of group.sessions) inner.push(sessionRow(session))
    }
    inner.push(button({
      text: '新建会话',
      type: 'primary',
      width: 'fill',
      value: { op: 'workspace_new_session', workspaceId: workspace.id },
    }))
    elements.push({
      tag: 'collapsible_panel',
      expanded: index === 0,
      header: {
        title: { tag: 'plain_text', content: `${workspace.title || '（未命名工作区）'} (${group.sessions.length})` },
      },
      elements: inner,
    })
  }

  if (Array.isArray(input.ungrouped) && input.ungrouped.length > 0) {
    elements.push(markdown('**未分组会话**'))
    for (const session of input.ungrouped) elements.push(sessionRow(session))
  }

  if (elements.length === 0) elements.push(markdown('_没有可展示的工作区或会话_'))
  if (input.truncated) elements.push(note('结果已截断；发送 /workspaces 查看全部工作区。'))
  elements.push(button({
    text: '新建工作区',
    type: 'default',
    width: 'fill',
    value: { op: 'workspace_new' },
  }))
  elements.push(note(`发送 /workspaces 1h / 1d 可筛选；发送 /workspaces 查看全部工作区。`))

  return card(
    header({
      title: '最近工作区',
      subtitle: `${input.rangeLabel || '全部'} · ${input.groups.length} 个工作区`,
      template: 'grey',
    }),
    elements,
  )
}

/**
 * @param {object} input
 * @param {Record<string, any>} input.workspace
 * @param {Array<Record<string, any>>} input.sessions
 * @param {boolean} [input.created]
 */
export function buildWorkspaceDetailCard(input) {
  const elements = [
    markdown(`\`${truncate(input.workspace.path, 300)}\`${input.workspace.missingDir ? '  ⚠️ 目录不存在' : ''}`),
    button({
      text: '新建会话',
      type: 'primary',
      width: 'fill',
      value: { op: 'workspace_new_session', workspaceId: input.workspace.id },
    }),
  ]
  if (input.sessions.length === 0) elements.push(note('该工作区还没有会话'))
  else for (const session of input.sessions) elements.push(sessionRow(session))
  if (input.created) elements.push(note('工作区已创建；选择「新建会话」开始。'))
  return card(
    header({
      title: `工作区 · ${truncate(input.workspace.title || '（未命名）', 60)}`,
      subtitle: `#${input.workspace.id}`,
      template: 'blue',
    }),
    elements,
  )
}

export function buildCreateWorkspaceCard() {
  return card(
    header({ title: '新建工作区', subtitle: '给定一个绝对路径', template: 'blue' }),
    [
      markdown('目录不存在时会自动 `mkdir -p`；没有权限或父路径是文件时会创建失败。'),
      {
        tag: 'form',
        name: 'workspace_create_form',
        elements: [
          {
            tag: 'input',
            name: 'path',
            required: true,
            placeholder: { tag: 'plain_text', content: '绝对路径，例如 /home/you/projects/demo' },
            max_length: 1000,
          },
          {
            tag: 'input',
            name: 'title',
            placeholder: { tag: 'plain_text', content: '标题（可选，默认目录名）' },
            max_length: 100,
          },
          {
            tag: 'button',
            name: 'workspace_create_submit',
            text: { tag: 'plain_text', content: '创建' },
            type: 'primary_filled',
            width: 'fill',
            form_action_type: 'submit',
          },
        ],
      },
    ],
  )
}

/**
 * @param {object} input
 * @param {Record<string, any>} input.workspace
 * @param {Array<{ value: string, text: string }>} input.agentPresets
 * @param {Array<{ value: string, text: string }>} input.models
 * @param {Array<{ value: string, text: string }>} [input.efforts]
 * @param {Array<{ value: string, text: string }>} input.permissions
 * @param {{ agentPreset?: string, model?: string, effort?: string, permission?: string }} input.defaults
 */
export function buildCreateSessionCard(input) {
  const agentPresets = Array.isArray(input.agentPresets) ? input.agentPresets : []
  const models = Array.isArray(input.models) ? input.models : []
  const efforts = Array.isArray(input.efforts) ? input.efforts : []
  const permissions = Array.isArray(input.permissions) ? input.permissions : []
  const defaults = input.defaults ?? {}
  const form = []
  const select = (name, placeholder, options, initial) => ({
    tag: 'select_static',
    name,
    placeholder: { tag: 'plain_text', content: placeholder },
    options: options.map((option) => ({
      text: { tag: 'plain_text', content: truncate(option.text, 100) },
      value: option.value,
    })),
    ...(initial !== undefined && options.some((option) => option.value === initial) ? { initial_option: initial } : {}),
    width: 'fill',
  })

  if (agentPresets.length > 0) {
    form.push(select('agent_preset', '模式（Agent 预设）', agentPresets, defaults.agentPreset))
  }
  if (models.length > 0) {
    form.push(select('model', '模型', models, defaults.model))
  }
  if (models.length > 0 && efforts.length > 1) {
    // Default to "model decides": switching models cannot inherit an effort
    // that the newly selected model does not support.
    form.push(select('effort', 'Thinking effort', efforts, ''))
  }
  if (permissions.length > 0) {
    form.push(select('permission', '权限（沙箱 + 审批）', permissions, defaults.permission))
  }
  form.push({
    tag: 'input',
    name: 'prompt',
    required: true,
    placeholder: { tag: 'plain_text', content: '输入首条 prompt，创建后立即发送' },
    input_type: 'multiline_text',
    rows: 3,
    auto_resize: true,
    max_length: 1000,
  })
  form.push({
    tag: 'button',
    name: 'session_create_submit',
    text: { tag: 'plain_text', content: '创建并发送' },
    type: 'primary_filled',
    width: 'fill',
    form_action_type: 'submit',
  })

  return card(
    header({
      title: '新建会话',
      subtitle: truncate(input.workspace.title || input.workspace.path, 80),
      template: 'blue',
    }),
    [
      markdown(`**工作区**：\`${truncate(input.workspace.path, 300)}\``),
      { tag: 'form', name: 'session_create_form', elements: form },
      note('Thinking effort 需要与所选模型匹配；不支持时会返回错误。prompt 上限 1000 字，更长内容可创建后发送 `#code <内容>`。'),
    ],
  )
}

/**
 * @param {object} input
 * @param {string} input.code
 * @param {string} input.sessionId
 * @param {string} input.title
 * @param {string} [input.workspaceTitle]
 * @param {boolean} [input.promptSent]
 */
export function buildSessionCreatedCard(input) {
  return card(
    header({
      title: `已创建会话 · #${input.code}`,
      subtitle: truncate(input.workspaceTitle || input.title || '新会话', 80),
      template: 'green',
      tags: [{ text: '已创建', color: 'green' }],
    }),
    [
      markdown(`**${escapeInline(input.title || '新会话')}**`),
      markdown(input.promptSent === false
        ? '_会话已创建，但首条 prompt 未发送；点「打开」后可继续输入。_'
        : '_首条 prompt 已发送，会话开始运行。_'),
      button({
        text: '打开会话',
        type: 'primary_filled',
        width: 'fill',
        value: { op: 'session_open', sessionId: input.sessionId },
      }),
    ],
  )
}


/* ------------------------------------------------------------------------- */
/* History (recent messages)                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The transcript list behind the status card's 「历史记录列表」 button: one row
 * per message, each with a 「查看」 button that sends that message in full.
 * @param {{ code: string, rows?: Array<{ role: string, text: string, at: number }>, sessionId?: string }} input
 */
export function buildHistoryCard(input) {
  const rows = Array.isArray(input.rows) ? input.rows : []
  // Two windows: the newest 16 are visible, the rest fold behind a panel.
  const visible = rows.slice(0, 16)
  const hidden = rows.slice(16)
  const rowElement = (row, index) => columns([
    {
      width: 'weighted',
      weight: 4,
      elements: [
        markdown(`${row.role === 'user' ? '👤' : '🤖'} **${formatTime(row.at)}** ${escapeInline(truncate(row.text.replace(/\s+/g, ' '), 84))}${Array.isArray(row.images) && row.images.length > 0 ? ' 📷' : ''}`),
      ],
    },
    {
      width: 'weighted',
      weight: 1,
      elements: [
        button({
          text: '查看',
          type: 'default',
          width: 'fill',
          value: { op: 'history_item', sessionId: input.sessionId ?? '', index },
        }),
      ],
    },
  ])
  const elements = visible.map((row, index) => rowElement(row, index))
  if (hidden.length > 0) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: {
          tag: 'markdown',
          content: `**🕘 更早的 ${hidden.length} 条** 点击展开…`,
        },
        vertical_align: 'center',
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '6px' },
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: hidden.map((row, offset) => rowElement(row, visible.length + offset)),
    })
  }
  return card(
    header({ title: `历史记录 · #${input.code}`.trim(), template: 'blue', tags: [{ text: `${rows.length} 条`, color: 'blue' }] }),
    [
      ...(rows.length > 0 ? elements : [markdown('_（这个会话还没有历史消息）_')]),
      note('按时间倒序：最新的在最上面。点「查看」看单条全文；默认显示最近 16 条，更早的折叠在下面。'),
    ],
  )
}

/* ------------------------------------------------------------------------- */
/* Archive (long answers)                                                     */
/* ------------------------------------------------------------------------- */

/** @param {string} text @param {string} url @param {string} [type] */
function openUrlButton(text, url, type = 'default') {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: truncate(text, 100) },
    type,
    width: 'fill',
    behaviors: [{ type: 'open_url', default_url: url }],
  }
}

/**
 * @param {object} input
 * @param {boolean} input.configured
 * @param {string} [input.parentUrl]
 * @param {string} [input.parentTitle]
 * @param {string} [input.error]
 */
export function buildArchiveStatusCard(input) {
  const parentUrl = typeof input.parentUrl === 'string' ? input.parentUrl : ''
  const source = input.source === 'lark' ? '飞书' : input.source === 'config' ? 'profile 配置' : ''
  const elements = []
  if (!input.configured) {
    elements.push(markdown('_未配置归档父文档。可以直接在下面粘贴 Wiki 文档 URL 保存，或发送 `/archive set <url>`。_'))
  } else if (input.error) {
    elements.push(markdown(`**无法读取归档父文档**\n${truncate(input.error, 800)}`))
  } else {
    elements.push(markdown(`**归档父文档**：[${input.parentTitle || '打开文档'}](${parentUrl})`))
    if (source !== '') elements.push(note(`配置来源：${source}`))
  }
  elements.push({
    tag: 'form',
    name: 'archive_form',
    elements: [
      {
        tag: 'input',
        name: 'archive_url',
        required: true,
        placeholder: { tag: 'plain_text', content: '粘贴 Wiki 父文档 URL，例如 https://.../wiki/...' },
        max_length: 1000,
      },
      {
        tag: 'button',
        name: 'archive_set_submit',
        text: { tag: 'plain_text', content: '保存归档文档' },
        type: 'primary_filled',
        width: 'fill',
        form_action_type: 'submit',
      },
    ],
  })
  elements.push(note('长回答的完成卡会出现「归档完整回答到飞书文档」按钮；归档内容按日期和 #code 写入父文档。'))
  elements.push(note('清理：发送 /archive delete-before YYYY-MM-DD。'))
  if (parentUrl !== '' && !input.error) elements.push(openUrlButton('打开归档文档', parentUrl, 'default'))
  if (input.source === 'lark') {
    elements.push(button({
      text: '清除飞书配置',
      type: 'default',
      width: 'fill',
      value: { op: 'archive_clear' },
    }))
  }
  return card(
    header({
      title: '回答归档',
      subtitle: input.parentTitle || '长回答归档',
      template: input.error ? 'red' : input.configured ? 'turquoise' : 'grey',
      tags: [{ text: input.configured ? '已配置' : '未配置', color: input.configured ? 'turquoise' : 'grey' }],
    }),
    elements,
  )
}

/**
 * @param {object} input
 * @param {string} input.url
 * @param {string} [input.parentUrl]
 * @param {string} [input.parentTitle]
 * @param {string} [input.warning]
 */
export function buildArchiveResultCard(input) {
  const already = input.alreadyArchived === true
  const elements = [
    markdown(`**完整回答**：[打开飞书文档](${input.url})`),
  ]
  if (already) elements.push(note('该回答的归档已存在，本次没有重复创建。'))
  if (input.warning) elements.push(markdown(`> ${truncate(input.warning, 800)}`))
  if (input.parentUrl) elements.push(note(`已归档到：${input.parentTitle || input.parentUrl}`))
  elements.push(openUrlButton('打开完整回答', input.url, 'primary_filled'))
  return card(
    header({
      title: already ? '回答已归档过' : '回答已归档',
      subtitle: input.parentTitle || '飞书文档',
      template: input.warning ? 'orange' : already ? 'grey' : 'green',
      tags: [{ text: input.warning ? '部分完成' : already ? '已存在' : '已完成', color: input.warning ? 'orange' : already ? 'grey' : 'green' }],
    }),
    elements,
  )
}

/**
 * @param {object} input
 * @param {string} input.cutoff
 * @param {number} input.count
 * @param {string[]} input.dates
 * @param {string} input.key
 */
export function buildArchiveDeletePreviewCard(input) {
  const dates = input.dates.slice(0, 12)
  const lines = [
    `**截止日期**：\`${input.cutoff}\`（删除此日期之前）`,
    `**匹配文档**：${input.count} 篇`,
    ...(dates.length > 0 ? ['', '日期：' + dates.map((date) => `\`${date}\``).join('、')] : []),
  ]
  return card(
    header({
      title: '确认删除归档回答',
      subtitle: `早于 ${input.cutoff}`,
      template: 'red',
      tags: [{ text: '待确认', color: 'red' }],
    }),
    [
      markdown(lines.join('\n')),
      note('只删除带 [dsh-lark] 标记的索引链接及其子文档；用户手动添加的内容不会删除。'),
      columns([
        {
          elements: [button({
            text: '确认删除',
            type: 'danger_filled',
            width: 'fill',
            value: { op: 'archive_delete_confirm', key: input.key },
          })],
        },
        {
          elements: [button({
            text: '取消',
            type: 'default',
            width: 'fill',
            value: { op: 'archive_delete_cancel', key: input.key },
          })],
        },
      ]),
    ],
  )
}

/**
 * @param {object} input
 * @param {string} input.cutoff
 * @param {number} input.deleted
 * @param {number} input.total
 * @param {Array<{ url: string, error: string }>} [input.failed]
 */
export function buildArchiveDeleteResultCard(input) {
  const failed = Array.isArray(input.failed) ? input.failed : []
  const elements = [
    markdown(`**截止日期**：\`${input.cutoff}\`\n**成功删除**：${input.deleted} / ${input.total}`),
  ]
  if (failed.length > 0) {
    elements.push(markdown('**失败项**\n' + failed.slice(0, 8).map((item) => `- ${truncate(item.url, 160)}\n  ${truncate(item.error, 300)}`).join('\n')))
  }
  return card(
    header({
      title: '归档清理完成',
      subtitle: `早于 ${input.cutoff}`,
      template: failed.length > 0 ? 'orange' : 'green',
      tags: [{ text: failed.length > 0 ? '部分失败' : '已完成', color: failed.length > 0 ? 'orange' : 'green' }],
    }),
    elements,
  )
}

/**
 * Note shown when a turn produced images.
 * @param {boolean} had
 * @param {number} [count]
 */
function summaryImageNote(had, count) {
  if (had !== true) return ''
  const n = typeof count === 'number' && count > 0 ? count : undefined
  return n === undefined
    ? '📷 本轮包含图片；完整内容请在 Web 会话中查看。'
    : '📷 本轮 ' + n + ' 张图（见下方消息）'
}
