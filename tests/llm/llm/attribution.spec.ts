import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { APP_IDENTITY, attributionHeaders, userAgent } from "../../../src/library/model/llm/index.ts"
import type { AppIdentity } from "../../../src/library/model/llm/index.ts"

const manifest = createRequire(import.meta.url)('../../../package.json') as { version: string }

/** A white-label identity exercising every override hook. */
const forkIdentity: AppIdentity = {
  product: 'fork-agent',
  version: '9.9.9',
  url: 'https://example.com/fork-agent',
}

describe('APP_IDENTITY', () => {
  it('sources the version from the package manifest, never a hand-copied constant', () => {
    expect(APP_IDENTITY.version).toBe(manifest.version)
  })

  it('names only the library and its version: no product name or URL of an embedding host', () => {
    expect(APP_IDENTITY).toEqual({
      product: 'io-agent',
      version: manifest.version,
    })
  })
})

describe('userAgent', () => {
  it('renders product/version without a comment when the identity has no URL', () => {
    expect(userAgent()).toBe(`io-agent/${manifest.version}`)
  })

  it('renders the +url comment when the identity has a URL', () => {
    expect(userAgent({ product: 'host-app', version: '1.0.0', url: 'https://example.com/host' }))
      .toBe('host-app/1.0.0 (+https://example.com/host)')
  })

  it('renders a custom identity', () => {
    expect(userAgent(forkIdentity)).toBe('fork-agent/9.9.9 (+https://example.com/fork-agent)')
  })
})

describe('attributionHeaders', () => {
  it('defaults to the provider-neutral baseline: User-Agent and nothing else', () => {
    expect(attributionHeaders()).toEqual({ 'user-agent': userAgent() })
  })

  it('maps a custom identity onto the User-Agent header only', () => {
    expect(attributionHeaders(forkIdentity)).toEqual({
      'user-agent': 'fork-agent/9.9.9 (+https://example.com/fork-agent)',
    })
  })
})
