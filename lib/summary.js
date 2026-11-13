/**
 * Deterministic run summaries. No model call: the card is built from the
 * committed Session log so a summary can never fail because of a provider.
 */

import { contentText, formatDuration, hasImages, nonNegativeInt, stripImages, truncate } from './util.js'

/**
 * Fold the last turn of a Session event array. Pure and testable.
 * @param {ReadonlyArray<Record<string, any>>} events
 * @returns {{
 *   turn: number,
 *   startedAt: number,
 *   endedAt: number,
 *   userText: string,
 *   assistantText: string,
 *   toolCalls: number,
 *   toolNames: string[],
 *   usage: { inputTokens: number, outputTokens: number },
 *   reason: Record<string, any> | undefined,
 *   model: string,
 * }}
 */
export function foldTurnStats(events) {
  let startIndex = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/start') {
      startIndex = index
      break
    }
  }
  const from = startIndex === -1 ? Math.max(0, events.length - 200) : startIndex
  const stats = {
    turn: 0,
    startedAt: 0,
    endedAt: 0,
    userText: '',
    assistantText: '',
    toolCalls: 0,
    toolErrors: 0,
    images: [],
    toolNames: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    reason: undefined,
    model: '',
  }
  const toolNames = new Set()
  for (let index = from; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    const data = event.data ?? {}
    switch (event.type) {
      case 'turn/start':
        stats.turn = nonNegativeInt(data.turn)
        stats.startedAt = nonNegativeInt(event.time)
        break
      case 'user/message':
        if (data.source?.kind === 'user' || data.source?.kind === undefined) {
          const text = contentText(data.content)
          if (text !== '') stats.userText = text
        }
        break
      case 'assistant/message': {
        collectImages(stats, data?.message?.content)
        const text = contentText(data.message?.content)
        if (text !== '') stats.assistantText = text
        stats.usage.inputTokens += nonNegativeInt(data.usage?.inputTokens)
        stats.usage.outputTokens += nonNegativeInt(data.usage?.outputTokens)
        break
      }
      case 'tool/call':
        stats.toolCalls += 1
        if (typeof data.name === 'string') toolNames.add(data.name)
        break
      case 'tool/result':
        collectImages(stats, Array.isArray(data?.content) ? data.content : (data?.content !== undefined ? [data.content] : []))
        // A failed tool is the difference between "done" and "done with errors".
        if (data.error !== undefined && data.error !== null) stats.toolErrors += 1
        break
      case 'turn/end':
        stats.endedAt = nonNegativeInt(event.time)
        stats.reason = data.reason
        break
      case 'request/header': {
        const config = data.header?.config
        if (typeof config?.model === 'string') stats.model = config.model
        break
      }
      default:
        break
    }
  }
  stats.toolNames = [...toolNames]
  return stats
}

/**
 * @param {object} input
 * @param {Record<string, any>} input.session - live Session
 * @param {string} input.title
 * @param {Record<string, any>} [input.run] - in-memory run accumulator
 * @param {number} input.maxChars
 * @param {number} [input.now]
 */
export function summarizeRun({ session, title, run, maxChars, now = Date.now() }) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
  const stats = foldTurnStats(events)
  const startedAt = nonNegativeInt(run?.startedAt) || stats.startedAt
  const endedAt = stats.endedAt || now
  const durationMs = startedAt > 0 ? Math.max(0, endedAt - startedAt) : 0
  const rawAssistantText = run?.assistantText || stats.assistantText || ''
  const rawUserText = run?.userText || stats.userText || ''
  // Strip images before truncation: a long image URL/data URI would otherwise
  // be cut in half and remain as broken `![...](...` raw markdown on the card.
  const imagesOmitted = hasImages(rawAssistantText) || hasImages(rawUserText)
  const strippedAssistantText = stripImages(rawAssistantText)
  const assistantText = truncate(strippedAssistantText, maxChars)
  const userText = truncate(stripImages(rawUserText), Math.max(200, Math.floor(maxChars / 3)))
  const truncated = strippedAssistantText.length > assistantText.length
  // Keep a longer copy for the card's "expand full answer" panel (bounded so the
  // card stays under Lark's size limit).
  const assistantFull = truncate(strippedAssistantText, 6000)
  const fullTruncated = strippedAssistantText.length > assistantFull.length
  const usage = {
    inputTokens: nonNegativeInt(run?.usage?.inputTokens) || stats.usage.inputTokens,
    outputTokens: nonNegativeInt(run?.usage?.outputTokens) || stats.usage.outputTokens,
  }
  const reason = run?.reason ?? stats.reason
  return {
    title: title || '',
    userText,
    assistantText,
    assistantFull,
    fullTruncated,
    imagesOmitted,
    images: stats.images.slice(0, 4),
    truncated,
    durationMs,
    durationText: formatDuration(durationMs),
    toolCalls: nonNegativeInt(run?.toolCalls) || stats.toolCalls,
    toolErrors: nonNegativeInt(run?.toolErrors) || stats.toolErrors,
    toolNames: Array.isArray(run?.toolNames) && run.toolNames.length > 0 ? run.toolNames : stats.toolNames,
    usage,
    reason,
    reasonText: reasonTextOf(reason),
    errorMessage: errorMessageOf(reason),
    model: typeof run?.model === 'string' && run.model !== '' ? run.model : stats.model,
    cwd: typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined,
    startedAt,
    endedAt,
  }
}

