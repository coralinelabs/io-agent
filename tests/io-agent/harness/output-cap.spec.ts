/** `outputCap: false`: the agents' requests carry no output cap; bounded auxiliary calls keep theirs. */
import { describe, expect, it } from 'vitest'
import { createIoAgent } from "../../../src/index.ts"
import type { ModelConnection } from "../../../src/index.ts"
import { onFixtureCleanup, responses, routerFixture, stream } from './fixture.ts'
import { hostFixture, run, turn } from './host-fixture.ts'

async function fixture(reply: Parameters<typeof routerFixture>[0], model: Partial<ModelConnection> = {}) {
  const router = await routerFixture(reply)
  const app = await createIoAgent({ workspace: router.workspace, stateDirectory: router.stateDirectory, sandbox: 'danger-full-access', approval: 'never',
    model: { api: 'chat-completions', baseURL: router.baseURL, model: 'fixture-model', contextWindow: 32768, maxTokens: 4096, ...model } })
  onFixtureCleanup(() => app.close())
  return { ...router, app }
}

describe('uncapped output', () => {
  it('sends no max_tokens on Chat Completions and no max_output_tokens on Responses', async () => {
    const chat = await fixture((_q, res) => { stream(res, [{ content: 'Long answer.' }]) }, { outputCap: false })
    await (await chat.app.createSession()).run('Answer at length.')
    expect(chat.requests).toHaveLength(1)
    expect(chat.requests[0]).not.toHaveProperty('max_tokens')
    expect(chat.requests[0]).not.toHaveProperty('max_completion_tokens')

    const wire = await fixture((_q, res) => { responses(res, [{ type: 'message', id: 'msg_1', text: 'Long answer.' }]) },
      { api: 'responses', reasoningReplay: 'none', outputCap: false })
    await (await wire.app.createSession()).run('Answer at length.')
    expect(wire.requests).toHaveLength(1)
    expect(wire.requests[0]).not.toHaveProperty('max_output_tokens')
  }, 30000)

  it('leaves the cap on by default, and on a bounded auxiliary call of an uncapped connection', async () => {
    const capped = await fixture((_q, res) => { stream(res, [{ content: 'Answer.' }]) })
    await (await capped.app.createSession()).run('Answer.')
    expect(capped.requests[0]).toMatchObject({ max_tokens: 4096 })

    const f = await hostFixture((_q, res) => { stream(res, [{ content: 'Answer.' }]) }, { model: { outputCap: false } })
    const id = await f.host.createSession('uncapped-host')
    await run(f.host, turn(id, 'Answer.'))
    expect(f.requests.at(-1)).not.toHaveProperty('max_tokens')
    // The completion review is a bounded auxiliary call: it keeps its own budget.
    await f.host.verify(id)
    expect(f.requests.at(-1)).toMatchObject({ max_tokens: 2048 })
  }, 30000)
})
