/**
 * Inbound routing: user messages and card actions.
 *
 * Message precedence:
 *   1. a reply to a question/approval card is an answer;
 *   2. a reply to any session notification targets that session;
 *   3. an explicit `#code` prefix targets that session;
 *   4. `/commands` use the replied session, the last session, or an explicit code;
 *   5. bare text uses `defaultTarget` (`last` or `require-hash`).
 */

import {
  buildBtwCard,
  buildCreateSessionCard,
  buildCreateWorkspaceCard,
  buildErrorCard,
  buildArchiveDeletePreviewCard,
  buildArchiveDeleteResultCard,
  buildArchiveResultCard,
  buildArchiveStatusCard,
  buildHelpCard,
  buildHistoryCard,
  buildHelpTopicCard,
  buildNoticeCard,
  buildLevelCard,
  buildSessionCreatedCard,
  buildSessionDetailCard,
  buildSessionsCard,
  buildStatusCard,
  buildWorkspaceDetailCard,
  buildWorkspacesCard,
  fitCard,
  normalizeFormValue,
} from './cards.js'
import {
  applySessionOptions,
  createSessionOnly,
  loadCreationOptions,
  sendSessionPrompt,
} from './session-create.js'
import { applySessionConfig, readSessionConfig, validateConfigChoice } from './session-config.js'
import {
  createWorkspace,
  findWorkspace,
  listGroups,
  listWorkspaceDetail,
  normalizeAbsolutePath,
  WorkspaceUnavailableError,
} from './workspaces.js'
import { appendFileSync } from 'node:fs'
import { findHelpTopic } from './help.js'

import { imageExtensionOf, parseRichContent, sniffImageMediaType } from './image.js'
import { newId, parseSessionRange, quoteLines, stripImages, truncate, formatTime } from './util.js'

const CODE_PATTERN = /^#([a-z2-7]{6,12})\b/i
const COMMAND_PATTERN = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i
const STEER_PREFIX = /^\/steer\b\s*/i

/**
 * @param {object} deps
 * @param {import('@deepseek-ai/cordis').Context} deps.ctx
 * @param {ReturnType<import('./config.js').normalizeConfig>} deps.config
 * @param {ReturnType<import('./registry.js').createRegistry>} deps.registry
 * @param {ReturnType<import('./transport.js').createTransport>} deps.transport
 * @param {ReturnType<import('./answerer.js').createAnswerer>} deps.answerer
 * @param {ReturnType<import('./btw.js').createBtw>} deps.btw
 * @param {ReturnType<import('./archive.js').createArchive>} deps.archive
 * @param {ReturnType<import('./store.js').createStore>} deps.store
 * @param {{ info: Function, warn: Function, debug: Function }} deps.logger
 */
