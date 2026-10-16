/**
 * Real-load-path guard for @deepseek-ai/dsh-tool-fs-search. `tool-fs-search` is
 * a NAMESPACE plugin with `inject` — so a stray `export default apply` would
 * make the cordis Loader's `unwrapExports` (`exports.default ?? exports`)
 * collapse the module to the bare `apply` function, DROPPING `inject`. The
 * plugin would then read `ctx.subprocess` without having injected it and throw
 * `cannot get property … without inject` the moment it loads (postmortem 0001).
 *
 * A hand-built `ctx.plugin({ apply, inject })` mount CANNOT catch that — it
 * bypasses `unwrapExports`. So this test unwraps the module through the REAL
 * `Loader.prototype.unwrapExports` and mounts the result over the real local
 * subprocess service, exercising the exact path the Loader uses. Prove the
 * guard bites: add `export default apply` to `src/index.ts`, watch this go
 * red, revert.
 */

import { describe, expect, it } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import SystemPrompt from "../../../src/library/context/assembly/index.ts"
import ToolRuntime from "../../../src/library/tools/index.ts"
import LocalSubprocessRuntime from "../../../src/library/execution/process/subprocess-local/index.ts"
import * as toolFsSearch from "../../../src/library/filesystem/tool-fs-search/index.ts"

describe('dsh-tool-fs-search real-load-path guard', () => {
  it('has no default export and keeps name/inject/Config on the direct module', () => {
    expect('default' in toolFsSearch).toBe(false)

    const unwrapped = toolFsSearch as Record<string, unknown>
    expect(unwrapped).toBe(toolFsSearch)
    expect(unwrapped.name).toBe('tool-fs-search')
    expect(unwrapped.inject).toEqual(['tools', 'systemPrompt', 'subprocess'])
    expect(typeof unwrapped.Config).toBe('function')
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots over ctx.subprocess through the unwrapped module without an inject error', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)

    const unwrapped = toolFsSearch as Parameters<Context['plugin']>[0]
    // A collapsed export shape (dropped inject) would throw "without inject" here.
    const fiber = await ctx.plugin(unwrapped, { sampleOverCapGlobResults: true })
    expect(ctx.tools.schemas().map(s => s.name)).toEqual(expect.arrayContaining(['glob', 'grep']))
    await fiber.dispose()
  })
})
