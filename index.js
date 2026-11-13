/**
 * dsh-lark-ctrl: a Lark/Feishu bridge for DeepSeek Harness.
 *
 * Host-only bundle. It sends run summaries and interactive question/approval
 * cards through lark-cli, receives replies over lark-cli's long-lived event
 * consumers, and feeds answers back into the same Cordis waterfalls the Web
 * client uses.
 */

import { buildNoticeCard, fitCard } from './lib/cards.js'
import { createAnswerer } from './lib/answerer.js'
import { createArchive } from './lib/archive.js'
import { createBtw } from './lib/btw.js'
import { normalizeConfig } from './lib/config.js'
import { createEventBridge } from './lib/event-bridge.js'
import { createLarkCli } from './lib/lark-cli.js'
import { createNotifier } from './lib/notifier.js'
import { createRegistry } from './lib/registry.js'
import { createRouter } from './lib/router.js'
import { createStore } from './lib/store.js'
import { createTransport } from './lib/transport.js'
import { truncate } from './lib/util.js'

/** Loader row identity. */
export const name = 'dsh-lark-ctrl'

/**
 * Services this Host half needs. `connection` and `typertGateway` are optional
 * at call time: the first enables dsh-btw delegation, the second lets the
 * fallback modes notice a live Web client.
 */
export const inject = ['sessions', 'agents', 'sessionController', 'sessionProjections', 'userQuestions', 'attachments']

const STARTUP_RETRY_MS = 60000

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = createLogger(ctx, config)
  for (const warning of config.warnings) logger.warn(`[lark] config: ${warning}`)

  const store = createStore(config, logger)
  const cli = createLarkCli(config, logger)
  const transport = createTransport({ config, cli, logger })
  const registry = createRegistry({ ctx, store, config, logger })
  const notifier = createNotifier({ ctx, config, registry, transport, store, logger })
  const answerer = createAnswerer({ ctx, config, registry, transport, store, logger })
  const btw = createBtw({ ctx, config, registry, logger })
  const archive = createArchive({ ctx, config, cli, registry, store, logger })
  const router = createRouter({ ctx, config, registry, transport, answerer, btw, archive, store, logger })

  let disposed = false
  let registered = false
  let retryTimer
  let bridge

  ctx.effect(() => {
    return () => {
      disposed = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      bridge?.stop()
      transport.close()
      void store.dispose()
    }
  }, 'lark: lifecycle')

  async function bootstrap() {
    if (disposed) return
    try {
      await store.load()
      const status = await cli.status()
      if (disposed) return
      const target = transport.initialize(status)
      if (!registered) {
        // Register answerers/notifiers only after the persisted push level is
        // loaded, so L0 does not emit a card during the startup window.
        notifier.register()
        answerer.register()
        registered = true
      }
      logger.info(
        `[lark] ${status.version || 'lark-cli'} ready; target=${
          target.targetChatId || target.targetUserId || '(none)'
        }${target.userName ? ` (${target.userName})` : ''}${status.botReady ? '' : ' [bot identity not ready]'}`,
      )
      if (target.targetUserId === '' && target.targetChatId === '') {
        throw new Error('no target: lark-cli has no logged-in user and targetUserId/targetChatId is empty')
      }
      if (status.botReady !== true && config.identity === 'bot') {
        logger.warn('[lark] bot identity is not ready; sends will fail until the bot scope is authorized')
      }

      bridge = createEventBridge({
        config,
        cli,
        store,
        logger,
        onMessage: (event) => router.handleMessage(event),
        onCardAction: (event) => router.handleCardAction(event),
        onState: (state) => onBridgeState(state),
      })
      bridge.start()

      if (config.startupMessage) {
        void sendStartupMessage(status, target).catch((error) =>
          logger.warn(`[lark] startup message failed: ${String(error)}`),
        )
      }
    } catch (error) {
      logger.warn(`[lark] bootstrap failed: ${String(error)}`)
      if (disposed) return
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        void bootstrap()
      }, STARTUP_RETRY_MS)
      retryTimer.unref?.()
    }
  }

  /**
   * @param {{ messageReady: boolean, cardReady: boolean, cardHint: string, lastError: string }} state
   */
  function onBridgeState(state) {
    if (disposed) return
    if (store.pushLevel() < 2) return
    if (state.cardReady) {
      logger.info('[lark] card callbacks are ready')
      return
    }
    if (state.cardHint !== '' && !store.rememberEvent('card-hint-notified')) {
      logger.warn('[lark] card callbacks are blocked; text-reply answering remains available')
      void transport
        .sendText(
          `dsh-lark-ctrl: 飞书卡片回调尚未开通，按钮/表单暂不可用（文字回复答题仍可用）。\n开通：${state.cardHint}`,
        )
        .catch(() => {})
    }
  }

  /**
   * @param {Awaited<ReturnType<typeof cli.status>>} status
   * @param {{ targetUserId: string, targetChatId: string, userName: string }} target
   */
  async function sendStartupMessage(status, target) {
    if (store.pushLevel() < 2) return
    const lines = [
      '**dsh-lark-ctrl 已上线**',
      `- 推送目标：${target.targetChatId || target.targetUserId}${target.userName ? `（${target.userName}）` : ''}`,
      `- lark-cli：${truncate(status.version || 'unknown', 80)}`,
      `- 插件版本：\`0.3.3\``,
      `- 推送级别：\`L${store.pushLevel()}\``,
      `- 答题模式：\`${config.answerMode}\``,
      `- 审批：\`${config.approvalMode}\``,
      '',
      '发送 `/help` 查看指令；回复任意会话通知即可继续对话。',
    ]
    const card = fitCard(buildNoticeCard(lines.join('\n')))
    await transport.sendCard(card, { idempotencyKey: `startup:${process.pid}:${Date.now()}` })
  }

  // Bootstrap is async; the plugin fiber is registered immediately so the
  // Host can compose and dispose the plugin deterministically.
  void bootstrap()
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof normalizeConfig>} config
 */
function createLogger(ctx, config) {
  const base = ctx.logger
  const write = (level, message) => {
    try {
      if (typeof base?.[level] === 'function') base[level](message)
      else if (level === 'error') console.error(message)
      else if (level === 'warn') console.warn(message)
      else console.log(message)
    } catch {
      // logging must never break the bridge
    }
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    debug: (message) => {
      if (config.debug) write('debug', message)
    },
  }
}

export { normalizeConfig }