export function createRouter({ ctx, config, registry, transport, answerer, btw, archive, store, logger }) {
  /** @type {Map<string, number[]>} */
  const rate = new Map()
  /** Serialize duplicate form submits for the same creation card. */
  const creationLocks = new Set()
  /** Archive delete confirmations are ephemeral and never persisted. */
  const pendingArchiveDeletes = new Map()
  /** One in-flight archive per card/message; completed archives are idempotent remotely. */
  const archiveInFlight = new Set()

  /** @param {Record<string, any>} event */
  /**
   * An image sent by an operator: fetch its resource, sniff the media type,
   * commit a durable attachment ref and inject an image-block user message.
   *
   * Addressing follows text prompts: the replied notification's session first,
   * then the last session. The model route must accept image input; when it
   * does not, the turn fails and the reason is reported back.
   * @param {Record<string, any>} event
   * @param {string} messageId
   */
  /**
   * An image or rich-text (`post`) message from an operator: fetch the
   * resources, sniff their media types, commit durable attachment refs and
   * inject an image-block user message (with the message's text, when it has
   * any).
   *
   * Addressing follows text prompts: the replied notification's session first,
   * then the last session. The model route must accept image input; when it
   * does not, the turn fails and the reason is reported back.
   * @param {Record<string, any>} event
   * @param {string} messageId
   */
  async function handleImageMessage(event, messageId) {
    // `event.content` is rendered text; the raw body carries the image keys.
    const rawContent = (await transport.fetchMessageContent(messageId)) ?? event.content
    const rich = parseRichContent(rawContent)
    const imageKeys = rich?.imageKeys ?? []
    if (imageKeys.length === 0) {
      await replyText(messageId, '这条消息里没有可下载的图片资源。')
      return
    }
    const replyTo = typeof event.reply_to === 'string' && event.reply_to !== '' ? event.reply_to : undefined
    const rootId = typeof event.root_id === 'string' && event.root_id !== '' ? event.root_id : undefined
    const link = (replyTo !== undefined ? registry.lookup(replyTo) : undefined)
      ?? (rootId !== undefined ? registry.lookup(rootId) : undefined)
    const codeMatch = typeof rich?.text === 'string' ? CODE_PATTERN.exec(rich.text) : null
    let sessionId = link?.sessionId
    if (sessionId === undefined && codeMatch !== null) {
      const resolved = await registry.resolveCode(codeMatch[1])
      if (typeof resolved === 'string' && resolved !== '') sessionId = resolved
    }
    if (sessionId === undefined) sessionId = await registry.lastSession()
    if (typeof sessionId !== 'string' || sessionId === '') {
      await replyText(messageId, '还没有可用的会话；先发一条文本（或 /resume）再发图片。')
      return
    }
    const attachments = ctx.get('attachments')
    if (attachments === undefined || typeof attachments.saveImage !== 'function') {
      await replyText(messageId, '当前 profile 没有附件服务，图片无法进入会话。')
      return
    }
    const maxBytes = attachments.imageLimits?.maxImageBytes
    const blocks = []
    for (const imageKey of imageKeys.slice(0, 4)) {
      const bytes = await transport.downloadResource(messageId, imageKey)
      if (bytes === undefined || bytes.length === 0) {
        await replyText(messageId, '图片下载失败，请重发一次。')
        return
      }
      const mediaType = sniffImageMediaType(bytes)
      if (mediaType === undefined) {
        await replyText(messageId, '不支持的图片格式（仅支持 png / jpeg / webp / gif）。')
        return
      }
      if (typeof maxBytes === 'number' && bytes.length > maxBytes) {
        await replyText(messageId, `图片超过大小上限（约 ${Math.max(1, Math.round(maxBytes / 1024 / 1024))}MB）。`)
        return
      }
      try {
        const ref = await attachments.saveImage({
          data: bytes,
          mediaType,
          name: `feishu-image.${imageExtensionOf(mediaType)}`,
        })
        blocks.push({ type: 'image', attachment: ref })
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error)
        await replyText(messageId, `图片入库失败：${reason.slice(0, 160)}`)
        return
      }
    }
    const rawPrompt = typeof rich?.text === 'string' ? rich.text : ''
    const promptText = codeMatch !== null ? rawPrompt.slice(codeMatch[0].length).trim() : rawPrompt
    const prompt = promptText !== '' ? promptText : '（来自飞书的图片）'
    try {
      await sendSessionPrompt(ctx, sessionId, prompt, newId(), blocks)
    } catch (error) {
      const reason = String(error instanceof Error ? error.message : error)
      logger.warn(`[lark] image prompt failed: ${reason}`)
      await replyText(messageId, reason.includes('image')
        ? `当前模型不支持图片输入：${reason.slice(0, 160)}`
        : `图片注入失败：${reason.slice(0, 160)}`)
      return
    }
    await transport.react(messageId, 'OK')
  }

  async function handleMessage(event) {
    if (event?.sender_type !== 'user') return
    const senderId = typeof event.sender_id === 'string' ? event.sender_id : ''
    if (!transport.isAllowed(senderId)) {
      logger.warn(`[lark] ignored message from unauthorized user ${senderId || '(unknown)'}`)
      return
    }
    if (!chatAllowed(event)) return
    const messageId = typeof event.message_id === 'string' ? event.message_id : typeof event.id === 'string' ? event.id : ''
    if (messageId === '') return
    if (store.rememberEvent(`msg:${messageId}`)) return
    if (!takeRate(senderId)) {
      await replyText(messageId, '操作太频繁，请稍后再试。')
      return
    }
    const messageType = String(event.message_type ?? 'text')
    if (messageType === 'image') {
      await handleImageMessage(event, messageId)
      return
    }
    if (messageType === 'post') {
      const rich = parseRichContent(await transport.fetchMessageContent(messageId))
      if (rich !== undefined && rich.imageKeys.length > 0) {
        await handleImageMessage(event, messageId)
        return
      }
    }
    if (!['text', 'post'].includes(messageType)) {
      await replyText(messageId, '目前只支持文本和图片消息；文件/语音暂未接入。')
      return
    }
    let text = stripMentions(String(event.content ?? ''), event.mentions).trim()
    if (text === '') return

    const replyTo = typeof event.reply_to === 'string' && event.reply_to !== '' ? event.reply_to : undefined
    const rootId = typeof event.root_id === 'string' && event.root_id !== '' ? event.root_id : undefined
    const link = (replyTo !== undefined ? registry.lookup(replyTo) : undefined)
      ?? (rootId !== undefined ? registry.lookup(rootId) : undefined)

    // Group chats are noisy: only act on an explicit directive, a reply to a
    // bridge message, a `#code`, or a `/command`.
    const isGroup = event.chat_type !== 'p2p'
    const hasDirective = CODE_PATTERN.test(text) || COMMAND_PATTERN.test(text) || link !== undefined
    if (isGroup && !hasDirective) return

    // 1. Reply to a question / approval card. A leading `/` or `#` is treated
    // as a command/hash prompt even when it is a reply, so the user can ask
    // `/btw ...` instead of accidentally answering with that text.
    const looksLikeCommand = text.startsWith('/') || CODE_PATTERN.test(text)
    if (link !== undefined && (link.kind === 'question' || link.kind === 'approval') && replyTo !== undefined && !looksLikeCommand) {
      const result = await answerer.answerFromText(replyTo, text, senderId)
      if (result.ok) {
        await transport.react(messageId, 'OK')
        return
      }
      if (result.handled !== false) {
        await replyText(messageId, result.error ?? '无法处理这条回答。')
        return
      }
    }

    // 2. Reply to any session notification.
    if (link !== undefined && replyTo !== undefined) {
      await routeToSession(link.sessionId, text, 'queue', messageId)
      return
    }

    // 3. Explicit `#code`.
    const codeMatch = CODE_PATTERN.exec(text)
    if (codeMatch !== null) {
      const sessionId = await registry.resolveCode(codeMatch[1])
      if (sessionId === undefined) {
        await replyText(messageId, `找不到会话 #${codeMatch[1]}；发送 /sessions 查看最近会话。`)
        return
      }
      const rest = text.slice(codeMatch[0].length).trim()
      await routeExplicit(sessionId, rest, messageId)
      return
    }

    if (text.startsWith('#')) {
      await replyText(messageId, '会话码格式无效；发送 /sessions 查看最近会话。')
      return
    }

    // 4. Commands.
    const commandMatch = COMMAND_PATTERN.exec(text)
    if (commandMatch !== null) {
      await routeCommand(commandMatch[1].toLowerCase(), (commandMatch[2] ?? '').trim(), messageId, link?.sessionId)
      return
    }

    // 5. Bare text.
    if (config.defaultTarget === 'require-hash') {
      await replyText(messageId, '请发送 `#code 内容`，或直接回复某条会话通知。发送 /sessions 查看会话。')
      return
    }
    const last = registry.lastSession()
    if (last === undefined) {
      await replyText(messageId, '还没有可用的会话；先在 DSH 里创建一个会话，或发送 /sessions 查看。')
      return
    }
    await routeToSession(last, text, 'queue', messageId)
  }

  /**
   * @param {string} sessionId
   * @param {string} text
   * @param {string} messageId
   */
  async function routeExplicit(sessionId, text, messageId) {
    if (text === '') {
      await sendStatus(sessionId)
      return
    }
    if (/^\/btw\b/i.test(text)) {
      await runBtw(sessionId, text.replace(/^\/btw\b/i, '').trim())
      return
    }
    if (/^\/stop\b/i.test(text)) {
      await stopSession(sessionId, messageId)
      return
    }
    if (/^\/status\b/i.test(text)) {
      await sendStatus(sessionId)
      return
    }
    if (STEER_PREFIX.test(text)) {
      await routeToSession(sessionId, text.replace(STEER_PREFIX, ''), 'steer', messageId)
      return
    }
    await routeToSession(sessionId, text, 'queue', messageId)
  }

  /**
   * @param {string} name
   * @param {string} argument
   * @param {string} messageId
   * @param {string} [repliedSessionId]
   */
  async function routeCommand(name, argument, messageId, repliedSessionId) {
    switch (name) {
      case 'help':
        await sendHelp(argument)
        return
      case 'sessions':
        await sendSessions(argument)
        return
      case 'level':
      case 'push':
        await sendLevel(argument)
        return
      case 'archive':
        await sendArchive(argument)
        return
      case 'workspaces':
        await sendWorkspaces(argument)
        return
      case 'workspace-create':
        await createWorkspaceFromCommand(argument)
        return
      case 'status': {
        const sessionId = await targetOf(argument, repliedSessionId)
        if (sessionId === undefined) {
          await replyText(messageId, '找不到会话；发送 /sessions 查看最近会话。')
          return
        }
        await sendStatus(sessionId)
        return
      }
      case 'btw': {
        const parsed = await parseBtwArgument(argument, repliedSessionId)
        if (parsed.sessionId === undefined) {
          await replyText(messageId, '找不到会话；先发送 /sessions 查看，或回复某条会话通知。')
          return
        }
        await runBtw(parsed.sessionId, parsed.question)
        return
      }
      case 'stop': {
        const sessionId = await targetOf(argument, repliedSessionId)
        if (sessionId === undefined) {
          await replyText(messageId, '找不到会话；发送 /sessions 查看最近会话。')
          return
        }
        await stopSession(sessionId, messageId)
        return
      }
      default:
        await sendHelp()
    }
  }

  /**
   * @param {string} sessionId
   * @param {string} text
   * @param {'queue'|'steer'} mode
   * @param {string} messageId
   */
  async function routeToSession(sessionId, text, mode, messageId) {
    const prompt = String(text ?? '').trim()
    if (prompt === '') return
    if (prompt.length > config.maxPromptChars) {
      await replyText(messageId, `内容过长（上限 ${config.maxPromptChars} 字）。`)
      return
    }
    try {
      await ctx.sessionController.prompt(
        {
          requestId: newId(),
          sessionId,
          mode,
          content: [{ type: 'text', text: prompt }],
        },
        new AbortController().signal,
      )
      registry.rememberLast(sessionId)
      await transport.react(messageId, 'OK')
      logger.info(`[lark] prompt delivered to ${sessionId} (${mode})`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await replyText(messageId, `发送失败：${truncate(message, 500)}`)
    }
  }

  /**
   * @param {string} sessionId
   * @param {string} messageId
   */
  async function stopSession(sessionId, messageId) {
    try {
      ctx.sessionController.cancel({ sessionId })
      await transport.react(messageId, 'OK')
      await replyText(messageId, '已请求停止当前轮次。')
    } catch (error) {
      await replyText(messageId, `停止失败：${truncate(String(error), 300)}`)
    }
  }

  /** @param {string} sessionId */
  /**
   * Compose the status card with the current mode/model/thinking/permission
   * and the editable catalogs. The projection is authoritative; missing cells
   * fall back to the snapshot so the card still renders on partial profiles.
   * @param {string} sessionId
   */
  async function statusCardFor(sessionId) {
    const snapshot = await btw.snapshot(sessionId)
    let config = {}
    try {
      config = await readSessionConfig(ctx, sessionId)
    } catch (error) {
      logger.debug?.(`[lark] session config read failed: ${String(error)}`)
    }
    const options = await loadCreationOptions(ctx)
    const modelOption = options.models.find((option) => option.value === config.modelValue)
    const effortOption = options.efforts.find((option) => option.value === config.effort)
    const permissionOption = options.permissions.find((option) => option.value === config.permission)
    const modeOption = options.agentPresets.find((option) => option.value === config.agentPreset)
    const hasEffortOptions = options.efforts.some((option) => option.value !== '')
    const effortLabel = effortOption?.text
      ?? (typeof config.effort === 'string' && config.effort !== ''
        ? config.effort
        : hasEffortOptions ? '默认' : '')
    const modelLabel = modelOption?.text
      ?? (config.provider !== undefined && config.model !== undefined
        ? `${config.provider} · ${config.model}`
        : snapshot.model)
    return buildStatusCard({
      code: snapshot.code,
      title: snapshot.title,
      running: snapshot.running,
      statusText: snapshot.running ? `运行中${snapshot.elapsed ? `（${snapshot.elapsed}）` : ''}` : '空闲',
      lastUser: snapshot.lastUser,
      lastAssistant: snapshot.lastAssistant,
      cwd: snapshot.cwd,
      model: snapshot.model,
      modelLabel,
      modelValue: config.modelValue,
      elapsed: snapshot.elapsed,
      pending: snapshot.pending,
      queued: snapshot.queued,
      sessionId,
      tools: snapshot.tools,
      agentPreset: config.agentPreset,
      modeLabel: modeOption?.text ?? config.agentPreset,
      effort: config.effort,
      effortLabel,
      permission: config.permission,
      permissionLabel: permissionOption?.text ?? config.permission,
      archiveAvailable: archive.configured(),
      options: {
        models: options.models,
        efforts: options.efforts,
        permissions: options.permissions,
      },
    })
  }

  async function sendHistoryList(sessionId) {
    const rows = await btw.history(sessionId, 32)
    const code = registry.ensureCode(sessionId)
    const row = await registry.describe(sessionId)
    const card = fitCard(buildHistoryCard({ code, title: row?.title, sessionId, rows }))
    const result = await transport.sendCard(card, { idempotencyKey: `history:${sessionId}:${Date.now()}` })
    if (result.messageId) registry.link(sessionId, result.messageId, { kind: 'status' })
  }

  async function sendHistoryItem(sessionId, index) {
    const rows = await btw.history(sessionId, 32)
    const row = rows[index]
    if (row === undefined) {
      await sendText('这条记录已经不在了，请重新点「历史记录列表」。')
      return
    }
    const who = row.role === 'user' ? '你' : 'DSH'
    await sendText(`**${formatTime(row.at)} ${who}**\n\n${row.text}`)
    // Pictures of that message follow as their own image messages.
    if (Array.isArray(row.images) && row.images.length > 0) {
      await sendImageRefs(row.images)
    }
  }

  async function sendImageRefs(refs) {
    const attachments = ctx.get('attachments')
    if (attachments === undefined || typeof attachments.readImage !== 'function') return
    const chatId = transport.targetChatId
    if (typeof chatId !== 'string' || chatId === '') return
    for (const ref of refs.slice(0, 4)) {
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


  async function sendStatus(sessionId) {
    const card = fitCard(await statusCardFor(sessionId))
    const result = await transport.sendCard(card, { idempotencyKey: `status:${sessionId}:${Date.now()}` })
    if (result.messageId) registry.link(sessionId, result.messageId, { kind: 'status' })
  }

  /**
   * Apply the status card's configuration form and patch the same card.
   * @param {string} sessionId
   * @param {Record<string, any>} formValue
   * @param {string} messageId
   */
  async function applyStatusConfig(sessionId, formValue, messageId) {
    const permission = typeof formValue.permission === 'string' ? formValue.permission.trim() : ''
    const model = typeof formValue.model === 'string' ? formValue.model.trim() : ''
    const effort = typeof formValue.effort === 'string' ? formValue.effort.trim() : ''
    try {
      // Validate against the current catalogs before touching the Session, so
      // an unsupported combination cannot half-apply a permission change.
      const options = await loadCreationOptions(ctx)
      const invalid = validateConfigChoice(options, { permission, model, effort })
      if (invalid !== undefined) throw new Error(invalid)
      await applySessionConfig(ctx, sessionId, { permission, model, effort })
      const card = fitCard(await statusCardFor(sessionId))
      await transport.patchCard(messageId, card)
    } catch (error) {
      await sendText(`修改配置失败：${String(error)}`)
    }
  }

  /**
   * @param {string} [argument] - optional time range such as `1d`, `12h`.
   */
  async function sendSessions(argument = '') {
    const range = parseSessionRange(argument)
    if (range.error !== undefined) {
      await sendText(range.error)
      return
    }
    const sessions = await registry.listSessions(0)
    const archived = archivedSessionIds()
    const cutoff = range.ms === undefined ? undefined : Date.now() - range.ms
    const filtered = sessions
      .filter((row) => !archived.has(row.sessionId))
      .filter((row) => cutoff === undefined || row.updatedAt >= cutoff)
    const rows = filtered.slice(0, 10).map((row) => ({
      sessionId: row.sessionId,
      code: registry.ensureCode(row.sessionId),
      title: row.title,
      running: row.running,
      updatedAt: row.updatedAt,
    }))
    const result = await transport.sendCard(fitCard(buildSessionsCard({ sessions: rows, rangeLabel: range.label })), {
      idempotencyKey: `sessions:${range.label}:${Date.now()}`,
    })
    if (result.messageId) {
      logger.debug?.(`[lark] sessions card ${result.messageId}`)
    }
  }

  /**
   * Archived sessions stay addressable by hash/`/btw`, but must not appear in
   * the `/sessions` picker. The archive set is owned by the Workspace registry;
   * deployments without it simply have no archived sessions to hide.
   * @returns {Set<string>}
   */
  function archivedSessionIds() {
    try {
      const registryService = ctx.get('workspaceRegistry')
      return new Set((registryService?.archivedSessionIds ?? []).map(String))
    } catch {
      return new Set()
    }
  }

  /** @param {string} sessionId */
  async function sendSessionDetail(sessionId) {
    const snapshot = await btw.snapshot(sessionId)
    const row = await registry.describe(sessionId)
    const card = fitCard(buildSessionDetailCard({
      code: snapshot.code,
      sessionId,
      title: snapshot.title,
      running: snapshot.running,
      updatedAt: row?.updatedAt,
      cwd: snapshot.cwd,
      model: snapshot.model,
      pending: snapshot.pending,
      queued: snapshot.queued,
    }))
    const result = await transport.sendCard(card, {
      idempotencyKey: `session:${sessionId}:${Date.now()}`,
    })
    if (result.messageId) registry.link(sessionId, result.messageId, { kind: 'session' })
  }

  /** @param {string} sessionId */
  async function sendHash(sessionId) {
    const code = registry.ensureCode(sessionId)
    await transport.sendText(`#${code}`)
  }

  async function sendArchiveStatus() {
    const status = await archive.status()
    const result = await transport.sendCard(fitCard(buildArchiveStatusCard(status)), {
      idempotencyKey: `archive-status:${Date.now()}`,
    })
    if (result.messageId) {
      store.linkMessage(result.messageId, { kind: 'archive', sessionId: '' })
    }
    return status
  }

  /** @param {string} [argument] */
  async function sendArchive(argument = '') {
    const text = String(argument ?? '').trim()
    if (text === '') {
      try {
        await sendArchiveStatus()
      } catch (error) {
        await sendText(`归档状态读取失败：${String(error)}`)
      }
      return
    }
    const setMatch = /^set\s+(\S+)$/i.exec(text)
    if (setMatch !== null) {
      try {
        const parent = await archive.setParentUrl(setMatch[1])
        await sendText(`归档父文档已保存：${parent.title || parent.url}`)
        await sendArchiveStatus()
      } catch (error) {
        await sendText(`保存归档父文档失败：${String(error)}`)
      }
      return
    }
    if (/^(clear|reset)$/i.test(text)) {
      try {
        archive.clearParentUrl()
        await sendArchiveStatus()
      } catch (error) {
        await sendText(`清除归档配置失败：${String(error)}`)
      }
      return
    }
    const match = /^delete-before\s+(\S+)$/i.exec(text)
    if (match === null) {
      await sendText('用法：/archive（查看归档配置）；/archive delete-before YYYY-MM-DD（删除该日期之前的归档回答）。')
      return
    }
    const cutoff = archive.validateCutoff(match[1])
    if (cutoff === undefined) {
      await sendText('日期格式应为 YYYY-MM-DD，例如 /archive delete-before 2026-11-01。')
      return
    }
    try {
      const plan = await archive.planDelete(cutoff)
      if (plan.count === 0) {
        await sendText(`没有找到 ${cutoff} 之前的归档回答。`)
        return
      }
      const key = newId()
      pendingArchiveDeletes.set(key, { cutoff, createdAt: Date.now() })
      await transport.sendCard(fitCard(buildArchiveDeletePreviewCard({
        cutoff,
        count: plan.count,
        dates: plan.dates,
        key,
      })), { idempotencyKey: `archive-delete:${key}` })
    } catch (error) {
      await sendText(`归档扫描失败：${String(error)}`)
    }
  }

  /**
   * @param {Record<string, any>} value
   * @param {string} messageId
   */
  async function archiveAnswerFromCard(value, messageId, latest = false) {
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId : ''
    if (sessionId === '') {
      await sendText('这张卡片没有会话信息，无法归档。')
      return
    }
    const lock = `${latest ? 'latest' : 'turn'}:${messageId}`
    if (archiveInFlight.has(lock)) {
      await sendText('该回答正在归档，请稍候。')
      return
    }
    archiveInFlight.add(lock)
    try {
      await sendText(latest ? '正在检查最近回答的归档…' : '正在把完整回答归档到飞书文档…')
      const result = await archive.archiveAnswer({
        sessionId,
        turn: latest ? undefined : (Number.isInteger(value.turn) ? value.turn : undefined),
      })
      await transport.sendCard(fitCard(buildArchiveResultCard(result)), {
        idempotencyKey: `archive-result:${sessionId}:${Date.now()}`,
      })
    } catch (error) {
      await sendText(`归档失败：${String(error)}`)
    } finally {
      archiveInFlight.delete(lock)
    }
  }

  /**
   * @param {Record<string, any>} value
   * @param {string} messageId
   */
  async function confirmArchiveDelete(value, messageId) {
    const key = typeof value.key === 'string' ? value.key : ''
    const pending = pendingArchiveDeletes.get(key)
    if (pending === undefined || Date.now() - pending.createdAt > 15 * 60 * 1000) {
      pendingArchiveDeletes.delete(key)
      await sendText('这个删除确认已过期，请重新发送 /archive delete-before。')
      return
    }
    pendingArchiveDeletes.delete(key)
    try {
      await sendText(`正在删除 ${pending.cutoff} 之前的归档回答…`)
      const result = await archive.deleteBefore(pending.cutoff)
      await transport.patchCard(messageId, fitCard(buildArchiveDeleteResultCard(result)))
    } catch (error) {
      await sendText(`删除归档失败：${String(error)}`)
    }
  }

  /** @param {string} [argument] */
  async function sendLevel(argument = '') {
    const text = String(argument ?? '').trim()
    if (text === '') {
      await sendLevelCard(store.pushLevel())
      return
    }
    if (!/^[012]$/.test(text)) {
      await sendText('用法：/level 0|1|2（0 静默，1 仅提问/审批，2 全部）')
      return
    }
    await applyLevel(Number(text))
  }

  /**
   * @param {0|1|2} level
   * @param {string} [messageId]
   */
  async function applyLevel(level, messageId) {
    const previous = store.pushLevel()
    store.setPushLevel(level)
    let promoted = 0
    if (level >= 1 && previous < 1) {
      try {
        promoted = await answerer.promoteSuppressed()
      } catch (error) {
        logger.warn(`[lark] suppressed interaction promotion failed: ${String(error)}`)
      }
    }
    if (messageId !== undefined) {
      await transport.patchCard(messageId, fitCard(buildLevelCard({ current: level })))
    } else {
      await sendLevelCard(level)
    }
    if (promoted > 0) logger.info(`[lark] promoted ${promoted} suppressed interaction card(s)`)
  }

  /** @param {0|1|2} current */
  async function sendLevelCard(current) {
    await transport.sendCard(fitCard(buildLevelCard({ current })), {
      idempotencyKey: `level:${current}:${Date.now()}`,
    })
  }

  /** @param {string} sessionId */
  function nudgeWebSession(sessionId) {
    try {
      // The API session controller already emits api-session/added on
      // session/created; this activity frame makes an open Web sidebar
      // re-read ordering/status immediately as well.
      ctx.emit('api-session/activity', sessionId, Date.now())
    } catch (error) {
      logger.debug?.(`[lark] Web session nudge failed: ${String(error)}`)
    }
  }

  /** @param {Record<string, any>} summary */
  function decorateSession(summary) {
    return {
      ...summary,
      title: typeof summary.projections?.values?.title === 'string' ? summary.projections.values.title : '',
      code: registry.ensureCode(summary.sessionId),
    }
  }

  /** @param {string} [argument] */
  async function sendWorkspaces(argument = '') {
    const range = parseSessionRange(argument)
    if (range.error !== undefined) {
      await sendText(range.error)
      return
    }
    try {
      const data = await listGroups(ctx, {
        timeRangeMs: range.ms,
        includeSubagents: config.includeSubagents,
        maxWorkspaces: config.maxWorkspaces,
        maxWorkspaceSessions: config.maxWorkspaceSessions,
      })
      const groups = data.groups.map((group) => ({
        workspace: group.workspace,
        sessions: group.sessions.map(decorateSession),
      }))
      const card = fitCard(buildWorkspacesCard({
        groups,
        ungrouped: data.ungrouped.map(decorateSession),
        rangeLabel: range.label,
        truncated: data.truncated,
      }))
      await transport.sendCard(card, { idempotencyKey: `workspaces:${range.label}:${Date.now()}` })
    } catch (error) {
      await sendText(error instanceof WorkspaceUnavailableError ? error.message : `读取工作区失败：${String(error)}`)
    }
  }

  /** @param {string} workspaceId */
  async function sendWorkspaceDetail(workspaceId) {
    try {
      const data = await listWorkspaceDetail(ctx, workspaceId)
      if (data === undefined) {
        await sendText('找不到该工作区。')
        return
      }
      await transport.sendCard(fitCard(buildWorkspaceDetailCard({
        workspace: data.workspace,
        sessions: data.sessions.map(decorateSession),
      })), { idempotencyKey: `workspace:${workspaceId}:${Date.now()}` })
    } catch (error) {
      await sendText(error instanceof WorkspaceUnavailableError ? error.message : `读取工作区失败：${String(error)}`)
    }
  }

  async function sendCreateWorkspaceCard() {
    const result = await transport.sendCard(fitCard(buildCreateWorkspaceCard()), {
      idempotencyKey: `wsc:${Date.now()}`,
    })
    if (result.messageId) {
      store.linkMessage(result.messageId, { kind: 'workspace-create', sessionId: '' })
    }
  }

  /** @param {string} workspaceId */
  async function sendCreateSessionCard(workspaceId) {
    try {
      const workspace = findWorkspace(ctx, workspaceId)
      if (workspace === undefined) {
        await sendText('找不到该工作区。')
        return
      }
      const options = await loadCreationOptions(ctx)
      const card = fitCard(buildCreateSessionCard({
        workspace: { id: workspace.id, title: workspace.title, path: workspace.path },
        agentPresets: options.agentPresets,
        models: options.models,
        efforts: options.efforts,
        permissions: options.permissions,
        defaults: options.defaults,
      }))
      const result = await transport.sendCard(card, {
        idempotencyKey: `session-create:${workspaceId}:${Date.now()}`,
      })
      if (result.messageId) {
        store.linkMessage(result.messageId, {
          kind: 'session-create',
          sessionId: '',
          workspaceId,
          requestId: newId(),
        })
      }
    } catch (error) {
      await sendText(error instanceof WorkspaceUnavailableError ? error.message : `准备创建会话失败：${String(error)}`)
    }
  }

  /** @param {string} argument */
  async function createWorkspaceFromCommand(argument) {
    const text = String(argument ?? '').trim()
    if (text === '') {
      await sendText('用法：/workspace-create /绝对路径 [| 标题]')
      return
    }
    const [pathPart, ...titleParts] = text.split('|')
    const rawPath = pathPart.trim()
    const title = titleParts.join('|').trim()
    if (normalizeAbsolutePath(rawPath) === undefined) {
      await sendText('路径必须是绝对路径（可以用 ~/ 开头）。')
      return
    }
    try {
      const { workspace, created } = await createWorkspace(ctx, rawPath, title)
      await sendWorkspaceDetail(workspace.id)
      if (!created) await sendText('该路径已有工作区，已为你打开。')
    } catch (error) {
      await sendText(error instanceof WorkspaceUnavailableError ? error.message : `创建工作区失败：${String(error)}`)
    }
  }

  /**
   * @param {Record<string, any>} link
   * @param {Record<string, any>} formValue
   * @param {string} messageId
   */
  async function createWorkspaceFromForm(link, formValue, messageId) {
    if (creationLocks.has(messageId)) {
      await sendText('正在创建，请稍候。')
      return
    }
    creationLocks.add(messageId)
    try {
      await createWorkspaceFromFormLocked(link, formValue, messageId)
    } finally {
      creationLocks.delete(messageId)
    }
  }

  async function createWorkspaceFromFormLocked(link, formValue, messageId) {
    const rawPath = typeof formValue.path === 'string' ? formValue.path.trim() : ''
    const title = typeof formValue.title === 'string' ? formValue.title.trim() : ''
    if (normalizeAbsolutePath(rawPath) === undefined) {
      await sendText('路径必须是绝对路径（可以用 ~/ 开头）。')
      return
    }
    try {
      const { workspace, created } = await createWorkspace(ctx, rawPath, title)
      const data = await listWorkspaceDetail(ctx, workspace.id)
      if (data !== undefined) {
        await transport.patchCard(messageId, fitCard(buildWorkspaceDetailCard({
          workspace: data.workspace,
          sessions: data.sessions.map(decorateSession),
          created,
        })))
      }
      if (!created) await sendText('该路径已有工作区，已为你打开。')
    } catch (error) {
      await sendText(error instanceof WorkspaceUnavailableError ? error.message : `创建工作区失败：${String(error)}`)
    }
  }

  /**
   * @param {Record<string, any>} link
   * @param {Record<string, any>} formValue
   * @param {string} messageId
   */
  async function createSessionFromForm(link, formValue, messageId) {
    if (creationLocks.has(messageId)) {
      await sendText('正在创建，请稍候。')
      return
    }
    creationLocks.add(messageId)
    try {
      await createSessionFromFormLocked(link, formValue, messageId)
    } finally {
      creationLocks.delete(messageId)
    }
  }

  async function createSessionFromFormLocked(link, formValue, messageId) {
    const prompt = typeof formValue.prompt === 'string' ? formValue.prompt.trim() : ''
    if (prompt === '') {
      await sendText('请输入首条 prompt。')
      return
    }
    const workspaceId = typeof link.workspaceId === 'string' ? link.workspaceId : ''
    if (workspaceId === '') {
      await sendText('这张卡片缺少工作区信息，请重新从 /workspaces 打开。')
      return
    }
    const agentPreset = typeof formValue.agent_preset === 'string' ? formValue.agent_preset.trim() : ''
    const model = typeof formValue.model === 'string' ? formValue.model.trim() : ''
    const effort = typeof formValue.effort === 'string' ? formValue.effort.trim() : ''
    const permission = typeof formValue.permission === 'string' ? formValue.permission.trim() : ''
    const requestId = typeof link.requestId === 'string' ? link.requestId : newId()
    let sessionId = typeof link.createdSessionId === 'string' ? link.createdSessionId : undefined

    if (sessionId !== undefined && link.promptSent === true) {
      await sendText(`会话 #${registry.ensureCode(sessionId)} 已经创建并发送过 prompt。`)
      return
    }

    try {
      const options = await loadCreationOptions(ctx)
      const invalid = validateConfigChoice(options, { permission, model, effort })
      if (invalid !== undefined) {
        await sendText(invalid)
        return
      }
      if (sessionId === undefined) {
        const created = await createSessionOnly(ctx, { workspaceId, agentPreset })
        sessionId = created.sessionId
        store.linkMessage(messageId, {
          ...link,
          kind: 'session-create',
          sessionId,
          workspaceId,
          requestId,
          createdSessionId: sessionId,
        })
        nudgeWebSession(sessionId)
      }
      await applySessionOptions(ctx, sessionId, { permission, model, effort })
      await sendSessionPrompt(ctx, sessionId, prompt, requestId)
      store.linkMessage(messageId, {
        ...link,
        kind: 'session-create',
        sessionId,
        workspaceId,
        requestId,
        createdSessionId: sessionId,
        promptSent: true,
      })
      registry.rememberLast(sessionId)
      nudgeWebSession(sessionId)
      const code = registry.ensureCode(sessionId)
      const workspace = findWorkspace(ctx, workspaceId)
      const title = (await registry.label(sessionId, 60)) || prompt.slice(0, 60)
      await transport.patchCard(messageId, fitCard(buildSessionCreatedCard({
        code,
        sessionId,
        title,
        workspaceTitle: workspace?.title,
        promptSent: true,
      })))
    } catch (error) {
      await sendText(`创建会话失败：${String(error)}`)
    }
  }

  /**
   * `/help` without an argument sends the index; `/help /sessions` sends the
   * one-topic card. Unknown topics are answered with the index hint instead
   * of executing anything.
   * @param {string} [argument]
   */
  async function sendHelp(argument = '') {
    const text = String(argument ?? '').trim()
    if (text === '') {
      await transport.sendCard(fitCard(buildHelpCard()), { idempotencyKey: `help:${Date.now()}` })
      return
    }
    const topic = findHelpTopic(text)
    if (topic === undefined) {
      await sendText(`没有找到 ${truncate(text, 80)} 的帮助；发送 /help 查看全部命令。`)
      return
    }
    await transport.sendCard(fitCard(buildHelpTopicCard(topic)), {
      idempotencyKey: `help:${topic.id}:${Date.now()}`,
    })
  }

  /**
   * @param {string} sessionId
   * @param {string} question
   */
  async function runBtw(sessionId, question) {
    const snapshot = await btw.snapshot(sessionId)
    if (question === '') {
      const card = fitCard(buildBtwCard({
        code: snapshot.code,
        title: snapshot.title,
        question: '当前会话状态',
        answer: snapshotAnswer(snapshot),
        note: '这是状态快照，不写入会话。发送 /btw <问题> 可让 dsh-btw 生成自然语言回答。',
      }))
      const result = await transport.sendCard(card, { idempotencyKey: `btws:${sessionId}:${Date.now()}` })
      if (result.messageId) registry.link(sessionId, result.messageId, { kind: 'btw' })
      return
    }

    const placeholder = fitCard(buildBtwCard({
      code: snapshot.code,
      title: snapshot.title,
      question,
      answer: '',
      note: '正在调用 dsh-btw…',
    }))
    const sent = await transport.sendCard(placeholder, { idempotencyKey: `btw:${sessionId}:${Date.now()}` })
    if (sent.messageId) registry.link(sessionId, sent.messageId, { kind: 'btw' })

    let result
    try {
      result = await btw.ask(sessionId, question)
    } catch (error) {
      result = { ok: false, message: `旁问失败：${String(error)}` }
    }
    let card
    if (result.ok) {
      card = buildBtwCard({
        code: snapshot.code,
        title: snapshot.title,
        question,
        answer: result.answer,
        model: result.model,
      })
    } else if (result.unavailable) {
      card = buildBtwCard({
        code: snapshot.code,
        title: snapshot.title,
        question,
        answer: snapshotAnswer(snapshot),
        available: false,
        note: `LLM 旁问不可用：${truncate(result.message, 300)}。已返回状态快照。`,
      })
    } else {
      card = buildErrorCard({
        code: snapshot.code,
        title: '旁问失败',
        message: result.message,
      })
    }
    const final = fitCard(card)
    if (sent.messageId) {
      await transport.patchCard(sent.messageId, final)
    } else {
      await transport.sendCard(final, { idempotencyKey: `btwf:${sessionId}:${Date.now()}` })
    }
  }

  /**
   * @param {Record<string, any>} event
   */
  async function handleCardAction(event) {
    if (config.debug) {
      try {
        appendFileSync('/tmp/dsh-lark-ctrl-card-events.ndjson', `${JSON.stringify(event)}\n`)
      } catch {
        // diagnostics only
      }
    }
    const operatorId = typeof event.operator_id === 'string' ? event.operator_id : ''
    if (!transport.isAllowed(operatorId)) {
      logger.warn(`[lark] ignored card action from unauthorized operator ${operatorId || '(unknown)'}`)
      return
    }
    // Card-action dedupe is owned by the event bridge (it stores the same
    // `card:<event_id>` key before invoking this handler). Deduplicating here
    // again would drop every callback.
    const messageId = typeof event.message_id === 'string' ? event.message_id : ''
    const link = messageId === '' ? undefined : registry.lookup(messageId)
    const tag = String(event.action_tag ?? '')

    // Form submits arrive as a button with `form_value`; standalone selects and
    // inputs are intermediate interactions and must not disturb the form.
    if (tag !== 'button') return

    const formValue = normalizeFormValue(event.form_value)
    const value = parseActionValue(event.action_value)
    if (formValue !== undefined && link !== undefined && link.kind === 'question') {
      const result = await answerer.answerFromForm(messageId, formValue, operatorId)
      if (!result.ok) await sendText(`回答失败：${result.error ?? '未知错误'}`)
      return
    }

    if (value?.op === 'answer') {
      const result = await answerer.answerFromChoice(messageId, value, operatorId)
      if (!result.ok) await sendText(`回答失败：${result.error ?? '未知错误'}`)
      return
    }

    if (value?.op === 'archive_answer') {
      await archiveAnswerFromCard(value, messageId)
      return
    }

    if (value?.op === 'archive_latest') {
      await archiveAnswerFromCard(value, messageId, true)
      return
    }

    if (value?.op === 'archive_clear') {
      archive.clearParentUrl()
      const status = await archive.status()
      await transport.patchCard(messageId, fitCard(buildArchiveStatusCard(status)))
      return
    }

    if (value?.op === 'archive_delete_confirm') {
      await confirmArchiveDelete(value, messageId)
      return
    }

    if (value?.op === 'archive_delete_cancel') {
      const key = typeof value.key === 'string' ? value.key : ''
      pendingArchiveDeletes.delete(key)
      await transport.patchCard(messageId, fitCard(buildNoticeCard('已取消删除归档回答。')))
      return
    }

    if (value?.op === 'help_index') {
      await sendHelp('')
      return
    }

    if (value?.op === 'help_topic') {
      await sendHelp(String(value.command ?? ''))
      return
    }

    if (value?.op === 'set_level') {
      const level = Number(value.level)
      if (level === 0 || level === 1 || level === 2) {
        await applyLevel(level, messageId)
      } else {
        await sendText('无效的推送级别，请选择 0、1 或 2。')
      }
      return
    }

    if (formValue !== undefined && link !== undefined && link.kind === 'session-create') {
      await createSessionFromForm(link, formValue, messageId)
      return
    }

    if (formValue !== undefined && link !== undefined && link.kind === 'workspace-create') {
      await createWorkspaceFromForm(link, formValue, messageId)
      return
    }

    if (formValue !== undefined && link !== undefined && link.kind === 'status') {
      await applyStatusConfig(link.sessionId, formValue, messageId)
      return
    }

    if (formValue !== undefined && link !== undefined && link.kind === 'archive') {
      const url = typeof formValue.archive_url === 'string' ? formValue.archive_url.trim() : ''
      try {
        const parent = await archive.setParentUrl(url)
        await transport.patchCard(messageId, fitCard(buildArchiveStatusCard({
          configured: true,
          parentUrl: parent.url,
          parentTitle: parent.title,
          source: 'lark',
          error: undefined,
        })))
      } catch (error) {
        await sendText(`保存归档父文档失败：${String(error)}`)
      }
      return
    }

    if (formValue !== undefined && link !== undefined) {
      const prompt = typeof formValue.prompt === 'string' ? formValue.prompt.trim() : ''
      if (prompt !== '') {
        // The session detail form has two submit buttons in the same container:
        // `session_send` routes to the session, `session_btw` routes to /btw.
        // Lark reports the clicked button's `name` as `action_name`.
        if (String(event.action_name ?? '') === 'session_btw') {
          if (typeof link.sessionId === 'string' && link.sessionId !== '') {
            await runBtw(link.sessionId, prompt)
          } else {
            await sendText('这张卡片没有会话信息，请重新打开会话详情。')
          }
          return
        }
        await routeToSession(link.sessionId, prompt, 'queue', messageId)
        await sendText(`已发送到 #${registry.ensureCode(link.sessionId)}。`)
      }
      return
    }

    if (value === undefined) return
    const op = String(value.op ?? '')
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId : link?.sessionId

    if (op === 'workspace_new') {
      await sendCreateWorkspaceCard()
      return
    }
    if (op === 'workspace_new_session' && typeof value.workspaceId === 'string') {
      await sendCreateSessionCard(value.workspaceId)
      return
    }
    if (op === 'session_open' && sessionId !== undefined) {
      await sendSessionDetail(sessionId)
      return
    }
    if (op === 'session_copy' && sessionId !== undefined) {
      await sendHash(sessionId)
      return
    }
    if (op === 'session_btw' && sessionId !== undefined) {
      // Cards sent before 0.2.1 had a standalone 旁问 button that could not
      // carry the form prompt. Send the new detail card so the next question
      // can be submitted through the form's `session_btw` button.
      await sendSessionDetail(sessionId)
      await sendText('已发送新的会话详情卡；在表单输入问题后点「旁问」。')
      return
    }
    if (op === 'status' && sessionId !== undefined) {
      await sendStatus(sessionId)
      return
    }
    if (op === 'cancel' && sessionId !== undefined) {
      await stopSession(sessionId, messageId)
      return
    }
    if (op === 'btw_prompt' && sessionId !== undefined) {
      await sendText(`请发送 \`/btw #${registry.ensureCode(sessionId)} 你的问题\`，或直接回复某条通知。`)
      return
    }
    // 「最近会话」按钮：弹列表，再点某一行「打开」。
    if (op === 'sessions') {
      await sendSessions('')
      return
    }
    // 历史记录列表 → 单条全文（含图片）。
    if (op === 'history' && sessionId !== undefined) {
      await sendHistoryList(sessionId)
      return
    }
    if (op === 'history_item' && sessionId !== undefined) {
      await sendHistoryItem(sessionId, Number(value.index))
      return
    }
    if (op === 'approval') {
      const key = String(value.key ?? '')
      const decision = value.decision === 'allow' ? 'allow' : 'reject'
      const result = await answerer.answerApproval(key, decision, operatorId)
      if (!result.ok) await sendText(result.error ?? '审批失败。')
      return
    }
  }

  /**
   * @param {string} argument
   * @param {string} [repliedSessionId]
   * @returns {Promise<string | undefined>}
   */
  async function targetOf(argument, repliedSessionId) {
    const code = argument.trim().replace(/^#/, '')
    if (code === '') return repliedSessionId ?? registry.lastSession()
    const resolved = await registry.resolveCode(code)
    return resolved ?? repliedSessionId ?? registry.lastSession()
  }

  /**
   * @param {string} argument
   * @param {string} [repliedSessionId]
   */
  async function parseBtwArgument(argument, repliedSessionId) {
    const tokens = argument.trim().split(/\s+/).filter(Boolean)
    if (tokens.length > 0) {
      const candidate = tokens[0].replace(/^#/, '').toLowerCase()
      if (/^[a-z2-7]{6,12}$/.test(candidate)) {
        const resolved = await registry.resolveCode(candidate)
        if (resolved !== undefined) {
          return { sessionId: resolved, question: tokens.slice(1).join(' ') }
        }
      }
    }
    return {
      sessionId: repliedSessionId ?? registry.lastSession(),
      question: tokens.join(' '),
    }
  }

  /**
   * @param {string} messageId
   * @param {string} text
   */
  async function replyText(messageId, text) {
    try {
      await transport.sendText(text, { replyToMessageId: messageId })
    } catch (error) {
      logger.warn(`[lark] reply failed: ${String(error)}`)
    }
  }

  /** @param {string} text */
  async function sendText(text) {
    try {
      await transport.sendText(text)
    } catch (error) {
      logger.warn(`[lark] text send failed: ${String(error)}`)
    }
  }

  /** @param {Record<string, any>} event */
  function chatAllowed(event) {
    const chatId = typeof event.chat_id === 'string' ? event.chat_id : ''
    if (config.targetChatId !== '') return chatId === config.targetChatId
    // Without a configured group, only the bot's P2P conversation is accepted.
    return event.chat_type === 'p2p'
  }

  /** @param {string} senderId */
  function takeRate(senderId) {
    const now = Date.now()
    const windowStart = now - 60000
    const entries = (rate.get(senderId) ?? []).filter((time) => time > windowStart)
    if (entries.length >= config.maxInboundPerMinute) {
      rate.set(senderId, entries)
      return false
    }
    entries.push(now)
    rate.set(senderId, entries)
    return true
  }

  return {
    handleMessage,
    handleCardAction,
    sendStatus,
  }
}

/** @param {string} content @param {unknown} mentions */
function stripMentions(content, mentions) {
  let text = content
  if (Array.isArray(mentions)) {
    for (const mention of mentions) {
      if (typeof mention?.key === 'string') text = text.split(mention.key).join('')
    }
  }
  return text.replace(/\u200b/g, '').trim()
}

/** @param {unknown} value */
function parseActionValue(value) {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** @param {Record<string, any>} snapshot */
function snapshotAnswer(snapshot) {
  const lines = [
    `**状态**：${snapshot.statusText}${snapshot.elapsed ? `（已运行 ${snapshot.elapsed}）` : ''}`,
    snapshot.cwd ? `**目录**：\`${snapshot.cwd}\`` : '',
    snapshot.model ? `**模型**：\`${snapshot.model}\`` : '',
    snapshot.pending > 0 ? `**待回答**：${snapshot.pending} 个` : '',
    snapshot.queued > 0 ? `**排队**：${snapshot.queued} 条` : '',
    snapshot.lastUser ? `**最近输入**\n> ${truncate(quoteLines(stripImages(snapshot.lastUser)), 400)}` : '',
    snapshot.lastAssistant ? `**最近回复**\n${truncate(stripImages(snapshot.lastAssistant), 900)}` : '',
    snapshot.tools.length > 0 ? `**最近工具**：${snapshot.tools.join('、')}` : '',
  ].filter(Boolean)
  return lines.join('\n')
}

export { stripMentions, parseActionValue }
