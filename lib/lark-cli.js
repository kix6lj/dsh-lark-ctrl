/**
 * Thin, promise-based wrapper around the lark-cli binary.
 *
 * Outbound calls use `execFile` (short-lived, buffered). Inbound events use
 * `spawn` because `event consume` is a long-running NDJSON stream that must
 * keep its stdin open.
 */

import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

import { isRecord, parseJson, sha1, truncate } from './util.js'

const execFileAsync = promisify(execFile)
const EXEC_TIMEOUT_MS = 30000
const MAX_BUFFER = 16 * 1024 * 1024

export class LarkCliError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, subtype?: string, hint?: string, stdout?: string, stderr?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'LarkCliError'
    this.code = details.code ?? 'lark-cli-error'
    this.subtype = details.subtype
    this.hint = details.hint
    this.stdout = details.stdout
    this.stderr = details.stderr
  }
}

/**
 * @param {ReturnType<import('./config.js').normalizeConfig>} config
 * @param {{ info: Function, warn: Function, debug: Function }} logger
 */
export function createLarkCli(config, logger) {
  const binary = config.larkCli

  /**
   * @param {string[]} args
   * @param {{ timeout?: number, allowFailure?: boolean, cwd?: string }} [options]
   */
  async function run(args, options = {}) {
    const started = Date.now()
    try {
      const { stdout, stderr } = await execFileAsync(binary, args, {
        timeout: options.timeout ?? EXEC_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        env: process.env,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      })
      if (config.debug) {
        logger.debug(`[lark] ${args[0]} ${args[1] ?? ''} (${Date.now() - started}ms)`)
      }
      return { json: parseEnvelope(stdout), stdout, stderr }
    } catch (error) {
      const stdout = typeof error.stdout === 'string' ? error.stdout : ''
      const stderr = typeof error.stderr === 'string' ? error.stderr : ''
      const envelope = parseEnvelope(stderr) ?? parseEnvelope(stdout)
      const failure = failureOf(envelope)
      const message = failure?.message ?? error.message ?? 'lark-cli failed'
      if (options.allowFailure === true) {
        return { json: envelope ?? {}, stdout, stderr, failure }
      }
      throw new LarkCliError(message, {
        code: failure?.subtype ?? failure?.type ?? error.code ?? 'lark-cli-error',
        subtype: failure?.subtype,
        hint: failure?.hint,
        stdout,
        stderr,
      })
    }
  }

  /** Verify the binary exists and the configured identity is usable. */
  async function status() {
    const version = await run(['--version'], { timeout: 10000 })
    const auth = await run(['auth', 'status', '--json'], { timeout: 15000 })
    const json = auth.json
    const user = isRecord(json?.identities?.user) ? json.identities.user : undefined
    const bot = isRecord(json?.identities?.bot) ? json.identities.bot : undefined
    return {
      version: String(version.stdout ?? '').trim(),
      raw: json,
      appId: typeof json?.appId === 'string' ? json.appId : '',
      userOpenId: typeof user?.openId === 'string' ? user.openId : '',
      userName: typeof user?.userName === 'string' ? user.userName : '',
      userReady: user?.available === true,
      botReady: bot?.available === true,
      identity: typeof json?.identity === 'string' ? json.identity : '',
    }
  }

  /**
   * Raw `content` JSON of one message.
   *
   * `event consume` and `messages-mget` both render message content to
   * human-readable text, so an image message arrives without its `image_key`.
   * The OpenAPI message resource keeps the raw body, which is where the key is.
   * @param {string} messageId
   * @returns {Promise<string | undefined>}
   */
  async function fetchMessageContent(messageId) {
    if (typeof messageId !== 'string' || messageId === '') return undefined
    // A message body can lag its event by a moment; try a few times.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const { json } = await run(['api', 'GET', `/open-apis/im/v1/messages/${messageId}`, '--as', config.identity])
        const content = json?.data?.items?.[0]?.body?.content
        if (typeof content === 'string' && content !== '') return content
      } catch (error) {
        logger.warn(`[lark] message fetch failed: ${String(error)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 600))
    }
    return undefined
  }

  /**
   * Download the image/file resource of one message.
   *
   * lark-cli only writes below cwd, /tmp or ~/files, so the command runs inside
   * a throwaway directory and the bytes are read back from there.
   * @param {string} messageId
   * @param {string} fileKey
   * @param {'image' | 'file'} [type]
   * @returns {Promise<Uint8Array | undefined>}
   */
  async function downloadResource(messageId, fileKey, type = 'image') {
    if (typeof messageId !== 'string' || messageId === '') return undefined
    if (typeof fileKey !== 'string' || fileKey === '') return undefined
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lark-res-'))
    const name = 'resource.bin'
    try {
      await run(
        ['im', '+messages-resources-download', '--as', config.identity,
          '--message-id', messageId, '--file-key', fileKey, '--type', type, '--output', name],
        { cwd: dir, timeout: 60000 },
      )
      return new Uint8Array(readFileSync(join(dir, name)))
    } catch (error) {
      logger.warn(`[lark] resource download failed: ${String(error)}`)
      return undefined
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  /**
   * [本地补丁] 发一张本地图片（CLI 自动上传，路径必须相对 cwd）。
   * @param {string} chatId
   * @param {string} relPath
   * @returns {Promise<{ messageId: string, chatId: string }>}
   */
  async function sendImage(chatId, relPath) {
    const { json } = await run(['im', '+messages-send', '--as', config.identity, '--chat-id', chatId, '--image', relPath], { timeout: 60000 })
    return resultOfMessage(json)
  }
  /**
   * @param {object} input
   * @param {Record<string, unknown>} input.card
   * @param {string} [input.userId]
   * @param {string} [input.chatId]
   * @param {string} [input.replyToMessageId]
   * @param {boolean} [input.thread]
   * @param {string} [input.idempotencyKey]
   */
  async function sendCard(input) {
    const args = ['im']
    if (input.replyToMessageId !== undefined) {
      args.push('+messages-reply', '--as', config.identity, '--message-id', input.replyToMessageId)
      if (input.thread === true) args.push('--reply-in-thread')
    } else {
      args.push('+messages-send', '--as', config.identity)
      if (input.chatId) args.push('--chat-id', input.chatId)
      else if (input.userId) args.push('--user-id', input.userId)
      else throw new LarkCliError('no Lark target configured', { code: 'no-target' })
    }
    args.push('--msg-type', 'interactive', '--content', JSON.stringify(input.card))
    if (input.idempotencyKey) args.push('--idempotency-key', idempotencyKey(input.idempotencyKey))
    const { json } = await run(args)
    return resultOfMessage(json)
  }

  /**
   * @param {object} input
   * @param {string} input.text
   * @param {boolean} [input.markdown]
   * @param {string} [input.userId]
   * @param {string} [input.chatId]
   * @param {string} [input.replyToMessageId]
   * @param {boolean} [input.thread]
   * @param {string} [input.idempotencyKey]
   */
  async function sendText(input) {
    const args = ['im']
    if (input.replyToMessageId !== undefined) {
      args.push('+messages-reply', '--as', config.identity, '--message-id', input.replyToMessageId)
      if (input.thread === true) args.push('--reply-in-thread')
    } else {
      args.push('+messages-send', '--as', config.identity)
      if (input.chatId) args.push('--chat-id', input.chatId)
      else if (input.userId) args.push('--user-id', input.userId)
      else throw new LarkCliError('no Lark target configured', { code: 'no-target' })
    }
    args.push(input.markdown === true ? '--markdown' : '--text', input.text)
    if (input.idempotencyKey) args.push('--idempotency-key', idempotencyKey(input.idempotencyKey))
    const { json } = await run(args)
    return resultOfMessage(json)
  }

  /**
   * Replace an already-sent interactive card. Works for 14 days and does not
   * consume the 30-minute callback token.
   * @param {string} messageId
   * @param {Record<string, unknown>} card
   */
  async function patchCard(messageId, card) {
    if (!messageId) throw new LarkCliError('cannot patch a card without message_id', { code: 'no-message-id' })
    const data = JSON.stringify({ content: JSON.stringify(card) })
    const { json } = await run(['im', 'messages', 'patch', '--as', config.identity, '--message-id', messageId, '--data', data])
    return json
  }

  /**
   * @param {string} messageId
   * @param {string} emojiType
   */
  async function addReaction(messageId, emojiType = 'OK') {
    if (!messageId) return false
    const data = JSON.stringify({ reaction_type: { emoji_type: emojiType } })
    await run(['im', 'reactions', 'create', '--as', config.identity, '--message-id', messageId, '--data', data])
    return true
  }

  /**
   * Ask lark-cli whether an EventKey can be consumed. Returns the decision and
   * the console hint when a precondition (callback subscription, scope) is
   * missing.
   * @param {string} eventKey
   */
  async function probeEvent(eventKey) {
    const { json } = await run(['event', 'consume', eventKey, '--as', config.identity, '--dry-run'], {
      timeout: 20000,
      allowFailure: true,
    })
    const decision = json?.data?.decision
    if (!isRecord(decision)) {
      return { status: 'unknown', eventKey, hint: undefined, decision: undefined }
    }
    const blocked = Array.isArray(decision.preconditions)
      ? decision.preconditions.find((item) => isRecord(item) && item.status === 'blocked')
      : undefined
    return {
      status: typeof decision.status === 'string' ? decision.status : 'unknown',
      eventKey,
      hint: typeof blocked?.hint === 'string' ? blocked.hint : undefined,
      detail: typeof blocked?.detail === 'string' ? blocked.detail : undefined,
      decision,
    }
  }

  /**
   * Start one long-running consumer. The caller owns restart/backoff; this
   * function only reports lifecycle callbacks.
   *
   * @param {string} eventKey
   * @param {object} handlers
   * @param {(event: Record<string, unknown>) => void | Promise<void>} handlers.onEvent
   * @param {() => void} [handlers.onReady]
   * @param {(failure: { code: number | null, signal: string | null, error?: LarkCliError }) => void} handlers.onExit
   * @param {(line: string) => void} [handlers.onStderr]
   */
  function consume(eventKey, handlers) {
    const child = spawn(binary, ['event', 'consume', eventKey, '--as', config.identity], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let ready = false
    let stopped = false
    let stderrBuffer = ''
    let pendingError

    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity })
    stdout.on('line', (line) => {
      const text = line.trim()
      if (text === '') return
      const event = parseJson(text)
      if (!isRecord(event)) {
        logger.warn(`[lark] ${eventKey}: ignored non-JSON stdout line`)
        return
      }
      try {
        void Promise.resolve(handlers.onEvent(event)).catch((error) => {
          logger.warn(`[lark] ${eventKey}: handler failed: ${String(error)}`)
        })
      } catch (error) {
        logger.warn(`[lark] ${eventKey}: handler failed: ${String(error)}`)
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk
      const lines = stderrBuffer.split('\n')
      stderrBuffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (line === '') continue
        if (!ready && line.includes('[event] ready')) {
          ready = true
          handlers.onReady?.()
        }
        if (line.startsWith('{')) {
          const envelope = parseJson(line)
          const failure = failureOf(envelope)
          if (failure) {
            pendingError = new LarkCliError(failure.message ?? 'event consume failed', {
              code: failure.subtype ?? failure.type ?? 'event-consume-failed',
              subtype: failure.subtype,
              hint: failure.hint,
              stderr: line,
            })
          }
        }
        if (config.debug) logger.debug(`[lark] ${eventKey} stderr: ${truncate(line, 300)}`)
        handlers.onStderr?.(line)
      }
    })

    child.on('error', (error) => {
      pendingError = new LarkCliError(`cannot start lark-cli: ${error.message}`, { code: 'spawn-failed' })
    })

    child.on('exit', (code, signal) => {
      stdout.close()
      if (stopped) return
      handlers.onExit({ code, signal, error: pendingError, ready })
    })

    // Keep stdin open: lark-cli treats EOF as a graceful shutdown signal. The
    // stream is intentionally never ended while the bridge is running.
    child.stdin.on('error', () => {})

    return {
      eventKey,
      get ready() {
        return ready
      },
      stop() {
        if (stopped) return
        stopped = true
        try {
          child.stdin.end()
        } catch {
          // ignore
        }
        try {
          child.kill('SIGTERM')
        } catch {
          // ignore
        }
      },
    }
  }

  return {
    binary,
    run,
    status,
    probeEvent,
    sendCard,
    sendText,
    patchCard,
    addReaction,
    consume,
    downloadResource,
    fetchMessageContent,
    sendImage,
  }
}

/** @param {string} key */
function idempotencyKey(key) {
  // lark-cli caps this at 50 characters; hash long keys.
  return key.length <= 50 ? key : sha1(key, 40)
}

/** @param {string} stdout */
function parseEnvelope(stdout) {
  const text = String(stdout ?? '').trim()
  if (text === '') return undefined
  const whole = parseJson(text)
  if (whole !== undefined) return whole
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseJson(lines[index])
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/** @param {unknown} envelope */
function failureOf(envelope) {
  if (!isRecord(envelope)) return undefined
  if (envelope.ok === false && isRecord(envelope.error)) {
    return {
      type: typeof envelope.error.type === 'string' ? envelope.error.type : undefined,
      subtype: typeof envelope.error.subtype === 'string' ? envelope.error.subtype : undefined,
      message: typeof envelope.error.message === 'string' ? envelope.error.message : 'lark-cli failed',
      hint: typeof envelope.error.hint === 'string' ? envelope.error.hint : undefined,
    }
  }
  return undefined
}

/** @param {unknown} json */
function resultOfMessage(json) {
  const data = isRecord(json?.data) ? json.data : undefined
  const nested = isRecord(data?.data) ? data.data : undefined
  const messageId = firstString(
    data?.message_id,
    nested?.message_id,
    json?.message_id,
    data?.message?.message_id,
  )
  const chatId = firstString(data?.chat_id, nested?.chat_id, json?.chat_id)
  return {
    messageId,
    chatId,
    raw: json,
  }
}

/** @param {...unknown} values */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

export { resultOfMessage, parseEnvelope, failureOf }
