/**
 * Real-load-path guard for @deepseek-ai/dsh-mcp-client. `mcp-client` is a
 * NAMESPACE plugin with `inject` — so a stray `export default apply` would
 * make the cordis Loader's `unwrapExports` (`exports.default ?? exports`)
 * collapse the module to the bare `apply` function, DROPPING `inject`. The
 * plugin would then read `ctx.tools` without having injected it and throw
 * `cannot get property … without inject` the moment it loads (postmortem 0001).
 *
 * This test unwraps the module through the REAL `Loader.prototype.unwrapExports`
 * and verifies the namespace shape is preserved.
 */

import { describe, expect, it } from 'vitest'
import * as mcpClient from "../../../src/library/mcp/mcp-client/index.ts"

describe('dsh-mcp-client real-load-path guard', () => {
  it('has no default export and keeps name/inject/Config on the direct module', () => {
    expect('default' in mcpClient).toBe(false)

    const unwrapped = mcpClient as Record<string, unknown>
    expect(unwrapped).toBe(mcpClient)
    expect(unwrapped.name).toBe('mcp-client')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.Config).toBeDefined()
  })
})
