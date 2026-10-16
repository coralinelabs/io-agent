import { runSkillFork } from '../fork.ts'
import { hasVisibleDisclosure, visibleAuthoredUserMessages } from '../../context/visibility.ts'
import { bindSkillArguments, leadingSkillArguments } from '../activation.ts'
/**
 * Durable session skill catalog and model-facing `skill` loader tool.
 *
 * @module io-agent/tool-skill
 */

import { ProgressiveSkills, fitSkillSize } from './progressive.ts'
import { SKILL_TOOL_NAME } from './history.ts'
import { modelText } from "../../context/text/index.ts"
import { catalogDigest, catalogLines, offeredWithTools, previewCatalog, toolAvailability, type CatalogEntry, type CatalogPreview } from '../catalog.ts'
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import z from "../../runtime/vendor/schemastery/index.ts"
import type { Agent, PreStepDecision } from "../../runtime/agents/index.ts"
import { defineTool, type ToolDefinition } from "../../tools/index.ts"
import { createUserMessage } from "../../model/llm/index.ts"
import { SessionSeq, type UserMessage } from "../../session/journal/index.ts"
import {
  isModelInvocable,
  isSkillReference,
  isUserInvocable,
  renderSkillContent,
  type SkillInvocationSource,
} from "../skill/index.ts"

export const name = 'tool-skill'
export const inject = ['agents', 'tools', 'skills']

/** Legacy (non-progressive) index description cap; the full description is the whole index. */
const DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500
/** Progressive index: short descriptions, since skill_list serves the full routing text. */
const PROGRESSIVE_CATALOG_DESCRIPTION_MAX_LENGTH = 120
/** Progressive preview entry cap; the byte cap usually binds first for long descriptions. */
const PROGRESSIVE_CATALOG_MAX_ENTRIES = 100
/**
 * Durable provider and item records for one published session skill catalog. The catalog is a
 * `catalog`-form context, so it records the entries it published beside the
 * model-facing prose: a consumer presenting the list must not re-parse the
 * `<available_skills>` block, whose framing exists for the model.
 */
export interface SkillCatalogSource {
  readonly kind: 'skill-catalog'
  readonly form: 'catalog'
  /** Marks a replacement catalog rather than this session's first publication. */
  readonly update?: true
  /** Marks a bounded preview that omits offered skills; only then does the message point to skill_list. */
  readonly partial?: true
  /** Exactly the entries this message published, in catalog order; `category` is the rendered group label. */
  readonly entries: readonly { readonly name: string; readonly description: string; readonly category?: string }[]
}

declare module "../../model/llm/index.ts" {
  interface MessageSourceMap {
    'skill-catalog': SkillCatalogSource
  }
}

/** Model-facing skill catalog configuration. */
export interface Config {
  /** Add bounded skill_list and guarded skill_read tools. Default false for legacy hosts. */
  progressive?: boolean
  /** Maximum preview entries (progressive default 100); does not limit searchable discovery. */
  catalogMaxEntries?: number
  /** Maximum complete rendered catalog message bytes, including framing and escaping. */
  catalogMaxBytes?: number
  /** Reject, rather than truncate, a rendered skill instruction body above this cap. */
  maxSkillBytes?: number
  /** Maximum normalized description length rendered in the session catalog (progressive 120, legacy 500); minimum 3. */
  catalogDescriptionMaxLength?: number
}

/** Validate and default the model-facing skill catalog configuration. */
export const Config: z<Config> = z.object({
  progressive: z.boolean().default(false),
  catalogMaxEntries: z.number(),
  catalogMaxBytes: z.number(),
  maxSkillBytes: z.number(),
  // No schema default: Cordis applies schema defaults before apply(), which would hide the progressive default.
  catalogDescriptionMaxLength: z.number(),
})

