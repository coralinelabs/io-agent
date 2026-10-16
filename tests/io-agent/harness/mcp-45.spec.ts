/** Explicit MCP composition through the inherited client supervisor. */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { fixture, stream, tool } from './fixture.ts'
const server = fileURLToPath(new URL('./fixtures/mcp-45.mjs', import.meta.url))
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error } }

describe('explicit MCP configuration', () => {
  it('advertises negotiated tools and attributed instructions, preserves isError, and reaps its child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'io-agent-mcp-proof-')), log = join(dir, 'events.jsonl')
    try {
      const { app, workspace, requests } = await fixture((_q, res, i) => i < 2
        ? tool(res, 'mcp__fixture__echo', { text: i === 0 ? 'MCP_EVIDENCE_45' : 'MCP_TOOL_ERROR_45', fail: i === 1 }, 'mcp-' + i)
        : stream(res, [{ content: 'MCP checked.' }]), {
        mcp: [{ transport: 'stdio', serverName: 'fixture', command: process.execPath, args: [server, 'normal', log], reconnect: { enabled: false } }],
      })
      const result = await (await app.createSession()).run('Exercise the server.')
      expect(result.events.filter(e => e.type === 'tool/result').map(e => e.data.message.isError === true)).toEqual([false, true])
      expect(JSON.stringify(requests[0]!.messages)).toContain('MCP_ATTRIBUTED_INSTRUCTION_45')
      expect(JSON.stringify(requests.at(-1)!.messages)).toContain('MCP_TOOL_ERROR_45')
      const starts = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { event: string; pid: number; cwd: string }).filter(e => e.event === 'start')
      expect(starts.length).toBeGreaterThanOrEqual(2) // SDK discovery probe, then the serving process.
      expect(starts.every(e => e.cwd === workspace)).toBe(true)
      expect(starts.slice(0, -1).every(e => !alive(e.pid))).toBe(true)
      expect(alive(starts.at(-1)!.pid)).toBe(true)
      await app.close()
      expect(starts.every(e => !alive(e.pid))).toBe(true)
    } finally { await rm(dir, { recursive: true, force: true }) }
  }, 30000)

  it('fails startup by default and rolls back every already-started server', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'io-agent-mcp-rollback-')), good = join(dir, 'good.jsonl'), bad = join(dir, 'bad.jsonl')
    try {
      await expect(fixture((_q, res) => stream(res, [{ content: 'No inference.' }]), {
        mcp: [
          { transport: 'stdio', serverName: 'good', command: process.execPath, args: [server, 'normal', good], reconnect: { enabled: false } },
          { transport: 'stdio', serverName: 'bad', command: process.execPath, args: [server, 'startup-error', bad], reconnect: { enabled: false } },
        ],
      })).rejects.toThrow()
      for (const log of [good, bad]) {
        const starts = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { event: string; pid: number }).filter(e => e.event === 'start')
        expect(starts.length).toBeGreaterThan(0)
        expect(starts.every(e => !alive(e.pid))).toBe(true)
      }
    } finally { await rm(dir, { recursive: true, force: true }) }
  }, 30000)

  it('permits an explicitly optional failed server without inventing its tool', async () => {
    const { app, requests } = await fixture((_q, res) => stream(res, [{ content: 'Optional server unavailable.' }]), {
      mcp: [{ transport: 'stdio', serverName: 'optional', command: process.execPath, args: [server, 'startup-error'],
        failOnStartupError: false, reconnect: { enabled: false } }],
    })
    await (await app.createSession()).run('Inspect available tools.')
    expect(requests[0]!.tools!.some(t => t.function.name === 'mcp__optional__echo')).toBe(false)
  }, 30000)
})
