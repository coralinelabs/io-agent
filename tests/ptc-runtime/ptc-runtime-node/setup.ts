import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { onTestFinished } from 'vitest'
import SessionStore from "../../../src/library/session/journal/index.ts"
import FileSystem from "../../../src/library/filesystem/fs-local/index.ts"
import Subprocess from "../../../src/library/execution/process/subprocess-local/index.ts"
import Sandbox from "../../../src/library/execution/sandbox/sandbox-local/index.ts"
import SandboxPolicy from "../../../src/library/execution/sandbox/sandbox-policy/index.ts"
import SessionProjections from "../../../src/library/session/projection/index.ts"
import type { SandboxMode } from "../../../src/library/execution/sandbox/sandbox/index.ts"
import NodeRuntime from "../../../src/library/execution/workers/ptc-runtime-node/index.ts"
import type { Config } from "../../../src/library/execution/workers/ptc-runtime-node/index.ts"

export async function mountRuntime(ctx: Context, config: Config = {}, policy: { mode?: SandboxMode; workspaceRoot?: string } = {}) {
  onTestFinished(async () => { await ctx.fiber.dispose() })
  if (!ctx.get('sessions')) await ctx.plugin(SessionStore)
  if (!ctx.get('fs')) await ctx.plugin(FileSystem)
  if (!ctx.get('subprocess')) await ctx.plugin(Subprocess)
  if (!ctx.get('sandbox')) await ctx.plugin(Sandbox, {})
  if (!ctx.get('sessionProjections')) await ctx.plugin(SessionProjections)
  if (!ctx.get('sandboxPolicy')) await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', ...policy })
  await ctx.plugin(NodeRuntime, config)
  return ctx.ptcRuntime as NodeRuntime
}
