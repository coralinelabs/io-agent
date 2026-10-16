import { hasVisibleDisclosure } from '../../context/visibility.ts'
import { catalogPage, offeredWithTools, toolAvailability } from '../catalog.ts'
/** Progressive disclosure layered on the existing skill registry and read pipeline. */
import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import type { Agent } from "../../runtime/agents/index.ts"
import type { Session } from "../../session/journal/index.ts"
import { ToolCallId } from "../../model/llm/index.ts"
import type { MessageId } from "../../model/llm/index.ts"
import { defineTool } from "../../tools/index.ts"
import type { ToolDefinition } from "../../tools/index.ts"
import type {} from "../../filesystem/fs/index.ts"
import { isModelInvocable, isSkillReference, renderSkillContent } from "../skill/index.ts"
import type { SkillDefinition } from "../skill/index.ts"
import { modelText } from "../../context/text/index.ts"

const PAGE_BYTES = 16384

/**
 * Fit one loaded skill into the byte limit of its rendered `<skill_content>` block, wrapper
 * included. Only the instructions and wrapper decide refusal, measured exactly as before
 * supporting-file listings existed, so an optional listing never makes a skill unloadable.
 * When the listing alone overflows the limit, it keeps the longest prefix that fits and is
 * marked truncated, or is left out when not even its header and notice fit.
 * @param skill - the definition about to be rendered, arguments already bound.
 * @param limit - the configured `maxSkillBytes`, or undefined for no limit.
 * @returns the definition to render: the input itself whenever it already fits.
 */
export function fitSkillSize(skill: SkillDefinition, limit: number | undefined): SkillDefinition {
  if (limit === undefined) return skill
  const fits = (value: SkillDefinition): boolean => Buffer.byteLength(renderSkillContent(value), 'utf8') <= limit
  if (fits(skill)) return skill
  const { resourceFiles, ...bare } = skill
  if (resourceFiles === undefined || !fits(bare)) {
    throw new Error(modelText('skills/body-too-large', { name: skill.name, limit }))
  }
  for (let keep = resourceFiles.paths.length - 1; keep >= 0; keep -= 1) {
    const shortened: SkillDefinition = { ...bare, resourceFiles: { paths: resourceFiles.paths.slice(0, keep), truncated: true } }
    if (fits(shortened)) return shortened
  }
  return bare
}

function fingerprint(skill: SkillDefinition): string {
  // Bind the grant to origin, routing, body and invocation policy, not just the
  // globally reusable name. Changing any of these revokes the old grant.
  return createHash('sha256').update(JSON.stringify([
    skill.name, skill.provider, skill.source, skill.path, skill.resourceBase,
    skill.invocation, skill.execution, skill.description, skill.whenToUse, skill.metadata, skill.content,
  ])).digest('hex')
}

/** Registration owner. No independent skill store or executor is introduced. */
export class ProgressiveSkills {
  readonly listTool: ToolDefinition
  readonly readTool: ToolDefinition
  private readonly grants = new WeakMap<Session, Map<string, { digest: string; messageId: MessageId; admitted: boolean; argumentsText?: string; used?: boolean }>>()