/**
 * Register the model-facing skill loader and its visibility-matched
 * durable session catalog. The catalog is emitted only when the calling agent
 * resolves this plugin's exact tool registration; a restriction or scoped
 * same-name shadow therefore removes both the schema and its call guidance.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const catalogDescriptionMaxLength = config.catalogDescriptionMaxLength
    ?? (config.progressive === true ? PROGRESSIVE_CATALOG_DESCRIPTION_MAX_LENGTH : DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH)
  assertPositiveInteger('catalogDescriptionMaxLength', catalogDescriptionMaxLength, 3)
  const maxEntries = config.catalogMaxEntries ?? (config.progressive === true ? PROGRESSIVE_CATALOG_MAX_ENTRIES : Infinity)
  const maxBytes = config.catalogMaxBytes ?? (config.progressive === true ? 12288 : Infinity)
  const maxSkillBytes = config.maxSkillBytes ?? (config.progressive === true ? 65536 : undefined)
  if (maxEntries !== Infinity) assertPositiveInteger('catalogMaxEntries', maxEntries)
  if (maxBytes !== Infinity) assertPositiveInteger('catalogMaxBytes', maxBytes, 2048)
  if (maxSkillBytes !== undefined) assertPositiveInteger('maxSkillBytes', maxSkillBytes, 1024)
  // Entry lines share the byte cap with the largest frame either message form can carry
  // (first or non-empty update, with the discovery hint), so both forms fit exactly.
  const lineBudget = maxBytes === Infinity ? Infinity : maxBytes - Math.max(
    contentBytes(renderCatalogText(false, [], false, config.progressive === true)),
    contentBytes(renderCatalogText(true, [], false, config.progressive === true)))

  const skillTool: ToolDefinition = defineTool({
    name: SKILL_TOOL_NAME,
    description: modelText('skills/loader-description'),
    parameters: {
      name: { type: 'string', required: true, description: modelText('runtime/tool-skill-index/text-02') },
      arguments: { type: 'string', description: modelText('skills/arguments') },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          resourceBase: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'directory' },
                  path: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'url' },
                  url: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'opaque' },
                  description: { type: 'string', required: true },
                },
              },
            ],
          },
          resourceFiles: {
            type: 'object',
            additionalProperties: false,
            properties: {
              paths: { type: 'array', required: true, items: { type: 'string' } },
              truncated: { type: 'boolean', required: true },
            },
          },
          content: { type: 'string', required: true },
          unchanged: { type: 'boolean' },
          runId: { type: 'string' },
          result: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.runId !== undefined
        ? modelText('skills/fork-result', { name: value.name, run_id: value.runId, result: value.result ?? '' })
        : value.unchanged === true
        ? modelText('skills/unchanged', { name: value.name }) : renderSkillContent(value) }],
    },
    async execute(args, exec) {
      if (!isSkillReference(args.name)) {
        throw new Error(modelText('foundation/tool-skill-index/text-01', { value_1: String(args.name) }))
      }
      // The agent is its own scope key, so the lookup resolves the layered
      // registry exactly as this agent's composition sees it.
      const lookup = { cwd: exec.agent?.session.header.cwd, signal: exec.signal, scope: exec.agent }
      const summary = await ctx.skills.describe(args.name, lookup)
      if (!summary) {
        throw new Error(modelText('foundation/tool-skill-index/text-02', { value_1: String(args.name) }))
      }
      if (!isModelInvocable(summary) && !progressive?.hasForkGrant(exec.agent, summary.name)) {
        throw new Error(modelText('foundation/tool-skill-index/text-03', { value_1: String(args.name) }))
      }
      const skill = await ctx.skills.get(args.name, lookup)
      if (!skill) {
        throw new Error(modelText('foundation/tool-skill-index/text-04', { value_1: String(args.name) }))
      }
      if (!isModelInvocable(skill) && !(skill.execution?.context === 'fork' && progressive?.consumeForkGrant(exec.agent, skill, args.arguments ?? ''))) {
        throw new Error(modelText('foundation/tool-skill-index/text-05', { value_1: String(args.name) }))
      }
      const activated = fitSkillSize({ ...skill, content: bindSkillArguments(skill.content, args.arguments, {
        ...(skill.execution?.argumentNames === undefined ? {} : { argumentNames: skill.execution.argumentNames }),
        ...(skill.resourceBase?.kind === 'directory' ? { skillDirectory: skill.resourceBase.path } : {}),
        ...(exec.agent === undefined ? {} : { sessionId: exec.agent.session.id }),
      }) }, maxSkillBytes)
      if (skill.execution?.context === 'fork') {
        const result = await runSkillFork(ctx, activated, exec, args.arguments ?? '')
        return { name: skill.name, provider: skill.provider, content: '', ...result }
      }
      const unchanged = exec.agent !== undefined
        && hasVisibleDisclosure(exec.agent.session, 'skill', renderSkillContent(activated))
        && skill.metadata?.['setup_needed'] !== true && skill.metadata?.['readiness_status'] !== 'setup_needed'
      return {
        name: skill.name,
        provider: skill.provider,
        ...skill.resourceBase !== undefined ? {
          resourceBase: { ...skill.resourceBase },
        } : {},
        ...activated.resourceFiles !== undefined ? {
          resourceFiles: { paths: [...activated.resourceFiles.paths], truncated: activated.resourceFiles.truncated },
        } : {},
        content: unchanged ? '' : activated.content,
        ...(unchanged ? { unchanged: true } : {}),
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Load skill ${args.name}`, kind: 'read', rawInput: args.name }
    },
  })
  ctx.tools.register(skillTool)
  const progressive: ProgressiveSkills | undefined = config.progressive === true ? new ProgressiveSkills(ctx, skillTool, maxSkillBytes) : undefined

  // User-explicit skill invocation: a claimed user message whose first line
  // starts with `/<name>` naming a user-invocable skill is a deterministic
  // load gesture. The rendered body enters this step as injected
  // instructions context appended after every other injection — background
  // first (workspace rules, runtime policy, the catalog), the material the
  // model must act on last, closest to its answer. Registration order makes
  // that placement deterministic: this listener registers before the catalog
  // listener, so the waterfall hands it the catalog-bearing list to extend.
  // Only `source.kind === 'user'` messages are scanned — external text
  // cannot forge the gesture — and a token naming no user-invocable skill
  // stays ordinary prose (the command registry is a different closed
  // namespace, resolved client-side before a line ever becomes a prompt).
  // This is the only entry point for `disable-model-invocation` skills; the
  // catalog never advertises them; the skill tool accepts only a matching,
  // admitted one-use fork grant when execution needs a child.
  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const names = invokedSkillNames(messages)
    if (names.length === 0) return decision
    signal.throwIfAborted()
    const lookup = { cwd: agent.session.header.cwd, signal, scope: agent }
    const injections: UserMessage[] = []
    for (const name of names) {
      const skill = await ctx.skills.get(name, lookup)
      signal.throwIfAborted()
      // Unknown names and user-disabled skills stay plain prose: the
      // gesture was never a claim this boundary recognizes. The check sits
      // on the loaded definition — the single lookup that produces what is
      // actually injected.
      if (skill === undefined || !isUserInvocable(skill)) continue
      // A fork skill runs only through the loader tool; while that tool is not
      // offered to this agent, its gesture stays prose like an unknown name.
      if (skill.execution?.context === 'fork' && ctx.tools.get(skillTool.name, agent) !== skillTool) continue
      const userText = messages.filter(m => m.source.kind === 'user').flatMap(m => m.content)
        .filter(b => b.type === 'text').map(b => b.text)
        .map(text => leadingSkillArguments(text, name)).find(value => value !== undefined)
      const activated = fitSkillSize({ ...skill, content: bindSkillArguments(skill.content, userText, {
        ...(skill.execution?.argumentNames === undefined ? {} : { argumentNames: skill.execution.argumentNames }),
        ...(skill.resourceBase?.kind === 'directory' ? { skillDirectory: skill.resourceBase.path } : {}),
        sessionId: agent.session.id,
      }) }, maxSkillBytes)
      const source: SkillInvocationSource = { kind: 'skill-invocation', name: skill.name, form: 'instructions' }
      const injection = createUserMessage({
        content: [{ type: 'text', text: skill.execution?.context === 'fork'
          ? modelText('skills/fork-invocation', { name, arguments_json: JSON.stringify(userText ?? '') })
          : renderSkillContent(activated) }],
        source,
      })
      injections.push(injection)
      progressive?.grant(agent, skill, injection.id, userText)
    }
    if (injections.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...injections] }
  })

  // Register after the tool so reverse teardown removes guidance first. Exact definition
  // identity prevents a scoped shadow merely named `skill` from inheriting this catalog.
  //
  // The comparison is against the definition this plugin registered, not against
  // a lookup of its own name: `register()` files into the CALLING context's
  // scope, so a plugin mounted inside an agent preset registers for that agent
  // alone and an unscoped lookup correctly finds nothing.
  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    const toolVisible = ctx.tools.get(skillTool.name, agent) === skillTool
      && (progressive === undefined || ctx.tools.get(progressive.listTool.name, agent) === progressive.listTool)
    const snapshot = toolVisible
      ? await ctx.skills.snapshot({ cwd: agent.session.header.cwd, signal, scope: agent })
      : { skills: [], complete: true }
    signal.throwIfAborted()
    if (!snapshot.complete) return decision
    // Offer-time tool conditions read this agent's resolved view: restrictions, subagent
    // allowed-tools and scoped registrations all count, exactly as the loader check above.
    const hasTool = toolAvailability(name => ctx.tools.get(name, agent) !== undefined)
    const skills = snapshot.skills.filter(skill => isModelInvocable(skill) && offeredWithTools(skill, hasTool))
    const preview = previewCatalog(skills, { limit: maxEntries, descriptionLimit: catalogDescriptionMaxLength, lineBudget })
    const digest = catalogDigest(preview.entries, preview.partial)
    const history = catalogHistory(agent)
    const existing = catalogMessage(decision.messages)
    if (history.visibleDigest === digest) {
      return existing === undefined
        ? decision
        : { ...decision, messages: decision.messages.filter(message => message.id !== existing.message.id) }
    }
    if (existing !== undefined && catalogDigest(existing.entries, existing.partial) === digest) return decision
    if (!history.published && skills.length === 0) {
      return existing === undefined
        ? decision
        : { ...decision, messages: decision.messages.filter(message => message.id !== existing.message.id) }
    }
    const catalog = history.published
      ? renderCatalogUpdate(preview, progressive !== undefined)
      : renderCatalogMessage(preview, progressive !== undefined)
    return {
      ...decision,
      messages: existing === undefined
        ? [...decision.messages, catalog]
        : decision.messages.map(message => message.id === existing.message.id ? catalog : message),
    }
  })
}

/**
 * One catalog text. The discovery hint appears only for a progressive preview that omits
 * offered skills; a complete preview is the whole offer and needs no search pointer.
 */
