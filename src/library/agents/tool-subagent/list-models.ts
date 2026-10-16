/** Model-facing discovery of LLM routes available to child Agents. */

import { modelText } from "../../context/text/index.ts"
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import type LlmRuntime from "../../model/llm/index.ts"
import type { LlmProviderInfo } from "../../model/llm/index.ts"
import { defineTool } from "../../tools/index.ts"
import type { ModelSelectionPolicy } from './model-selection.ts'

interface ListSubagentModelsRequest {
  readonly provider?: string
  readonly model?: string
}

/** Resolve one registered provider with a model-correctable diagnostic. */
function registeredProvider(
  llm: LlmRuntime,
  policy: ModelSelectionPolicy,
  providerId: string,
): LlmProviderInfo {
  const providers = llm.listProviders()
  const provider = providers.find(candidate => candidate.id === providerId)
  if (provider !== undefined) return provider
  const available = providers
    .filter(candidate => policy.routes.some(route => route.provider === candidate.id))
    .map(candidate => candidate.id)
    .join(', ') || '(none)'
  throw new Error(modelText('runtime/tool-subagent-list-models/text-01', { value_1: String(providerId), value_2: String(available) }))
}

/** Render one advertised or resolved model. */
function modelLine(provider: string, model: { id: string; name: string; description?: string }): string {
  return `${provider}/${model.id} — ${model.name}${model.description === undefined ? '' : `: ${model.description}`}`
}

/** Read the requested provider, advertised models, or exact-model efforts. */
async function listSubagentModels(
  ctx: Context,
  policy: ModelSelectionPolicy,
  request: ListSubagentModelsRequest,
  signal: AbortSignal,
): Promise<string> {
  const llm = ctx.get('llm')
  if (llm === undefined) {
    throw new Error(modelText('runtime/tool-subagent-list-models/text-02'))
  }
  if (request.model !== undefined && request.provider === undefined) {
    throw new Error('`model` requires `provider`')
  }
  if (request.provider === undefined) {
    const providers = llm.listProviders()
      .filter(provider => policy.routes.some(route => route.provider === provider.id))
    return providers.length === 0
      ? '(no LLM providers)'
      : providers.map(provider => `${provider.id} — ${provider.name}`).join('\n')
  }
  if (request.provider.length === 0) throw new Error(modelText('foundation/tool-subagent-list-models/text-01'))
  const allowedRoutes = policy.routes.filter(route => route.provider === request.provider)
  if (allowedRoutes.length === 0) {
    throw new Error(modelText('foundation/tool-subagent-list-models/text-02', { value_1: String(request.provider) }))
  }
  const provider = registeredProvider(llm, policy, request.provider)
  if (request.model === undefined) {
    const models = (await llm.listModels(provider.id))
      .filter(model => allowedRoutes.some(route => route.model === model.id))
    return models.length === 0
      ? `(no advertised models for ${provider.id})`
      : models.map(model => modelLine(provider.id, model)).join('\n')
  }
  if (request.model.length === 0) throw new Error(modelText('foundation/tool-subagent-list-models/text-03'))
  if (!allowedRoutes.some(route => route.model === request.model)) {
    throw new Error(modelText('runtime/tool-subagent-list-models/text-03', { value_1: String(provider.id), value_2: String(request.model) }))
  }
  const model = await llm.resolveModelInfo(provider.id, request.model, signal)
  const efforts = model.reasoning?.efforts.map(effort => (
    `${effort.id}${model.reasoning?.defaultEffort === effort.id ? ' (default)' : ''} — ${effort.name}`
    + (effort.description === undefined ? '' : `: ${effort.description}`)
  )).join('\n') || '(no advertised reasoning efforts)'
  return modelText('foundation/tool-subagent-list-models/text-04', { value_1: String(modelLine(provider.id, model)), value_2: String(efforts) })
}

/**
 * Register `list_subagent_models` for one owning delegation-tool instance.
 * @param ctx - Context whose tool registry owns the fixed discovery definition.
 * @param policy - Route policy captured for this Session.
 */
export function registerListSubagentModels(ctx: Context, policy: ModelSelectionPolicy): void {
  ctx.tools.register(defineTool({
    name: 'list_subagent_models',
    description:
      modelText('runtime/tool-subagent-list-models/text-04'),
    parameters: {
      provider: {
        type: 'string',
        description: modelText('runtime/tool-subagent-list-models/text-05'),
      },
      model: {
        type: 'string',
        description: modelText('runtime/tool-subagent-list-models/text-06'),
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: result }],
    },
    execute(args, exec) {
      return listSubagentModels(ctx, policy, args, exec.signal)
    },
  }))
}
