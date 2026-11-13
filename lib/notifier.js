/**
 * Run lifecycle notifications.
 *
 * A "run" starts when the agent goes idle → running and ends only when it is
 * truly idle again (idle status, empty inbox, and a grace period with no new
 * turn). That collapses goal continuations and queued follow-ups into one
 * start/end pair while still notifying every user-initiated run.
 */

import { buildEndCard, buildStartCard, fitCard } from './cards.js'
import { isErrorReason, statusOf, summarizeRun } from './summary.js'
import { rmSync, writeFileSync } from 'node:fs'

import { contentText, newId, nonNegativeInt, stripImages, truncate } from './util.js'
import { workspaceLine } from './workspace-line.js'

/**
 * Whether a completion card should offer the archive action. The URL may come
 * from the profile config or from the Lark `/archive` state override.
 * @param {{ archiveParentUrl?: string }} config
 * @param {{ archiveParentUrl?: () => string } | undefined} store
 * @returns {boolean}
 */
export function isArchiveConfigured(config, store) {
  try {
    const override = typeof store?.archiveParentUrl === 'function' ? store.archiveParentUrl() : ''
    return (override || config.archiveParentUrl || '').trim() !== ''
  } catch {
    return typeof config.archiveParentUrl === 'string' && config.archiveParentUrl.trim() !== ''
  }
}

/**
 * @param {object} deps
 * @param {import('@deepseek-ai/cordis').Context} deps.ctx
 * @param {ReturnType<import('./config.js').normalizeConfig>} deps.config
 * @param {ReturnType<import('./registry.js').createRegistry>} deps.registry
 * @param {ReturnType<import('./transport.js').createTransport>} deps.transport
 * @param {ReturnType<import('./store.js').createStore>} deps.store
 * @param {{ info: Function, warn: Function, debug: Function }} deps.logger
 */