function renderCatalogText(update: boolean, entries: readonly CatalogEntry[], empty: boolean, hint: boolean): string {
  const availability = !update
    ? [modelText('runtime/tool-skill-index/text-04'), modelText('runtime/tool-skill-index/text-05')]
    : empty
    ? [modelText('runtime/tool-skill-index/text-06'), modelText('runtime/tool-skill-index/text-07')]
    : [modelText('runtime/tool-skill-index/text-08'), modelText('runtime/tool-skill-index/text-09')]
  return [
    '<system-reminder>',
    modelText(update ? 'runtime/tool-skill-index/text-10' : 'runtime/tool-skill-index/text-03'),
    '',
    '<available_skills>',
    ...catalogLines(entries),
    '</available_skills>',
    '',
    ...availability,
    ...hint ? [modelText('skills/discovery-hint')] : [],
    '</system-reminder>',
  ].join('\n')
}

/** Exact serialized size of a single-text message content, as the byte cap measures it. */
function contentBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify([{ type: 'text', text }]), 'utf8')
}

function renderCatalogMessage(preview: CatalogPreview, progressive = false): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: renderCatalogText(false, preview.entries, preview.entries.length === 0, progressive && preview.partial) }],
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      ...preview.partial ? { partial: true } : {},
      entries: preview.entries,
    },
  })
}

