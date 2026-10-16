import { afterEach, describe, expect, it } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import SystemPrompt, { renderContextSnapshot, renderPrompt } from "../../../src/library/context/assembly/index.ts"
import type { AssembleContext } from "../../../src/library/context/assembly/index.ts"
import SessionStore, { SessionId } from "../../../src/library/session/journal/index.ts"
import type { Agent } from "../../../src/library/runtime/agents/index.ts"
import { createSystemMessage, ToolCallId } from "../../../src/library/model/llm/index.ts"
import ToolRuntime from "../../../src/library/tools/index.ts"
import McpResources from "../../../src/library/mcp/mcp-resources/index.ts"
import { createScope } from "../../../src/library/runtime/scope/index.ts"
import { instructionUpdate, registerServerContext } from "../../../src/library/mcp/mcp-client/server-context.ts"
import { modelText } from "../../../src/library/context/text/index.ts"

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

async function setup() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(McpResources)
  return ctx
}

describe('MCP server context', () => {
  it('pins the first instructions in the system prompt, states later changes as literal runtime context, and withdraws both with the plugin', async () => {
    const ctx = await setup()
    const pinned = 'MCP server: docs\nKeep {{server.template}} literal.'
    let live = pinned
    const fiber = await ctx.plugin({ apply(inner: Context) {
      registerServerContext(inner, 'docs', {
        resources: { request: async () => ({ resources: [] }) },
        instructions: () => live,
        pinnedInstructions: () => pinned,
      })
    } })
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain(pinned)
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble())).toBe('')

    live = 'MCP server: docs\nUpdated {{other.template}} instructions.'
    let assembly = await ctx.systemPrompt.assemble()
    // The system prompt stays byte-identical; the change is appended as context.
    expect(renderPrompt(assembly)).toBe(prompt)
    expect(renderContextSnapshot(assembly)).toContain(modelText('mcp/server-instructions-updated', { name: 'docs', instructions: live }))

    live = ''
    assembly = await ctx.systemPrompt.assemble()
    expect(renderPrompt(assembly)).toBe(prompt)
    expect(renderContextSnapshot(assembly)).toContain(modelText('mcp/server-instructions-withdrawn', { name: 'docs' }))

    await fiber.dispose()
    assembly = await ctx.systemPrompt.assemble()
    expect(renderPrompt(assembly)).not.toContain('MCP server: docs')
    expect(renderContextSnapshot(assembly)).toBe('')
    const result = await ctx.tools.execute({
      name: 'list_mcp_resources', arguments: { server: 'docs' },
      callId: ToolCallId('disposed-resource'), signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
  })

  it('states nothing while the live text equals the pinned text, including a server that first published none', () => {
    expect(instructionUpdate('docs', '', '')).toBe('')
    expect(instructionUpdate('docs', 'A', 'A')).toBe('')
    expect(instructionUpdate('docs', 'B', ''))
      .toBe(modelText('mcp/server-instructions-updated', { name: 'docs', instructions: 'B' }))
    expect(instructionUpdate('docs', '', 'A'))
      .toBe(modelText('mcp/server-instructions-withdrawn', { name: 'docs' }))
  })

  it('shows a session the instructions and resource list its recorded prompt holds, and states the rest as context', async () => {
    const ctx = await setup()
    await ctx.plugin(SessionStore)
    const pinned = 'MCP server: docs\nDocs instructions.'
    let live = pinned
    await ctx.plugin({ apply(inner: Context) {
      registerServerContext(inner, 'docs', {
        resources: { request: async () => ({ resources: [] }) },
        instructions: () => live,
        pinnedInstructions: () => pinned,
      })
    } })
    const resourceList = modelText('mcp/resource-servers', { servers: JSON.stringify(['docs']) })
    /** An agent whose session committed a prompt with these sections (none: no prompt yet). */
    const agentWith = (id: string, sections?: { name: string; text: string }[]): AssembleContext => {
      const session = ctx.sessions.create(SessionId(id))
      if (sections !== undefined) {
        session.append('system/message', { turn: 1, step: 1,
          message: createSystemMessage(sections.map(section => section.text).join('\n\n'), 'fixture', sections) }, { surfaceOp: 'append' })
      }
      return { agent: { session } as unknown as Agent }
    }
    const render = async (context: AssembleContext) => {
      const assembly = await ctx.systemPrompt.assemble(context)
      return { prompt: renderPrompt(assembly), context: renderContextSnapshot(assembly) }
    }
    const firstInstructions = modelText('mcp/server-instructions-updated', { name: 'docs', instructions: pinned })
    const resourcesNow = modelText('mcp/resource-servers-updated', { servers: JSON.stringify(['docs']) })

    // No prompt yet: the prompt shows the server as this process first saw it, and nothing needs stating.
    expect(await render(agentWith('fresh'))).toEqual({ prompt: expect.stringContaining(pinned), context: '' })
    // A prompt recorded before the server connected keeps showing no server; the context states it.
    const before = await render(agentWith('before', [{ name: 'persona', text: 'Persona.' }]))
    expect(before.prompt).not.toContain('MCP server: docs')
    expect(before.prompt).not.toContain(resourceList)
    expect(before.context).toContain(firstInstructions)
    expect(before.context).toContain(resourcesNow)
    // A prompt recorded with other text (an earlier process) keeps it; the context states the live text.
    const earlier = await render(agentWith('earlier', [{ name: 'mcp-resource-servers', text: resourceList }, { name: 'mcp:docs', text: 'MCP server: docs\nV1.' }]))
    expect(earlier.prompt).toContain(`${resourceList}\n\nMCP server: docs\nV1.`)
    expect(earlier.prompt).not.toContain('Docs instructions.')
    expect(earlier.context).toContain(firstInstructions)
    expect(earlier.context).not.toContain(resourcesNow)
    // Withdrawn text is stated against what the session's prompt shows.
    live = ''
    expect((await render(agentWith('withdrawn', [{ name: 'mcp:docs', text: pinned }]))).context)
      .toContain(modelText('mcp/server-instructions-withdrawn', { name: 'docs' }))
    expect((await render(agentWith('never', [{ name: 'persona', text: 'Persona.' }]))).context)
      .not.toContain('MCP server docs no longer provides')
  })

  it('shows scoped server instructions only to the owning scope', async () => {
    const ctx = await setup()
    const scopeKey = {}
    await ctx.plugin({ apply(inner: Context) {
      const scoped = createScope(inner, scopeKey)
      registerServerContext(scoped.ctx, 'private', {
        resources: { request: async () => ({ resources: [] }) },
        instructions: () => 'Private server instructions, revised.',
        pinnedInstructions: () => 'Private server instructions.',
      })
    } })
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: scopeKey }))).toContain('Private server instructions.')
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ scope: scopeKey }))).toContain('Private server instructions, revised.')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('Private server instructions')
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble())).not.toContain('Private server instructions')
  })
})
