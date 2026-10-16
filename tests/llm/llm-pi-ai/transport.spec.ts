/**
 * Transport failures pi-ai flattens to a message are classified by the error
 * codes the adapter's fetch observed, and a 404 on the Responses route names
 * the setting for Chat Completions.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from "../../../src/library/model/llm/index.ts"
import type { StreamChunk } from "../../../src/library/model/llm/index.ts"
import { registerProfiles, type ConnectionProfiles, type PiAiProviderProfile } from './connection-fixture.ts'
import { PiAiAdapter } from "../../../src/library/model/pi-ai/adapter.ts"
import { resolveProfiles } from "../../../src/library/model/pi-ai/config.ts"
import { errorCodes, observedFetch, transportFailureCode } from "../../../src/library/model/pi-ai/transport.ts"
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(async () => {
  vi.unstubAllGlobals()
  await closeMockServers()
})

const socketDrop = (): TypeError => new TypeError('kaput', {
  cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
})

function adapterFor(baseURL: string, api: 'openai-responses' | 'openai-completions'): PiAiAdapter {
  const providers: Record<string, PiAiProviderProfile> = {
    pluto: { api, baseURL, models: [{ id: 'served', contextWindow: 32_768, maxTokens: 4096 }] },
  }
  return new PiAiAdapter({ profiles: () => resolveProfiles(providers), resolveApiKey: () => Promise.resolve('fake-key'), auth: memoryAuth() })
}

async function finishOf(adapter: PiAiAdapter): Promise<Extract<StreamChunk, { type: 'finish' }> | undefined> {
  let finish: Extract<StreamChunk, { type: 'finish' }> | undefined
  for await (const chunk of adapter.stream({ provider: 'pluto', model: 'served',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })] })) {
    if (chunk.type === 'finish') finish = chunk
  }
  return finish
}

describe('errorCodes and transportFailureCode', () => {
  it('reads every code on the cause chain and names transport and timeout failures', () => {
    expect(errorCodes(new Error('no code'))).toEqual([])
    expect(errorCodes(socketDrop())).toEqual(['UND_ERR_SOCKET'])
    const looped: { code: string; cause?: unknown } = { code: 'OUTER' }
    looped.cause = { code: 'ECONNRESET', cause: looped }
    expect(errorCodes(looped)).toEqual(['OUTER', 'ECONNRESET'])
    expect(transportFailureCode(['invalid_api_key'])).toBeUndefined()
    expect(transportFailureCode(['ECONNREFUSED'])).toBe('TRANSPORT')
    expect(transportFailureCode(['UND_ERR_SOCKET'])).toBe('TRANSPORT')
    expect(transportFailureCode(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'])).toBe('TIMEOUT')
  })
})

describe('observedFetch', () => {
  it('records the code of a body that breaks off mid-response and passes the bytes through', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: first\n\n', () => { response.socket?.destroy() })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const observed = observedFetch()
      const response = await observed.fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`)
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n')
      await expect(reader.read()).rejects.toThrow()
      expect(transportFailureCode(observed.failureCodes())).toBe('TRANSPORT')
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('records a failed connection and leaves error responses untouched', async () => {
    const refused = observedFetch()
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    })))
    await expect(refused.fetch('http://127.0.0.1:9/')).rejects.toThrow('fetch failed')
    expect(refused.failureCodes()).toEqual(['ECONNREFUSED'])
    const original = new Response('{"error":"no"}', { status: 404 })
    vi.stubGlobal('fetch', () => Promise.resolve(original))
    const notFound = observedFetch()
    expect(await notFound.fetch('http://127.0.0.1:9/')).toBe(original)
    expect(notFound.failureCodes()).toEqual([])
  })
})

describe('PiAiAdapter transport classification', () => {
  it('classifies a dropped stream by its cause code, whatever words pi-ai keeps', async () => {
    // A body that fails with wording no message pattern knows: only the code says "transport".
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"role":"assistant","content":""},"index":0}]}\n\n'))
        controller.error(socketDrop())
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })))
    const finish = await finishOf(adapterFor('http://127.0.0.1:9/v1', 'openai-completions'))
    expect(finish?.reason).toMatchObject({ kind: 'error', failure: { message: 'kaput', code: 'TRANSPORT' } })
  })

  it('keeps the message classification when no transport failure was observed', async () => {
    const server = await mockServer([{ status: 400, body: JSON.stringify({ error: { message: 'bad request' } }) }])
    const finish = await finishOf(adapterFor(server.url, 'openai-completions'))
    expect(finish?.reason).toMatchObject({ kind: 'error', failure: { code: 'INVALID_REQUEST' } })
  })
})

describe('404 on the Responses route', () => {
  it('fails once with a message naming the chat-completions setting', async () => {
    const server = await mockServer([{ status: 404, body: JSON.stringify({ error: { message: 'Not Found' } }) }])
    const finish = await finishOf(adapterFor(`${server.url}/v1`, 'openai-responses'))
    expect(finish?.reason).toMatchObject({ kind: 'error', failure: {
      code: 'PI_AI_ERROR', message: expect.stringContaining("set the model connection's api to 'chat-completions'"),
    } })
    expect(server.paths).toEqual(['/v1/responses'])
  })

  it('adds no Responses hint to a 404 on Chat Completions', async () => {
    const server = await mockServer([{ status: 404, body: JSON.stringify({ error: { message: 'Not Found' } }) }])
    const finish = await finishOf(adapterFor(`${server.url}/v1`, 'openai-completions'))
    expect(finish?.reason).toMatchObject({ kind: 'error' })
    expect(JSON.stringify(finish?.reason)).not.toContain('Responses API')
    expect(server.paths).toEqual(['/v1/chat/completions'])
  })
})
