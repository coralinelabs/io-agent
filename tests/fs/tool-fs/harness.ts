import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import type { Agent } from "../../../src/library/runtime/agents/index.ts"
import AgentLoop from "../../../src/plugins/runtime.ts"
import { mountAgentLoopTestDependencies } from "../../support/test-support/agent-loop-testkit/src/index.ts"
import LocalFileSystem from "../../../src/library/filesystem/fs-local/index.ts"
import * as FsPolicy from "../../../src/library/filesystem/fs-observation-policy/index.ts"
import * as ToolFs from "../../../src/library/filesystem/tool-fs/index.ts"
import * as LlmDeepSeek from "../../support/llm/llm-deepseek/src/index.ts"

/**
 * Build the real fs-tool stack for with-key e2e tests. Agents have no session
 * cwd, so `fsCwd` is their workspace; `persona` configures the deployment prompt.
 * This helper lives outside the e2e glob so imports do not register tests.
 */
export async function fsHarness(fsCwd: string, persona = ''): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: persona } })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmDeepSeek)
  await ctx.plugin(LocalFileSystem, { cwd: fsCwd })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  return ctx
}

export function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}
