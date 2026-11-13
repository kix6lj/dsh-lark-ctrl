/**
 * `/btw`: a deterministic status snapshot plus an optional natural-language
 * side question delegated to the installed `dsh-btw` plugin.
 *
 * `dsh-btw` registers `POST /api/btw.ask` in the Host's `ctx.connection`
 * Fetch-route table. A Host plugin can dispatch that exact route through
 * `connection.createSharedFetchHandler('/api')` without going through the
 * browser/HTTP admission fence. When the route is absent (plugin not
 * installed, or its contract changed) `/btw` degrades to the snapshot.
 */

import { foldTurnStats } from './summary.js'
import { contentText, formatDuration, formatTime, nonNegativeInt, stripImages, truncate } from './util.js'

const AVAILABILITY_TTL_MS = 60000

/**
 * Extract the user/assistant text of a session's events.
 * @param {ReadonlyArray<Record<string, any>>} events
 * @param {number} perMessageMax
 * @returns {Array<{ role: 'user' | 'assistant', text: string, at: number }>}
 */
export function messagesFrom(events, perMessageMax = 2000) {
  const rows = []
  const push = (role, content, at) => {
    const text = stripImages(contentText(content)).trim()
    const images = imagesOf(content)
    if (text === '' && images.length === 0) return
    const label = text !== '' ? truncate(text, perMessageMax) : (images.length === 1 ? '📷 一张图片' : '📷 ' + images.length + ' 张图片')
    rows.push({ role, text: label, at, images })
  }
  for (const event of events) {
    if (event?.type === 'user/message') {
      const source = event.data?.source?.kind
      if (source !== undefined && source !== 'user') continue
      push('user', event.data?.content, nonNegativeInt(event.time))
    } else if (event?.type === 'assistant/message') {
      push('assistant', event.data?.message?.content, nonNegativeInt(event.time))
    }
  }
  return rows
}

/**
 * Image attachment refs inside a content block array.
 * @param {unknown} content
 * @returns {Array<Record<string, any>>}
 */
export function imagesOf(content) {
  if (!Array.isArray(content)) return []
  return content.filter((block) => block?.type === 'image' && block.attachment !== undefined).map((block) => block.attachment)
}

/**
 * @param {object} deps
 * @param {import('@deepseek-ai/cordis').Context} deps.ctx
 * @param {ReturnType<import('./config.js').normalizeConfig>} deps.config
 * @param {ReturnType<import('./registry.js').createRegistry>} deps.registry
 * @param {{ info: Function, warn: Function, debug: Function }} deps.logger
 */
