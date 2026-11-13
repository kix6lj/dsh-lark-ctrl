/**
 * Outbound transport: resolves the destination, serializes sends, retries
 * transient failures, and keeps lark-cli's idempotency key short.
 */

import { delay } from './util.js'

/**
 * @param {object} deps
 * @param {ReturnType<import('./config.js').normalizeConfig>} deps.config
 * @param {ReturnType<import('./lark-cli.js').createLarkCli>} deps.cli
 * @param {{ info: Function, warn: Function, debug: Function }} deps.logger
 */
export function createTransport({ config, cli, logger }) {
  let targetUserId = config.targetUserId
  let targetChatId = config.targetChatId
  let userName = ''
  let allowed = new Set(config.allowUsers)
  let tail = Promise.resolve()
  let closed = false

  /**
   * @param {Awaited<ReturnType<typeof cli.status>>} status
   */
  function initialize(status) {
    userName = status.userName
    if (targetChatId === '') targetChatId = config.targetChatId
    if (targetUserId === '') targetUserId = config.targetUserId || status.userOpenId
    if (allowed.size === 0 && targetUserId !== '') allowed = new Set([targetUserId])
    return {
      targetUserId,
      targetChatId,
      userName,
      allowedUsers: [...allowed],
    }
  }

  /** @param {string | undefined} openId */
  function isAllowed(openId) {
    return typeof openId === 'string' && allowed.has(openId)
  }

  /** @returns {string} */
  function targetLabel() {
    if (targetChatId !== '') return targetChatId
    return targetUserId || '（未配置）'
  }

  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  function enqueue(operation) {
    if (closed) return Promise.reject(new Error('transport is closed'))
    const result = tail.then(operation, operation)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * @param {() => Promise<any>} operation
   * @param {{ attempts?: number, label?: string }} [options]
   */
  async function withRetry(operation, options = {}) {
    const attempts = options.attempts ?? 2
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        lastError = error
        const retryable = isRetryable(error)
        if (!retryable || attempt === attempts) break
        logger.warn(`[lark] ${options.label ?? 'send'}: attempt ${attempt} failed (${error.code ?? 'error'}); retrying`)
        await delay(500 * attempt)
      }
    }
    throw lastError
  }

  /**
   * @param {Record<string, unknown>} card
   * @param {{ idempotencyKey?: string, replyToMessageId?: string, thread?: boolean }} [options]
   */
  async function sendCard(card, options = {}) {
    if (targetChatId === '' && targetUserId === '') {
      throw new Error('no Lark target: set targetUserId/targetChatId or log in with lark-cli')
    }
    return enqueue(() =>
      withRetry(
        () =>
          cli.sendCard({
            card,
            chatId: targetChatId || undefined,
            userId: targetChatId ? undefined : targetUserId,
            replyToMessageId: options.replyToMessageId,
            thread: options.thread,
            idempotencyKey: options.idempotencyKey,
          }),
        { label: 'sendCard' },
      ),
    )
  }

  /**
   * @param {string} text
   * @param {{ markdown?: boolean, replyToMessageId?: string, thread?: boolean, idempotencyKey?: string }} [options]
   */
  async function sendText(text, options = {}) {
    if (targetChatId === '' && targetUserId === '') {
      throw new Error('no Lark target: set targetUserId/targetChatId or log in with lark-cli')
    }
    return enqueue(() =>
      withRetry(
        () =>
          cli.sendText({
            text,
            markdown: options.markdown,
            chatId: targetChatId || undefined,
            userId: targetChatId ? undefined : targetUserId,
            replyToMessageId: options.replyToMessageId,
            thread: options.thread,
            idempotencyKey: options.idempotencyKey,
          }),
        { label: 'sendText' },
      ),
    )
  }

  /**
   * @param {string} messageId
   * @param {Record<string, unknown>} card
   */
  async function patchCard(messageId, card) {
    return enqueue(() =>
      withRetry(() => cli.patchCard(messageId, card), { label: 'patchCard', attempts: 1 }),
    )
  }

  /** @param {string} messageId */
  async function react(messageId, emoji = 'OK') {
    try {
      return await enqueue(() => withRetry(() => cli.addReaction(messageId, emoji), { attempts: 1 }))
    } catch (error) {
      logger.debug?.(`[lark] reaction failed: ${String(error)}`)
      return false
    }
  }

  /**
   * Raw content of one message (image messages only carry their key there).
   * @param {string} messageId
   * @returns {Promise<string | undefined>}
   */
  async function fetchMessageContent(messageId) {
    return cli.fetchMessageContent(messageId)
  }

  /**
   * Bytes of an inbound image/file resource.
   * @param {string} messageId
   * @param {string} fileKey
   * @returns {Promise<Uint8Array | undefined>}
   */
  async function downloadResource(messageId, fileKey) {
    return cli.downloadResource(messageId, fileKey, 'image')
  }

  /**
   * Send a local image file (path relative to the host cwd).
   * @param {string} chatId
   * @param {string} relPath
   */
  async function sendImage(chatId, relPath) {
    return cli.sendImage(chatId, relPath)
  }

  return {
    initialize,
    sendImage,
    isAllowed,
    targetLabel,
    sendCard,
    sendText,
    patchCard,
    react,
    fetchMessageContent,
    downloadResource,
    get targetUserId() {
      return targetUserId
    },
    get targetChatId() {
      return targetChatId
    },
    get userName() {
      return userName
    },
    get allowedUsers() {
      return [...allowed]
    },
    close() {
      closed = true
    },
  }
}

/** @param {unknown} error */
function isRetryable(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'no-target') return false
  if (code === 'spawn-failed') return false
  // Lark's rate limit / transient network failures are worth one more try.
  if (code.includes('rate_limit') || code.includes('too_many') || code.includes('timeout')) return true
  if (code.includes('network') || code.includes('internal')) return true
  return false
}