function renderCatalogUpdate(preview: CatalogPreview, progressive = false): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: renderCatalogText(true, preview.entries, preview.entries.length === 0, progressive && preview.partial) }],
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      update: true,
      ...preview.partial ? { partial: true } : {},
      entries: preview.entries,
    },
  })
}

/**
 * Entries of one durable catalog message, or undefined when the record is not a
 * usable catalog.
 *
 * `agent.session.snapshotEvents()` may contain a resumed, forked, or externally written seed,
 * and seed validation only guarantees a source object with a non-empty `kind`;
 * no per-kind field is checked there. An unreadable record is therefore treated
 * as "not this plugin's catalog" — the posture the replaced content digest had —
 * rather than throwing inside the step listener, which would fail every
 * subsequent turn of that session.
 */
function readCatalog(source: unknown): { entries: CatalogEntry[]; partial: boolean } | undefined {
  const { entries, partial } = source as { entries?: unknown; partial?: unknown }
  if (!Array.isArray(entries)) return undefined
  const readable: CatalogEntry[] = []
  for (const entry of entries as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { name, description, category } = entry as { name?: unknown; description?: unknown; category?: unknown }
    if (typeof name !== 'string' || name === '' || typeof description !== 'string') return undefined
    if (category !== undefined && (typeof category !== 'string' || category === '')) return undefined
    readable.push({ name, description, ...(category === undefined ? {} : { category }) })
  }
  return { entries: readable, partial: partial === true }
}

