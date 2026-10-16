/** Test the advertised next-request budget on the actual default composition. */
import { describe, expect, it } from 'vitest'
import { createIoAgent } from '../../../src/index.ts'
import { routerFixture, onFixtureCleanup, stream } from './fixture.ts'
import type { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import { SessionId } from '../../../src/library/session/journal/index.ts'

describe('compaction input budget in the headless runtime', () => {
  it.each([true, false])('uses actual wire output cap, outputCap=%s', async outputCap => {
    let ctx!: Context
    const f = await routerFixture((_request, res) => stream(res, [{ content: 'Ready.' }]))
    const app = await createIoAgent({ workspace: f.workspace, stateDirectory: f.stateDirectory,
      model: { api: 'chat-completions', baseURL: f.baseURL, model: 'fixture-model', contextWindow: 32768,
        maxTokens: 16384, outputCap }, compactionHeadroomTokens: 1000,
      sandbox: 'danger-full-access', approval: 'never', configure(c) { ctx = c } })
    onFixtureCleanup(() => app.close())
    const session = await app.createSession()
    await session.run('Hello')
    const agent = ctx.agents.get(SessionId(session.id))!
    expect(ctx.compaction.thresholdTokens(agent)).toBe(outputCap ? 15384 : Math.floor(32768 * .8))
    expect(f.requests[0]?.max_tokens).toBe(outputCap ? 16384 : undefined)
  })

  it('rejects headroom that leaves no input instead of failing each automatic step', async () => {
    const f = await routerFixture((_request, res) => stream(res, [{ content: 'Unused.' }]))
    await expect(createIoAgent({ workspace: f.workspace, stateDirectory: f.stateDirectory,
      model: { baseURL: f.baseURL, model: 'fixture-model', contextWindow: 10000, maxTokens: 4000 },
      compactionHeadroomTokens: 6000 })).rejects.toThrow(/compactionHeadroomTokens/)
    expect(f.requests).toHaveLength(0)
  })
})
