/** Provider dependency upgrades must preserve the default loop's durable contracts. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIoAgent } from '../../../src/index.ts'
import { onFixtureCleanup, responses, routerFixture, stream } from './fixture.ts'

describe('provider upgrades on the default runtime path', () => {
  it('retains a native tool namespace through execution, persistence, and resume', async () => {
    const f = await routerFixture((_request, response, index) => {
      responses(response, index === 0
        ? [{ type: 'function_call', id: 'fc_read', callId: 'call_read', name: 'read',
            namespace: 'functions', arguments: JSON.stringify({ file_path: 'note.txt' }) }]
        : [{ type: 'message', id: `msg_${index}`, text: 'Read the note.' }])
    })
    const app = await createIoAgent({ workspace: f.workspace, stateDirectory: f.stateDirectory,
      sandbox: 'danger-full-access', approval: 'never',
      model: { api: 'responses', baseURL: f.baseURL, model: 'private-responses', contextWindow: 32768, maxTokens: 4096 } })
    onFixtureCleanup(() => app.close())
    await writeFile(join(f.workspace, 'note.txt'), 'NAMESPACE_REPLAY_CONTENT\n')
    const session = await app.createSession({ id: 'namespace-replay' })
    const first = await session.run('Read note.txt.')
    expect(first.stopReason?.kind).toBe('completed')
    expect(f.requests).toHaveLength(2)
    const expectedCall = expect.objectContaining({ type: 'function_call', name: 'read',
      namespace: 'functions', call_id: 'call_read' })
    expect(f.requests[1]?.['input']).toEqual(expect.arrayContaining([expectedCall]))
    expect(JSON.stringify(f.requests[1]?.['input'])).toContain('NAMESPACE_REPLAY_CONTENT')
    await session.close()
    const resumed = await app.resumeSession('namespace-replay')
    const next = await resumed.run('Keep the result available.')
    expect(next.stopReason?.kind).toBe('completed')
    expect(f.requests).toHaveLength(3)
    expect(f.requests[2]?.['input']).toEqual(expect.arrayContaining([expectedCall]))
  })

  it('keeps an explicitly configured private model identifier despite catalog churn', async () => {
    const f = await routerFixture((_request, response) => {
      stream(response, [{ content: 'Private route intact.' }], 'stop', {
        prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 40,
      })
    })
    const app = await createIoAgent({ workspace: f.workspace, stateDirectory: f.stateDirectory,
      sandbox: 'danger-full-access', approval: 'never',
      model: { api: 'chat-completions', baseURL: f.baseURL, model: 'deepseek-v4-flash',
        contextWindow: 32768, maxTokens: 4096 } })
    onFixtureCleanup(() => app.close())
    const session = await app.createSession({ id: 'private-model-id' })
    const result = await session.run('Use the configured private endpoint.')
    expect(result.stopReason?.kind).toBe('completed')
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]?.model).toBe('deepseek-v4-flash')
    expect(result.metrics.promptCache).toMatchObject({ hitRate: 0.4, unreportedRequests: 0,
      all: { requests: 1, promptTokens: 100, cacheReadTokens: 40 } })
  })
})