/** @param {unknown} reason */
export function reasonTextOf(reason) {
  const kind = typeof reason === 'object' && reason !== null && typeof reason.kind === 'string' ? reason.kind : ''
  switch (kind) {
    case 'completed':
      return '已完成'
    case 'aborted':
      return '已停止'
    case 'blocked':
      return '被阻塞'
    case 'error':
      return '失败'
    case 'max-tokens':
      return '达到输出上限'
    case 'interrupted':
      return '被中断'
    case 'forked':
      return '已分叉'
    default:
      return '已结束'
  }
}

/** @param {unknown} reason */
export function errorMessageOf(reason) {
  if (typeof reason !== 'object' || reason === null) return ''
  if (reason.kind !== 'error') return ''
  const error = reason.error
  if (typeof error?.message === 'string') return error.message
  if (typeof error === 'string') return error
  return ''
}

/**
 * Completion status shown in the card header and its template colour.
 *
 * `turn/end`'s reason alone is almost always `completed` - it says the turn
 * finished, not whether the work did. Layer in evidence from the turn itself:
 * failed tools, whether any tool ran at all, and whether the session is sitting
 * on an unanswered question.
 *
 * @param {{
 *   reason?: Record<string, any>,
 *   pendingQuestion?: boolean,
 *   toolErrors?: number,
 *   toolCalls?: number,
 * }} [input]
 * @returns {{ text: string, tone: string }} `tone` is a Lark card template colour
 */
export function statusOf(input = {}) {
  const kind = typeof input.reason === 'object' && input.reason !== null && typeof input.reason.kind === 'string'
    ? input.reason.kind
    : ''
  switch (kind) {
    case 'error': return { text: '❌ 失败', tone: 'red' }
    case 'aborted':
    case 'interrupted': return { text: '🛑 已停止', tone: 'grey' }
    case 'blocked': return { text: '⏸️ 被阻塞', tone: 'yellow' }
    case 'max-tokens': return { text: '✂️ 触到输出上限', tone: 'orange' }
    case 'forked': return { text: '🌿 已分叉', tone: 'violet' }
    default: break
  }
  if (input.pendingQuestion === true) return { text: '🙋 等你回答', tone: 'yellow' }
  const errors = nonNegativeInt(input.toolErrors)
  if (errors > 0) return { text: `⚠️ 有工具报错（${errors}）`, tone: 'orange' }
  // An unknown tool count (events unavailable) must not claim "no tools ran".
  if (input.toolCalls !== undefined && nonNegativeInt(input.toolCalls) === 0) return { text: '💬 已回答', tone: 'blue' }
  return { text: '✅ 已完成', tone: 'green' }
}

/** @param {unknown} reason */
export function isErrorReason(reason) {
  return typeof reason === 'object' && reason !== null && reason.kind === 'error'
}

/**
 * Collect image blocks of a message / tool result.
 * @param {{ images: Array<Record<string, any>> }} stats
 * @param {unknown} content
 */
function collectImages(stats, content) {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block?.type === 'image' && block.attachment !== undefined) stats.images.push(block.attachment)
  }
}