export function createNotifier({ ctx, config, registry, transport, store, logger }) {
  /** @type {Map<string, Run>} */
  const runs = new Map()
  /** @type {Map<string, NodeJS.Timeout>} */
  const startTimers = new Map()
  /** @type {Map<string, NodeJS.Timeout>} */
  const endTimers = new Map()
  let disposed = false

  /**
   * @typedef {object} Run
   * @property {string} id
   * @property {string} sessionId
   * @property {number} startedAt
   * @property {number} lastActivityAt
   * @property {number} lastTurn
   * @property {string} userText
   * @property {string} assistantText
   * @property {number} toolCalls
   * @property {string[]} toolNames
   * @property {{ inputTokens: number, outputTokens: number }} usage
   * @property {Record<string, any> | undefined} reason
   * @property {string} model
   * @property {boolean} startSent
   * @property {boolean} endSent
   * @property {string | undefined} startMessageId
   * @property {NodeJS.Timeout | undefined} startRefreshTimer
   */

  function register() {
    return ctx.effect(() => {
      const offStatus = ctx.on('agent/status', onStatus)
      const offEvent = ctx.on('session/event', onSessionEvent)
      return () => {
        disposed = true
        offStatus()
        offEvent()
        for (const timer of startTimers.values()) clearTimeout(timer)
        for (const timer of endTimers.values()) clearTimeout(timer)
        for (const run of runs.values()) clearStartRefresh(run)
        startTimers.clear()
        endTimers.clear()
      }
    }, 'lark: run notifications')
  }

  /** @param {{ agent: any, status: string }} payload */
  function onStatus({ agent, status }) {
    if (disposed || agent === undefined) return
    const session = agent.session
    if (session === undefined || shouldSkip(session)) return
    if (status === 'running') {
      const run = ensureRun(agent)
      cancelEndTimer(agent.id)
      if (run !== undefined) scheduleStart(run, session)
      return
    }
    if (status === 'idle') {
      scheduleEnd(agent)
    }
  }

  /** @param {any} session @param {any} event */
  function onSessionEvent(session, event) {
    if (disposed || session === undefined || event === undefined) return
    if (shouldSkip(session)) return
    const sessionId = session.id
    let run = runs.get(sessionId)
    if (run === undefined) {
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined || agent.status !== 'running') return
      run = ensureRun(agent)
      if (run === undefined) return
    }
    const data = event.data ?? {}
    run.lastActivityAt = nonNegativeInt(event.time) || Date.now()
    switch (event.type) {
      case 'turn/start':
        run.lastTurn = nonNegativeInt(data.turn) || run.lastTurn
        if (run.startedAt === 0) run.startedAt = nonNegativeInt(event.time) || Date.now()
        break
      case 'user/message': {
        if (data.source?.kind !== 'user' && data.source?.kind !== undefined) break
        const text = contentText(data.content)
        if (text !== '') run.userText = text
        break
      }
      case 'assistant/message': {
        const text = contentText(data.message?.content)
        if (text !== '') run.assistantText = text
        run.usage.inputTokens += nonNegativeInt(data.usage?.inputTokens)
        run.usage.outputTokens += nonNegativeInt(data.usage?.outputTokens)
        break
      }
      case 'tool/call':
        run.toolCalls += 1
        if (typeof data.name === 'string' && !run.toolNames.includes(data.name)) run.toolNames.push(data.name)
        break
      case 'turn/end':
        run.reason = data.reason ?? run.reason
        break
      case 'request/header': {
        const model = data.header?.config?.model
        if (typeof model === 'string') run.model = model
        break
      }
      case 'session/title':
        break
      default:
        break
    }
    if (event.type === 'user/message' || event.type === 'session/title') {
      scheduleStartRefresh(run, session)
    }
  }

  /**
   * @param {any} agent
   * @returns {Run | undefined}
   */
  function ensureRun(agent) {
    const sessionId = agent.id
    if (typeof sessionId !== 'string') return undefined
    const existing = runs.get(sessionId)
    if (existing !== undefined) return existing
    /** @type {Run} */
    const run = {
      // Must be unique across Host restarts: it feeds lark-cli's
      // idempotency key, and Lark reuses the same key's message for an hour.
      id: newId(),
      sessionId,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      lastTurn: 0,
      userText: '',
      assistantText: '',
      toolCalls: 0,
      toolNames: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      reason: undefined,
      model: '',
      startSent: false,
      endSent: false,
      startMessageId: undefined,
      startRefreshTimer: undefined,
    }
    runs.set(sessionId, run)
    registry.rememberLast(sessionId)
    return run
  }

  /** @param {Run} run */
  function clearStartRefresh(run) {
    if (run.startRefreshTimer !== undefined) {
      clearTimeout(run.startRefreshTimer)
      run.startRefreshTimer = undefined
    }
  }

  /**
   * Patch the already-sent start card after the user prompt or Session title
   * arrives. Both are usually committed a moment after `agent/status=running`,
   * which is why the initial card can legitimately show the goal-continuation
   * placeholder.
   * @param {Run} run
   * @param {any} session
   * @param {number} [delay]
   */
  function scheduleStartRefresh(run, session, delay = 250) {
    if (disposed || run.startMessageId === undefined || run.startRefreshTimer !== undefined) return
    const timer = setTimeout(() => {
      run.startRefreshTimer = undefined
      void patchStart(run, session).catch((error) =>
        logger.warn(`[lark] start card refresh failed: ${String(error)}`),
      )
    }, delay)
    timer.unref?.()
    run.startRefreshTimer = timer
  }

  /** @param {Run} run @param {any} session */
  async function patchStart(run, session) {
    if (disposed || run.startMessageId === undefined) return
    const code = registry.ensureCode(run.sessionId)
    const title = await titleOf(session)
    const card = fitCard(
      buildStartCard({
        code,
        title,
        prompt: run.userText,
        cwd: session.header?.cwd,
        workspace: workspaceLine(session.header?.cwd, config),
        model: run.model,
        sessionId: run.sessionId,
      }),
    )
    await transport.patchCard(run.startMessageId, card)
  }

  /** @param {Run} run @param {any} session */
  function scheduleStart(run, session) {
    if (run.startSent || startTimers.has(run.sessionId)) return
    const timer = setTimeout(() => {
      startTimers.delete(run.sessionId)
      void sendStart(run, session).catch((error) => logger.warn(`[lark] start card failed: ${String(error)}`))
    }, 800)
    timer.unref?.()
    startTimers.set(run.sessionId, timer)
  }

  /** @param {Run} run @param {any} session */
  /** @returns {boolean} */
  function archiveConfigured() {
    return isArchiveConfigured(config, store)
  }

  async function sendStart(run, session) {
    if (run.startSent || disposed) return
    run.startSent = true
    if (store.pushLevel() < 2 || !config.notifySessionStart) return
    const code = registry.ensureCode(run.sessionId)
    const title = await titleOf(session)
    const card = fitCard(
      buildStartCard({
        code,
        title,
        prompt: run.userText,
        cwd: session.header?.cwd,
        workspace: workspaceLine(session.header?.cwd, config),
        model: run.model,
        sessionId: run.sessionId,
      }),
    )
    const result = await transport.sendCard(card, {
      idempotencyKey: `start:${run.sessionId}:${run.id}`,
    })
    if (result.messageId) {
      run.startMessageId = result.messageId
      registry.link(run.sessionId, result.messageId, { kind: 'start' })
      // Covers the race where the prompt/title event arrived while the card
      // was being sent (before `startMessageId` existed).
      scheduleStartRefresh(run, session, 500)
    }
    logger.info(`[lark] start card sent for ${code}${title ? ` (${truncate(title, 40)})` : ''}`)
  }

  async function sendTurnImages(images) {
    if (!Array.isArray(images) || images.length === 0) return
    const attachments = ctx.get('attachments')
    if (attachments === undefined || typeof attachments.readImage !== 'function') return
    const chatId = transport.targetChatId
    if (typeof chatId !== 'string' || chatId === '') return
    for (const ref of images.slice(0, 4)) {
      let stored
      try {
        stored = await attachments.readImage(ref)
      } catch (error) {
        logger.warn(`[lark] image read failed: ${String(error)}`)
        continue
      }
      const ext = typeof stored?.ref?.mediaType === 'string' && stored.ref.mediaType.includes('jpeg') ? 'jpg' : 'png'
      const rel = `.lark-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      try {
        writeFileSync(rel, Buffer.from(stored.data))
        await transport.sendImage(chatId, rel)
      } catch (error) {
        logger.warn(`[lark] image send failed: ${String(error)}`)
      } finally {
        try { rmSync(rel, { force: true }) } catch { /* best effort */ }
      }
    }
  }


  /** @param {any} agent */
  function scheduleEnd(agent) {
    const sessionId = agent.id
    cancelEndTimer(sessionId)
    let checks = 0
    const arm = () => {
      const timer = setTimeout(() => {
        endTimers.delete(sessionId)
        void finishIfIdle(agent, ++checks).catch((error) => logger.warn(`[lark] end card failed: ${String(error)}`))
      }, config.idleGraceMs)
      timer.unref?.()
      endTimers.set(sessionId, timer)
    }
    arm()
  }

  /**
   * @param {any} agent
   * @param {number} checks
   */
  async function finishIfIdle(agent, checks) {
    if (disposed) return
    const sessionId = agent.id
    const live = ctx.agents.get(sessionId)
    if (live === undefined || live.status !== 'idle') return
    const queued = queuedCount(live)
    if (queued > 0 && checks < 10) {
      // A queued follow-up is about to open a new turn. Keep the run open and
      // check again shortly; a `running` status cancels this timer anyway.
      const timer = setTimeout(() => {
        endTimers.delete(sessionId)
        void finishIfIdle(agent, checks + 1).catch((error) => logger.warn(`[lark] end card failed: ${String(error)}`))
      }, 1000)
      timer.unref?.()
      endTimers.set(sessionId, timer)
      return
    }
    const run = runs.get(sessionId)
    if (run === undefined) return
    if (run.endSent) return
    const pendingStart = startTimers.get(sessionId)
    if (pendingStart !== undefined) {
      clearTimeout(pendingStart)
      startTimers.delete(sessionId)
    }
    run.endSent = true
    clearStartRefresh(run)
    runs.delete(sessionId)
    if (store.pushLevel() < 2 || !config.notifySessionEnd) return

    const session = live.session
    const code = registry.ensureCode(sessionId)
    const title = await titleOf(session)
    const summary = summarizeRun({
      session,
      title,
      run,
      maxChars: config.summaryMaxChars,
    })
    const status = statusOf({
      reason: summary.reason,
      pendingQuestion: hasPendingQuestion(session),
      toolErrors: summary.toolErrors,
      toolCalls: summary.toolCalls,
    })
    const card = fitCard(
      buildEndCard({
        code,
        title,
        workspace: workspaceLine(summary.cwd, config),
        tone: status.tone,
        summary: summary.assistantText,
        summaryFull: summary.assistantFull,
        fullTruncated: summary.fullTruncated,
        imagesOmitted: summary.imagesOmitted,
        imageCount: Array.isArray(summary.images) ? summary.images.length : 0,
        userText: summary.userText,
        reasonText: status.text,
        failed: isErrorReason(summary.reason),
        errorMessage: summary.errorMessage,
        durationText: summary.durationText,
        toolCalls: summary.toolCalls,
        toolNames: summary.toolNames,
        usage: summary.usage,
        model: summary.model,
        sessionId,
        turn: run.lastTurn > 0 ? run.lastTurn : undefined,
        archiveable: archiveConfigured() && summary.truncated === true,
      }),
    )
    try {
      const result = await transport.sendCard(card, {
        idempotencyKey: `end:${sessionId}:${run.id}`,
      })
      if (result.messageId) {
        registry.link(sessionId, result.messageId, { kind: 'end' })
      }
      void sendTurnImages(summary.images)
      if (true) {
      }
      logger.info(`[lark] end card sent for ${code} (${status.text}, ${summary.durationText})`)
    } catch (error) {
      // A rejected card shape must not lose the completion notice: fall back
      // to a plain-text summary.
      logger.warn(`[lark] end card failed, using text fallback: ${String(error)}`)
      try {
        await transport.sendText(
          `#${code} ${status.text} · ${title || '会话'}\n` +
          `耗时 ${summary.durationText} · 工具 ${summary.toolCalls} 次 · ` +
          `tokens ${summary.usage.inputTokens}/${summary.usage.outputTokens}\n\n` +
          truncate(stripImages(summary.assistantText) || '（本轮没有可展示的回复）', 1200),
          { idempotencyKey: `endtext:${sessionId}:${run.id}` },
        )
      } catch (fallbackError) {
        logger.warn(`[lark] end text fallback failed: ${String(fallbackError)}`)
      }
    }
  }

  /** @param {string} sessionId */
  function cancelEndTimer(sessionId) {
    const timer = endTimers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      endTimers.delete(sessionId)
    }
  }

  /** @param {any} session */
  function shouldSkip(session) {
    if (config.includeSubagents) return false
    return session?.header?.origin === 'subagent'
  }

  /**
   * Whether the session is parked on an unanswered question, so the card can
   * say "waiting for you" instead of "completed".
   * @param {any} session
   * @returns {boolean}
   */
  function hasPendingQuestion(session) {
    try {
      const state = ctx.sessionProjections?.stateOf?.(session, 'userQuestions')
      const active = state?.questions?.active
      return Array.isArray(active) && active.length > 0
    } catch {
      return false
    }
  }

  /** @param {any} agent */
  function queuedCount(agent) {
    try {
      return (agent.inbox?.nextTurn?.length ?? 0) + (agent.inbox?.nextStep?.length ?? 0)
    } catch {
      return 0
    }
  }

  /** @param {any} session */
  async function titleOf(session) {
    try {
      const value = ctx.sessionProjections?.snapshot?.(session)?.values?.title
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    } catch {
      // fall through to the list row
    }
    const row = await registry.describe(session.id)
    return row?.title?.trim() ?? ''
  }

  return {
    register,
    /** @param {string} sessionId */
    activeRun(sessionId) {
      return runs.get(sessionId)
    },
    /** @param {string} sessionId */
    cancel(sessionId) {
      cancelEndTimer(sessionId)
      const startTimer = startTimers.get(sessionId)
      if (startTimer !== undefined) {
        clearTimeout(startTimer)
        startTimers.delete(sessionId)
      }
      const run = runs.get(sessionId)
      if (run !== undefined) clearStartRefresh(run)
      runs.delete(sessionId)
    },
  }
}
