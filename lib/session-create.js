/**
 * Session creation options and the create → permission → model → prompt flow.
 *
 * The order is deliberate: the permission preset and model must be installed
 * before the first prompt opens the session's first turn.
 */

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<{ agentPresets: any[], models: any[], efforts: any[], permissions: any[], defaults: Record<string, string> }>}
 */
export async function loadCreationOptions(ctx) {
  const agentPresets = []
  const agentRegistry = ctx.get('agentPresets')
  if (agentRegistry !== undefined) {
    try {
      const presets = await agentRegistry.list()
      for (const preset of presets) {
        if (typeof preset?.id !== 'string' || preset.id === '' || typeof preset.broken === 'string') continue
        agentPresets.push({
          value: preset.id,
          text: typeof preset.name === 'string' && preset.name !== '' ? preset.name : preset.id,
          description: typeof preset.description === 'string' ? preset.description : undefined,
        })
      }
    } catch {
      // The card simply omits the selector.
    }
  }

  const models = []
  const efforts = [{ value: '', text: '默认（模型决定）' }]
  const effortSeen = new Set([''])
  let modelCatalog
  try {
    modelCatalog = await ctx.sessionController.modelCatalog()
    for (const group of modelCatalog?.groups ?? []) {
      for (const model of group.models ?? []) {
        if (typeof model?.id !== 'string' || typeof group?.id !== 'string') continue
        const modelEfforts = Array.isArray(model.reasoning?.efforts) ? model.reasoning.efforts : []
        models.push({
          value: `${group.id}::${model.id}`,
          text: `${group.name ?? group.id} · ${model.name ?? model.id}`,
          provider: group.id,
          model: model.id,
          efforts: modelEfforts.map((effort) => effort.id).filter((id) => typeof id === 'string'),
          defaultEffort: typeof model.reasoning?.defaultEffort === 'string' ? model.reasoning.defaultEffort : '',
        })
        for (const effort of modelEfforts) {
          if (typeof effort?.id !== 'string' || effort.id === '' || effortSeen.has(effort.id)) continue
          effortSeen.add(effort.id)
          efforts.push({
            value: effort.id,
            text: typeof effort.name === 'string' && effort.name !== '' ? effort.name : effort.id,
          })
        }
      }
    }
  } catch {
    // no model catalog; the default model applies.
  }
  const defaultModelValue = modelCatalog?.default === undefined
    ? ''
    : `${modelCatalog.default.provider}::${modelCatalog.default.model}`
  const defaultEffort = models.find((model) => model.value === defaultModelValue)?.defaultEffort ?? ''

  const permissions = []
  let permissionCatalog
  const permissionService = ctx.get('permissionPresets')
  if (permissionService !== undefined) {
    try {
      permissionCatalog = permissionService.catalog()
      for (const option of permissionCatalog?.options ?? []) {
        if (typeof option?.value !== 'string' || option.value === '') continue
        permissions.push({
          value: option.value,
          text: typeof option.name === 'string' && option.name !== '' ? option.name : option.value,
          description: typeof option.description === 'string' ? option.description : undefined,
        })
      }
    } catch {
      // no permission catalog; session defaults apply.
    }
  }

  return {
    agentPresets: dedupe(agentPresets).slice(0, 30),
    models: dedupe(models).slice(0, 40),
    efforts: efforts.slice(0, 20),
    permissions: dedupe(permissions).slice(0, 20),
    defaults: {
      agentPreset: agentPresets.length > 0
        ? (typeof agentRegistry?.defaultId === 'string' ? agentRegistry.defaultId : agentPresets[0].value)
        : '',
      model: defaultModelValue,
      effort: effortSeen.has(defaultEffort) ? defaultEffort : '',
      permission: typeof permissionCatalog?.defaultPreset === 'string' ? permissionCatalog.defaultPreset : '',
    },
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} input
 * @param {string} input.workspaceId
 * @param {string} [input.agentPreset]
 * @param {string} [input.model]
 * @param {string} [input.permission]
 * @param {string} input.prompt
 * @param {string} input.requestId
 * @returns {Promise<{ sessionId: string, agentPreset?: string, session: any }>}
 */
export async function createSessionOnly(ctx, input) {
  const created = await ctx.sessionController.create({
    workspaceId: input.workspaceId,
    ...(input.agentPreset ? { agentPreset: input.agentPreset } : {}),
  })
  const session = await resolveSession(ctx, created.sessionId)
  return { sessionId: created.sessionId, agentPreset: created.agentPreset, session }
}

/**
 * Apply the permission preset and model selection before the first turn.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 * @param {{ permission?: string, model?: string, effort?: string }} input
 */
export async function applySessionOptions(ctx, sessionId, input) {
  const session = await resolveSession(ctx, sessionId)
  if (input.permission) {
    const service = ctx.get('permissionPresets')
    if (service === undefined) throw new Error('权限预设服务不可用。')
    service.set(session, input.permission)
  }
  if (input.model) {
    const parsed = parseModel(input.model)
    if (parsed === undefined) throw new Error('模型选项无效。')
    await ctx.sessionController.selectModel({
      sessionId,
      provider: parsed.provider,
      model: parsed.model,
      ...(typeof input.effort === 'string' && input.effort !== ''
        ? { reasoningEffort: input.effort }
        : {}),
    })
  } else if (typeof input.effort === 'string' && input.effort !== '') {
    throw new Error('选择 Thinking effort 前需要先选择模型。')
  }
}

/**
 * Send the first prompt with a stable request id so a retry cannot duplicate
 * an accepted prompt.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 * @param {string} prompt
 * @param {string} requestId
 */
/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 * @param {string} prompt
 * @param {string} requestId
 * @param {Array<Record<string, unknown>>} [blocks] leading content blocks (e.g. images)
 */
export async function sendSessionPrompt(ctx, sessionId, prompt, requestId, blocks = []) {
  const content = [...blocks]
  if (prompt !== '') content.push({ type: 'text', text: prompt })
  await ctx.sessionController.prompt(
    {
      requestId,
      sessionId,
      mode: 'queue',
      content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    },
    new AbortController().signal,
  )
}

/**
 * Convenience wrapper used by tests and simple callers.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} input
 */
export async function createSessionWithPrompt(ctx, input) {
  const created = await createSessionOnly(ctx, input)
  await applySessionOptions(ctx, created.sessionId, input)
  await sendSessionPrompt(ctx, created.sessionId, input.prompt, input.requestId)
  return created
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 */
async function resolveSession(ctx, sessionId) {
  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) return live
  const resumed = await ctx.sessionController.resolveAgent(sessionId)
  if (resumed?.agent?.session === undefined) throw new Error('会话已创建，但无法恢复为 live。')
  return resumed.agent.session
}

/** @param {string} value */
export function parseModel(value) {
  const [provider, ...rest] = String(value ?? '').split('::')
  const model = rest.join('::')
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

/** @param {Array<{ value: string }>} options */
function dedupe(options) {
  const seen = new Set()
  const out = []
  for (const option of options) {
    if (seen.has(option.value)) continue
    seen.add(option.value)
    out.push(option)
  }
  return out
}
