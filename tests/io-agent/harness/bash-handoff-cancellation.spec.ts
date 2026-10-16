/** Cancellation before background admission must leave no unreported process. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import { ToolCallId } from '../../../src/library/model/llm/index.ts'
import { LocalBashExecutor } from '../../../src/library/execution/shell/bash-local/index.ts'
import * as ToolBash from '../../../src/library/execution/shell/tool-bash/index.ts'
import LocalSubprocessRuntime from '../../../src/library/execution/process/subprocess-local/index.ts'
import LocalJobRegistry from '../../../src/library/execution/jobs/jobs-local/index.ts'
import * as ToolJobs from '../../../src/library/execution/jobs/tool-jobs/index.ts'
import * as ShellEnv from '../../../src/library/execution/shell/shell-env/index.ts'
import { mountAgentLoopTestDependencies } from '../../support/test-support/agent-loop-testkit/src/index.ts'

describe.skipIf(process.platform !== 'linux')('durable POSIX regressions', () => {

it('rejects a cancelled default-wait bash handoff before job admission', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolJobs)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ShellEnv)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 50, graceMs: 100 })
  await ctx.plugin(ToolBash)
  const controller = new AbortController()
  const run = ctx.shell.run.bind(ctx.shell)
  vi.spyOn(ctx.shell, 'run').mockImplementation(async spec => {
    const result = await run(spec)
    expect(result.detached).toBeDefined()
    controller.abort('cancellation wins before job admission')
    return result
  })
  const result = await ctx.tools.execute({ name: 'bash', callId: ToolCallId('review-cancel-handoff'), signal: controller.signal,
    arguments: { command: 'sleep 60', description: 'review handoff' } })
  expect(controller.signal.aborted, JSON.stringify(result)).toBe(true)
  expect(result.isError).toBe(true)
  expect(ctx.jobs.list().map(job => [job.id, job.status])).toEqual([])
}, 10000)

})
