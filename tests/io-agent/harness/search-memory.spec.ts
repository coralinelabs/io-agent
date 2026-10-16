/** `search_memory`: the model searches the workspace's earlier conversations, its reasoning included, and reads an entry. */
import { describe, expect, it } from 'vitest'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createIoAgent } from "../../../src/index.ts"
import type { IoAgentOptions } from "../../../src/index.ts"
import { toolOutputBudget } from "../../../src/library/output/policy/budget.ts"
import { onFixtureCleanup, routerFixture, stream, tool } from './fixture.ts'
import type { Request } from './fixture.ts'

/** Text of every tool-role message in one request, in order. */
function toolMessages(request: Request): string[] {
  return request.messages.filter(m => m.role === 'tool').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
}
/** Every user-role message of one request (the runtime context follows the person's own message). */
const userText = (request: Request): string => JSON.stringify(request.messages.filter(m => m.role === 'user').map(m => m.content))
/** A call with no tools is an auxiliary one (a session title): answered apart from the scripted turns. */
const auxiliary = (request: Request): boolean => (request.tools?.length ?? 0) === 0

async function boot(router: Awaited<ReturnType<typeof routerFixture>>, overrides: Partial<IoAgentOptions> = {}) {
  const app = await createIoAgent({ workspace: router.workspace, stateDirectory: router.stateDirectory, sandbox: 'danger-full-access', approval: 'never',
    recall: { memory: true }, model: { api: 'chat-completions', baseURL: router.baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096 },
    ...overrides })
  onFixtureCleanup(() => app.close())
  return app
}

describe('search_memory', () => {
  it('finds an earlier conversation by its reasoning and reads that entry in full', async () => {
    let conversation = '', seq = -1
    const calls: Request[] = []
    const router = await routerFixture((request, response) => {
      if (auxiliary(request)) return stream(response, [{ content: 'Deploy key' }])
      const said = userText(request)
      if (said.includes('Where is the deploy key?')) {
        return stream(response, [{ reasoning: 'The key is quokka-7, kept in the hardware vault.' }, { content: 'It is in the vault.' }])
      }
      const i = calls.push(request) - 1
      if (i === 0) return tool(response, 'search_memory', { query: 'quokka-7' }, 'memory-search')
      if (i === 1) {
        const listing = toolMessages(request).at(-1) ?? ''
        conversation = /conversation (\S+) /.exec(listing)?.[1] ?? ''
        seq = Number(/#(\d+) assistant\/message reasoning/.exec(listing)?.[1] ?? -1)
        return tool(response, 'search_memory', { conversation, seq }, 'memory-read')
      }
      return stream(response, [{ content: 'The key is quokka-7.' }])
    })
    const app = await boot(router)
    const earlier = await app.createSession({ id: 'earlier-conversation' })
    await earlier.run('Where is the deploy key?')
    await earlier.close()
    const now = await app.createSession({ id: 'current-conversation' })
    await now.run('What did we decide about the deploy key?')

    expect(router.requests[1]!.tools!.map(t => t.function.name)).toContain('search_memory')
    const listing = toolMessages(calls[1]!).at(-1)!
    expect(listing).toContain('1 of 1 matches')
    expect(listing).toContain('conversation earlier-conversation "Where is the deploy key?", last active ')
    expect(listing).toMatch(/#\d+ assistant\/message reasoning: .*quokka-7/)
    // The search's own call in the current conversation never matches itself.
    expect(listing).not.toContain('current-conversation')
    expect(conversation).toBe('earlier-conversation')
    const entry = toolMessages(calls[2]!).at(-1)!
    expect(entry).toContain(`conversation earlier-conversation #${seq} assistant/message`)
    expect(entry).toContain('It is in the vault.')
    expect(entry).toContain('[reasoning]\nThe key is quokka-7, kept in the hardware vault.')
  }, 30000)

  it('never searches or reads a conversation of another workspace sharing the state directory', async () => {
    const calls: Request[] = []
    const router = await routerFixture((request, response) => {
      if (auxiliary(request)) return stream(response, [{ content: 'Zebra' }])
      if (userText(request).includes('Remember zebra-lemma.')) return stream(response, [{ content: 'Remembered zebra-lemma.' }])
      const i = calls.push(request) - 1
      if (i === 0) return tool(response, 'search_memory', { query: 'zebra-lemma' }, 'memory-search')
      if (i === 1) return tool(response, 'search_memory', { conversation: 'other-workspace', seq: 1 }, 'memory-read')
      return stream(response, [{ content: 'Nothing found.' }])
    })
    const first = await boot(router)
    await (await first.createSession({ id: 'other-workspace' })).run('Remember zebra-lemma.')
    await first.close()
    const elsewhere = join(router.workspace, '..', 'elsewhere')
    await mkdir(elsewhere)
    const second = await boot(router, { workspace: elsewhere })
    await (await second.createSession()).run('Search for it.')
    expect(toolMessages(calls[1]!).at(-1)).toContain('No conversation in this workspace matches "zebra-lemma".')
    expect(toolMessages(calls[2]!).at(-1)).toContain('There is no conversation "other-workspace" in this workspace.')
    expect(JSON.stringify(calls.slice(1).map(c => c.messages))).not.toContain('Remembered zebra-lemma')
  }, 30000)

  it('keeps a listing within the per-result spill threshold', async () => {
    const calls: Request[] = []
    const router = await routerFixture((request, response) => {
      if (auxiliary(request)) return stream(response, [{ content: 'Marmots' }])
      if (userText(request).includes('Note field')) return stream(response, [{ content: `${'noted '.repeat(30)}marmot ${'noted '.repeat(30)}` }])
      const i = calls.push(request) - 1
      if (i === 0) return tool(response, 'search_memory', { query: 'marmot', limit: 30 }, 'memory-search')
      return stream(response, [{ content: 'Done.' }])
    })
    const app = await boot(router, { model: { api: 'chat-completions', baseURL: router.baseURL, model: 'fixture-model', contextWindow: 8192, maxTokens: 1024 } })
    for (let i = 0; i < 16; i += 1) {
      const session = await app.createSession({ id: `marmot-${String(i).padStart(2, '0')}` })
      await session.run(`Note ${'field notes '.repeat(20)}marmot-${i} ${'field notes '.repeat(20)}`)
      await session.close()
    }
    await (await app.createSession()).run('Find them.')
    const listing = toolMessages(calls[1]!).at(-1)!
    // 32 matches, 30 asked for: the spill threshold, not the limit, is what stops this listing.
    const shown = Number(/^(\d+) of 32 matches/.exec(listing)?.[1])
    expect(shown).toBeGreaterThan(0)
    expect(shown).toBeLessThan(30)
    expect(listing.split('\n').filter(line => line.startsWith('  #'))).toHaveLength(shown)
    expect(Buffer.byteLength(listing)).toBeLessThanOrEqual(toolOutputBudget(8192).maxInlineBytes)
    expect(listing).toContain('Read one in full with search_memory conversation=<id> seq=<number>.')
  }, 60000)
})