const publishedCatalogs = new WeakSet<Agent['session']>()
function catalogHistory(agent: Agent): { visibleDigest?: string; published: boolean } {
  const message = visibleAuthoredUserMessages(agent.session).findLast(message =>
    message.source.kind === 'skill-catalog' && readCatalog(message.source) !== undefined)
  if (message !== undefined) {
    publishedCatalogs.add(agent.session)
    const visible = readCatalog(message.source)!
    return { visibleDigest: catalogDigest(visible.entries, visible.partial), published: true }
  }
  if (publishedCatalogs.has(agent.session)) return { published: true }
  let published = false
  for (let index = agent.session.seq - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = agent.session.eventAt(SessionSeq(index))
    if (event === undefined) {
      throw new Error(modelText('runtime/tool-skill-index/text-11', { value_1: String(String(index)) }))
    }
    if (event.type !== 'user/message' || event.data.source.kind !== 'skill-catalog') continue
    if (readCatalog(event.data.source) === undefined) continue
    published = true
    publishedCatalogs.add(agent.session)
    break
  }
  return { published }
}

function catalogMessage(
  messages: readonly UserMessage[],
): { message: UserMessage; entries: CatalogEntry[]; partial: boolean } | undefined {
  for (const message of messages) {
    if (message.source.kind !== 'skill-catalog') continue
    const catalog = readCatalog(message.source)
    if (catalog !== undefined) return { message, ...catalog }
  }
  return undefined
}

function assertPositiveInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(modelText('runtime/tool-skill-index/text-12', { value_1: String(name), value_2: String(minimum) }))
  }
}

/**
 * A whitespace-bounded `/name` token (the public skill-name grammar) anywhere
 * in the text — the same word-boundary shape the transcript chip decoration
 * uses, so a gesture reads as one wherever it sits in the sentence. A second
 * `/` or any non-boundary character breaks the match, which keeps file paths
 * (`/usr/bin`) and fractions (`5/8`) out.
 */
const SKILL_GESTURE = /(^|\s)\/([A-Za-z0-9%_.~:@/-]+)(?=\s|$)/g

/**
 * `/name` gesture tokens from the claimed user messages, deduplicated in
 * first-seen order. Every text block of direct user input is scanned; no
 * other source can forge a gesture.
 * @param messages - the step's claimed batch.
 * @returns candidate skill names, unvalidated against the registry.
 */
function invokedSkillNames(messages: readonly UserMessage[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    if ((message.source as { kind?: unknown }).kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const name = match[2]
        if (name !== undefined && isSkillReference(name) && !names.includes(name)) names.push(name)
      }
    }
  }
  return names
}