export function createBtw({ ctx, config, registry, logger }) {
  /** @type {{ at: number, available: boolean, reason: string } | undefined} */
  let availability
  /** @type {any} */
  let localPeer

  /**
   * Probe (and cache) whether the dsh-btw route is dispatchable.
   * @param {boolean} [force]
   * @returns {Promise<{ available: boolean, reason: string }>}
   */
  async function checkAvailable(force = false) {
    if (config.btwMode === 'off') return { available: false, reason: 'btwMode=off' }
    if (config.btwMode === 'snapshot') return { available: false, reason: 'btwMode=snapshot' }
    if (!force && availability !== undefined && Date.now() - availability.at < AVAILABILITY_TTL_MS) {
      return { available: availability.available, reason: availability.reason }
    }
    const dispatch = sharedDispatch()
    if (dispatch === undefined) {
      availability = { at: Date.now(), available: false, reason: 'ctx.connection 不可用' }
      return availability
    }
    const metaRoute = metaRouteOf(config.btwRoute)
    if (metaRoute === '') {
      availability = { at: Date.now(), available: false, reason: '无法推导 btw 探活路由' }
      return availability
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const response = await dispatch.handler.fetch(
        new Request(`http://dsh-lark-ctrl.local${metaRoute}`, {
          method: 'GET',
          signal: controller.signal,
        }),
        dispatch.peer,
      )
      const available = response.ok
      availability = {
        at: Date.now(),
        available,
        reason: available ? '' : `dsh-btw ${metaRoute} 返回 ${response.status}`,
      }
      return availability
    } catch (error) {
      availability = { at: Date.now(), available: false, reason: `dsh-btw 探活失败：${String(error)}` }
      return availability
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<{ code: string, sessionId: string, title: string, running: boolean, statusText: string, lastUser: string, lastAssistant: string, tools: string[], pending: number, queued: number, model: string, cwd?: string, elapsed?: string }>}
   */
  /**
   * Read a session's events: the live snapshot when attached, storage otherwise.
   * @param {string} sessionId
   * @returns {Promise<{ events: ReadonlyArray<Record<string, any>>, header: any }>}
   */
  async function loadEvents(sessionId) {
    const live = ctx.sessions.get(sessionId)
    if (live !== undefined) return { events: live.snapshotEvents(), header: live.header }
    try {
      if (ctx.sessionQuery?.readSession !== undefined) {
        const snap = await ctx.sessionQuery.readSession(sessionId)
        return { events: snap.events ?? [], header: snap.session }
      }
      const inspection = await ctx.sessionController.inspect(sessionId)
      return { events: inspection?.events ?? [], header: inspection?.meta }
    } catch (error) {
      logger.warn(`[lark] session read failed: ${String(error)}`)
      return { events: [], header: undefined }
    }
  }

  /**
   * The most recent messages of a session, newest last. Backs the history list.
   * @param {string} sessionId
   * @param {number} [limit]
   * @returns {Promise<Array<{ role: 'user' | 'assistant', text: string, at: number }>>}
   */
  async function history(sessionId, limit = 12) {
    const { events } = await loadEvents(sessionId)
    // Newest first: the history list reads top-down from the latest message.
    return messagesFrom(events.slice(-800)).slice(-limit).reverse()
  }

  async function snapshot(sessionId) {
    const row = await registry.describe(sessionId)
    const code = registry.ensureCode(sessionId)
    const live = ctx.sessions.get(sessionId)
    const agent = ctx.agents.get(sessionId)
    const { events, header } = await loadEvents(sessionId)
    const stats = foldTurnStats(events)
    const running = row?.running === true || agent?.status === 'running'
    const openTurn = running ? events.findLast?.((event) => event.type === 'turn/start') : undefined
    const elapsed = running && openTurn?.time
      ? formatDuration(Date.now() - openTurn.time)
      : undefined
    const pending = pendingQuestionCount(live)
    return {
      code,
      sessionId,
      title: row?.title || '',
      running,
      statusText: running ? '运行中' : '空闲',
      lastUser: truncate(stats.userText, 600),
      lastAssistant: truncate(stats.assistantText, 1200),
      history: messagesFrom(events.slice(-600), 240).slice(-8),
      tools: stats.toolNames.slice(0, 8),
      pending,
      queued: queuedCount(agent),
      model: modelOf(live, events),
      cwd: typeof header?.cwd === 'string' ? header.cwd : row?.cwd,
      elapsed,
      lastActivity: formatTime(nonNegativeInt(events.at(-1)?.time)),
    }
  }

  /**
   * Ask dsh-btw a side question.
   * @param {string} sessionId
   * @param {string} question
   * @param {AbortSignal} [outerSignal]
   * @returns {Promise<{ ok: true, answer: string, model?: string, finish?: string } | { ok: false, unavailable?: boolean, busy?: boolean, message: string }>}
   */
  async function ask(sessionId, question, outerSignal) {
    const text = String(question ?? '').trim()
    if (text === '') return { ok: false, message: '问题为空。' }
    if (text.length > 4000) return { ok: false, message: '问题过长（上限 4000 字）。' }
    if (config.btwMode === 'off') return { ok: false, message: 'btw 已关闭。' }
    if (config.btwMode === 'snapshot') {
      return { ok: false, unavailable: true, message: '当前 btwMode=snapshot，只提供状态快照。' }
    }

    const probe = await checkAvailable()
    if (!probe.available) {
      return { ok: false, unavailable: true, message: probe.reason || '未安装 dsh-btw。' }
    }
    const dispatch = sharedDispatch()
    if (dispatch === undefined) {
      return { ok: false, unavailable: true, message: 'ctx.connection 不可用。' }
    }

    // dsh-btw only answers for a live Session; resuming a cold one is enough.
    let resumed
    try {
      resumed = await ctx.sessionController.resolveAgent(sessionId)
    } catch (error) {
      return { ok: false, message: `会话无法恢复为 live：${String(error)}` }
    }
    if (resumed?.agent === undefined) {
      return { ok: false, message: '会话无法恢复为 live，暂时不能旁问。' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('btw timeout')), config.btwTimeoutMs)
    const signal = outerSignal === undefined ? controller.signal : AbortSignal.any([outerSignal, controller.signal])
    try {
      const response = await dispatch.handler.fetch(
        new Request(`http://dsh-lark-ctrl.local${config.btwRoute}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, question: text }),
          signal,
        }),
        dispatch.peer,
      )
      if (response.status === 404 || response.status === 405) {
        availability = { at: Date.now(), available: false, reason: `dsh-btw ${config.btwRoute} 返回 ${response.status}` }
        return { ok: false, unavailable: true, message: '未找到 dsh-btw 的旁问路由。' }
      }
      if (response.status === 409) {
        return { ok: false, busy: true, message: '该会话已有一个旁问在进行，请稍后再试。' }
      }
      if (!response.ok) {
        const body = await safeJson(response)
        return { ok: false, message: body?.error?.message ?? `dsh-btw 返回 ${response.status}` }
      }
      return await readSse(response, signal)
    } catch (error) {
      const message = controller.signal.aborted ? '旁问超时。' : `旁问失败：${String(error)}`
      return { ok: false, message }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * @param {Response} response
   * @param {AbortSignal} signal
   */
  async function readSse(response, signal) {
    if (response.body === null) return { ok: false, message: 'dsh-btw 返回了空响应。' }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let answer = ''
    let model = ''
    try {
      while (true) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        if (done === true) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
          const line = chunk
            .split('\n')
            .map((item) => item.trim())
            .filter((item) => item.startsWith('data:'))
            .map((item) => item.slice(5).trim())
            .join('')
          if (line === '') continue
          let event
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }
          if (event?.type === 'start' && typeof event.entry?.model === 'string') model = event.entry.model
          if (event?.type === 'delta' && typeof event.text === 'string') answer += event.text
          if (event?.type === 'done') {
            const entry = event.entry ?? {}
            const final = typeof entry.answer === 'string' && entry.answer !== '' ? entry.answer : answer
            return {
              ok: true,
              answer: final,
              model: typeof entry.model === 'string' ? entry.model : model,
              finish: typeof entry.finish === 'string' ? entry.finish : undefined,
            }
          }
          if (event?.type === 'error') {
            return { ok: false, message: event.error?.message ?? 'dsh-btw 生成失败。' }
          }
        }
      }
      if (answer !== '') return { ok: true, answer, model }
      return { ok: false, message: 'dsh-btw 没有返回内容。' }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // ignore
      }
    }
  }

  /**
   * Resolve the shared Fetch handler and the Host-local Peer it must dispatch
   * as. DSH 0.2.1-rc.5 changed `ConnectionFetchHandler.fetch` from
   * `fetch(request)` to `fetch(request, peer)`, and the handler dereferences
   * `peer.principal` before routing. Create one owner Peer for this plugin and
   * cache it; older 0.2.x handlers that ignore the second argument keep working.
   * @returns {{ handler: any, peer: any } | undefined}
   */
  function sharedDispatch() {
    try {
      const connection = ctx.get('connection')
      if (connection?.createSharedFetchHandler === undefined) return undefined
      if (localPeer === undefined) {
        if (typeof connection.createPeer === 'function') {
          localPeer = connection.createPeer({
            principal: { kind: 'owner' },
            interactions: 'none',
          })
        } else if (connection.browserPeer !== undefined) {
          localPeer = connection.browserPeer
        }
      }
      if (localPeer === undefined) return undefined
      return {
        handler: connection.createSharedFetchHandler('/api'),
        peer: localPeer,
      }
    } catch (error) {
      logger.warn(`[lark] cannot create connection peer: ${String(error)}`)
      return undefined
    }
  }

  /** @param {any} liveSession */
  function pendingQuestionCount(liveSession) {
    if (liveSession === undefined) return 0
    try {
      const state = ctx.sessionProjections?.stateOf?.(liveSession, 'userQuestions')
      const active = state?.questions?.active
      if (Array.isArray(active)) return active.length
      const view = ctx.sessionProjections?.snapshot?.(liveSession)?.values?.userQuestions
      return Array.isArray(view?.active) ? view.active.length : 0
    } catch {
      return 0
    }
  }

  /** @param {any} agent */
  function queuedCount(agent) {
    try {
      return (agent?.inbox?.nextTurn?.length ?? 0) + (agent?.inbox?.nextStep?.length ?? 0)
    } catch {
      return 0
    }
  }

  /** @param {any} liveSession @param {ReadonlyArray<any>} events */
  function modelOf(liveSession, events) {
    try {
      const context = liveSession?.requestContext?.()
      if (typeof context?.model === 'string') return context.model
    } catch {
      // ignore
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'request/header' && typeof event.data?.header?.config?.model === 'string') {
        return event.data.header.config.model
      }
    }
    return ''
  }

  return {
    checkAvailable,
    snapshot,
    history,
    ask,
    /** Invalidated by tests and after a failed route call. */
    resetAvailability() {
      availability = undefined
    },
  }
}

/** @param {string} route */
function metaRouteOf(route) {
  if (typeof route !== 'string') return ''
  if (route.endsWith('.ask')) return `${route.slice(0, -4)}.meta`
  return ''
}

/** @param {Response} response */
async function safeJson(response) {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}
