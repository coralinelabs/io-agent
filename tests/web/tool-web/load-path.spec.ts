/**
 * Real Loader-path guard for an injected namespace plugin. A default export would make
 * `unwrapExports` collapse the namespace and drop `inject`, causing access to `ctx.web` to fail.
 * Hand-built mounting bypasses that path, so this test unwraps through direct plugin registration first; see
 * postmortem 0001.
 */

import { describe, expect, it } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import SystemPrompt from "../../../src/library/context/assembly/index.ts"
import ToolRuntime from "../../../src/library/tools/index.ts"
import WebRuntime from "../../../src/library/web/web/index.ts"
import * as toolWeb from "../../../src/library/web/tool-web/index.ts"

describe('dsh-tool-web real-load-path guard', () => {
  it('has no default export and keeps name/inject/Config on the direct module', () => {
    expect('default' in toolWeb).toBe(false)

    const unwrapped = toolWeb as Record<string, unknown>
    expect(unwrapped).toBe(toolWeb)
    expect(unwrapped.name).toBe('tool-web')
    expect(unwrapped.inject).toEqual(['tools', 'web', 'systemPrompt'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots over ctx.web through the unwrapped module without an inject error', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(WebRuntime, {})

    const unwrapped = toolWeb as Parameters<Context['plugin']>[0]
    // Mounting the collapsed shape would throw for missing injection here.
    const fiber = await ctx.plugin(unwrapped)
    expect(ctx.tools.schemas().map(s => s.name)).toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
    await fiber.dispose()
  })
})