  constructor(ctx: Context, loader: ToolDefinition, maxSkillBytes?: number) {
    const grants = this.grants
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message' || event.data.source.kind !== 'skill-invocation') return
      const grant = grants.get(session)?.get(event.data.source.name)
      if (grant?.messageId === event.data.id) grant.admitted = true
    })
    this.listTool = defineTool({
      name: 'skill_list',
      description: modelText('skills/list-description'),
      parameters: {
        revision: { type: 'string', description: modelText('skills/page-revision') },
        query: { type: 'string', description: modelText('skills/list-query') },
        offset: { type: 'number', description: modelText('skills/list-offset') },
        limit: { type: 'number', description: modelText('skills/list-limit') },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            revision: { type: 'string', required: true },
            total: { type: 'integer', required: true },
            offset: { type: 'integer', required: true },
            nextOffset: { type: 'integer' },
            skipped: { type: 'integer', required: true },
            complete: { type: 'boolean', required: true },
            skills: { type: 'array', required: true, items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                category: { type: 'string' },
              },
            } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const query = (args.query ?? '').trim().toLowerCase(), offset = args.offset ?? 0, limit = args.limit ?? 30
        if (query.length > 256 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw new Error(modelText('skills/invalid-page'))
        }
        const snapshot = await ctx.skills.snapshot({ cwd: exec.agent?.session.header.cwd, signal: exec.signal, scope: exec.agent })
        exec.signal.throwIfAborted()
        // The same offer-time tool conditions as the session catalog, so a hidden skill leaves
        // total, paging and revision alike. Loading by exact name is unaffected.
        const hasTool = toolAvailability(name => ctx.tools.get(name, exec.agent) !== undefined)
        const offered = snapshot.skills.filter(skill => offeredWithTools(skill, hasTool))
        const page = catalogPage(offered, snapshot.complete, { query, offset, limit, maxBytes: PAGE_BYTES })
        if (args.revision !== undefined && args.revision !== page.revision) {
          throw new Error(modelText('skills/catalog-changed'))
        }
        return page
      },
    })
    this.readTool = defineTool({
      name: 'skill_read',
      description: modelText('skills/read-description'),
      parameters: {
        name: { type: 'string', required: true, description: modelText('runtime/tool-skill-index/text-02') },
        path: { type: 'string', required: true, description: modelText('skills/read-path') },
        offset: { type: 'number', description: modelText('skills/read-offset') },
        limit: { type: 'number', description: modelText('skills/read-limit') },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        if (!isSkillReference(args.name)) throw new Error(modelText('foundation/tool-skill-index/text-01', { value_1: args.name }))
        const lookup = { cwd: exec.agent?.session.header.cwd, signal: exec.signal, scope: exec.agent }
        const summary = await ctx.skills.describe(args.name, lookup)
        if (summary === undefined) throw new Error(modelText('foundation/tool-skill-index/text-02', { value_1: args.name }))
        const grant = exec.agent === undefined ? undefined : grants.get(exec.agent.session)?.get(summary.name)
        if (!isModelInvocable(summary) && grant === undefined) throw new Error(modelText('skills/invocation-required', { name: args.name }))
        const skill = await ctx.skills.get(args.name, lookup)
        exec.signal.throwIfAborted()
        if (skill === undefined) throw new Error(modelText('foundation/tool-skill-index/text-04', { value_1: args.name }))
        fitSkillSize(skill, maxSkillBytes)
        if (!isModelInvocable(skill)) {
          // A pre-step proposal is not authorization until its injection is
          // durably admitted. Grants intentionally do not survive a reopen.
          if (grant?.admitted !== true || grant.digest !== fingerprint(skill)) {
            throw new Error(modelText('skills/invocation-required', { name: args.name }))
          }
        }
        const fs = ctx.get('fs')
        if (skill.resourceBase?.kind !== 'directory' || fs === undefined || ctx.tools.get('read', exec.agent) === undefined) {
          throw new Error(modelText('skills/resource-unavailable'))
        }
        if (args.path.length === 0 || args.path.includes('\0') || args.path.includes('\\') || isAbsolute(args.path)
          || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(args.path) || args.path.split('/').some(segment => segment === '..' || segment === '')) {
          throw new Error(modelText('skills/resource-path-denied'))
        }
        const base = await fs.resolve(skill.resourceBase.path, { signal: exec.signal })
        const target = await fs.resolve(resolve(fs.processPath(base), args.path), { signal: exec.signal })
        if (!fs.contains(base, target)) throw new Error(modelText('skills/resource-path-denied'))
        // Use the canonical target and the ordinary nested tools pipeline. A
        // read restriction, guard, post-policy or cancellation remains final.
        const read = await ctx.tools.execute({
          callId: ToolCallId(`${exec.callId}:skill-read`), rootCallId: exec.rootCallId,
          parent: exec.token, name: 'read', signal: exec.signal,
          ...(exec.agent === undefined ? {} : { agent: exec.agent }),
          arguments: { file_path: fs.processPath(target),
            ...(args.offset === undefined ? {} : { offset: args.offset }),
            ...(args.limit === undefined ? {} : { limit: args.limit }) },
        })
        for (const context of read.additionalContexts ?? []) exec.deferContext(context)
        if (read.isError) throw new Error(read.error.message)
        if (read.concludesTurn === true) exec.concludeTurn()
        const rendered = modelText('skills/resource-result', { name: args.name, path: args.path,
          result: read.content.filter(block => block.type === 'text').map(block => block.text).join('\n') })
        return { text: exec.agent !== undefined && hasVisibleDisclosure(exec.agent.session, 'skill_read', rendered)
          ? modelText('skills/resource-unchanged', { name: args.name, path: args.path }) : rendered }
      },
    })
    ctx.tools.register(this.listTool)
    ctx.tools.register(this.readTool)
    ctx.tools.guard(exec => (exec.name === this.listTool.name || exec.name === this.readTool.name)
      && ctx.tools.get(loader.name, exec.agent) !== loader ? modelText('skills/loader-unavailable') : undefined)
  }

  hasForkGrant(agent: Agent | undefined, name: string): boolean {
    const grant = agent === undefined ? undefined : this.grants.get(agent.session)?.get(name)
    return grant?.admitted === true && grant.argumentsText !== undefined && grant.used !== true
  }

  /** Exact user invocation authorizes one isolated execution, never a successor or edited skill. */
  consumeForkGrant(agent: Agent | undefined, skill: SkillDefinition, args: string): boolean {
    if (agent === undefined) return false
    const grant = this.grants.get(agent.session)?.get(skill.name)
    if (grant?.admitted !== true || grant.used === true || grant.argumentsText !== args || grant.digest !== fingerprint(skill)) return false
    grant.used = true
    return true
  }

  /** The proposal id must later be present in the authoritative log to confer access. */
  grant(agent: Agent, skill: SkillDefinition, messageId: MessageId, argumentsText?: string): void {
    let grants = this.grants.get(agent.session)
    if (grants === undefined) { grants = new Map(); this.grants.set(agent.session, grants) }
    grants.set(skill.name, { digest: fingerprint(skill), messageId, admitted: false, ...(skill.execution?.context === 'fork' ? { argumentsText: argumentsText ?? '', used: false } : {}) })
  }
}
