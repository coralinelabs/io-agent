/**
 * Security checks: recall never reads another session, and
 * the deferred-MCP bridge never widens what a scope may call or skips the host's approval.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { fixture, stream, tool } from './fixture.ts'
import type { Request } from './fixture.ts'
import { hostFixture, pending, turn } from './host-fixture.ts'

const many = fileURLToPath(new URL('./fixtures/mcp-many-i8.mjs', import.meta.url))
const manyServer = (log: string) => [{ transport: 'stdio' as const, serverName: 'many', command: process.execPath, args: [many, '30', log], reconnect: { enabled: false } }]
const names = (request: Request): string[] => request.tools!.map(t => t.function.name)
const toolText = (request: Request): string => JSON.stringify(request.messages.filter(m => m.role === 'tool').map(m => m.content))
const loggedCalls = async (log: string): Promise<unknown[]> =>
  (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown)

describe('security review', () => {
  it('recall in a delegated child reads only the child\'s own session', async () => {
    const { app, requests } = await fixture((request, res, i) => {
      if (i === 0) return tool(res, 'subagent', { description: 'Look back', prompt: 'Recall what you can.', run_in_background: false }, 'delegate')
      if (i === 1) return tool(res, 'recall', { query: 'PARENT_ONLY_SECRET' }, 'child-recall')
      if (i === 2) return stream(res, [{ content: 'Nothing found.' }])
      return stream(res, [{ content: 'Done.' }])
    })
    await (await app.createSession()).run('PARENT_ONLY_SECRET is the codename. Delegate a look back.')
    // The child's history never carried the parent's words, and its recall found nothing of them.
    expect(JSON.stringify(requests[1]!.messages)).not.toContain('PARENT_ONLY_SECRET is the codename')
    expect(toolText(requests[2]!)).toContain('No earlier event matches')
    expect(toolText(requests[2]!)).not.toContain('is the codename')
  }, 60000)

  it('tool_call cannot reach an MCP tool a delegated child may not see', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'io-agent-security-mcp-'))
    try {
      const log = join(dir, 'calls.jsonl')
      const { app, requests } = await fixture((_q, res, i) => {
        if (i === 0) return tool(res, 'subagent', { description: 'Read only', prompt: 'Echo something.', run_in_background: false, allowed_tools: ['read'] }, 'delegate')
        if (i === 1) return tool(res, 'tool_call', { name: 'mcp__many__echo_07', arguments: { text: 'SHOULD_NOT_RUN' } }, 'child-call')
        return stream(res, [{ content: i === 2 ? 'Could not.' : 'Done.' }])
      }, { mcp: manyServer(log) })
      await (await app.createSession()).run('Delegate a read-only check.')
      expect(names(requests[1]!)).toEqual(['read'])
      expect(toolText(requests[2]!)).toContain('tool_call')
      expect((await loggedCalls(log)).filter(call => (call as { method?: string }).method === 'tools/call')).toEqual([])
    } finally { await rm(dir, { recursive: true, force: true }) }
  }, 60000)

  it('tool_call reaches no MCP tool beyond the one a delegated child may see', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'io-agent-security-mcp-one-'))
    try {
      const log = join(dir, 'calls.jsonl')
      const { app, requests } = await fixture((_q, res, i) => {
        if (i === 0) return tool(res, 'subagent', { description: 'One tool', prompt: 'Echo something.', run_in_background: false,
          allowed_tools: ['mcp__many__echo_01'] }, 'delegate')
        // The bridge is dispatchable in the child's scope (a marked tool is visible) though not advertised.
        if (i === 1) return tool(res, 'tool_call', { name: 'mcp__many__echo_07', arguments: { text: 'SHOULD_NOT_RUN' } }, 'child-call')
        return stream(res, [{ content: i === 2 ? 'Could not.' : 'Done.' }])
      }, { mcp: manyServer(log) })
      await (await app.createSession()).run('Delegate a one-tool check.')
      expect(names(requests[1]!)).toEqual(['mcp__many__echo_01'])
      expect(toolText(requests[2]!)).not.toContain('echo_07: SHOULD_NOT_RUN')
      expect((await loggedCalls(log)).filter(call => (call as { method?: string }).method === 'tools/call')).toEqual([])
    } finally { await rm(dir, { recursive: true, force: true }) }
  }, 60000)

  it('tool_call asks the host for approval under the MCP tool\'s name, and a rejection stops it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'io-agent-security-host-'))
    try {
      const log = join(dir, 'calls.jsonl')
      const f = await hostFixture((_q, res, i) => {
        if (i === 0) return tool(res, 'tool_call', { name: 'mcp__many__echo_07', arguments: { text: 'NEEDS_APPROVAL' } }, 'deferred-call')
        return stream(res, [{ content: 'Stopped.' }])
      }, {
        sandbox: 'danger-full-access', mcp: manyServer(log),
        configure: (ctx) => {
          ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'mcp__many__echo_07' ? { kind: 'ask' } : next(), { prepend: true })
        },
      })
      const id = await f.host.createSession('deferred-approval')
      const receipt = await f.host.submit(turn(id, 'Echo through the bridge.'))
      const { request } = await pending(f.host, id, 'approval')
      expect(request.kind === 'approval' && request.toolName).toBe('mcp__many__echo_07')
      expect(request.kind === 'approval' && request.arguments).toEqual({ text: 'NEEDS_APPROVAL' })
      f.host.reply({ session_id: id, request_id: request.request_id, kind: 'approval', decision: 'rejected' })
      await f.host.settled(id, receipt.activity_id!)
      expect((await loggedCalls(log)).filter(call => (call as { method?: string }).method === 'tools/call')).toEqual([])
      expect(toolText(f.requests[1]!)).not.toContain('echo_07: NEEDS_APPROVAL')
    } finally { await rm(dir, { recursive: true, force: true }) }
  }, 60000)
})
