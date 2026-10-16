/** Real loop/jobs/subprocess and pwsh lifecycle; a Node argv shim makes it runnable without Windows. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import { createUserMessage, ToolCallId } from '../../../src/library/model/llm/index.ts'
import { SessionId } from '../../../src/library/session/journal/index.ts'
import { PwshLocalExecutor } from '../../../src/library/execution/shell/pwsh-local/index.ts'
import type { ShellExecSpec } from '../../../src/library/execution/shell/shell/index.ts'
import * as ShellEnv from '../../../src/library/execution/shell/shell-env/index.ts'
import * as ToolPwsh from '../../../src/library/execution/shell/tool-pwsh/index.ts'
import LocalSubprocessRuntime from '../../../src/library/execution/process/subprocess-local/index.ts'
import LocalJobRegistry from '../../../src/library/execution/jobs/jobs-local/index.ts'
import * as ToolJobs from '../../../src/library/execution/jobs/tool-jobs/index.ts'
import AgentLoop from '../../../src/plugins/runtime.ts'
import { mountAgentLoopTestDependencies } from '../../support/test-support/agent-loop-testkit/src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../core/agent-loop/mock-adapter.ts'

class NodeArgvPwsh extends PwshLocalExecutor {
  protected override argv(spec: ShellExecSpec): readonly string[] { return [process.execPath, '-e', spec.command] }
}
async function setup(replies: ConstructorParameters<typeof MockAdapter>[0] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'pwsh-default-wait-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolJobs)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(NodeArgvPwsh, { timeoutMs: 500, graceMs: 100 })
  await ctx.plugin(ShellEnv)
  await ctx.plugin(ToolPwsh)
  if (replies.length > 0) ctx.llm.registerAdapter(['mock'], new MockAdapter(replies))
  return { ctx, dir }
}

describe('pwsh foreground handoff', () => {
  it('keeps the process alive, consumes output once and wakes the same agent on completion', async () => {
    const test = await setup()
    const sentinel = join(test.dir, 'release')
    const command = `console.log('started'); const fs=require('node:fs'); const t=setInterval(()=>{ if(fs.existsSync(${JSON.stringify(sentinel)})){clearInterval(t);console.log('finished')} },10)`
    test.ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('long', 'pwsh', { command, description: 'long command' }),
      textResponse('Still running.'),
      toolCallResponse('read', 'job_output', { job_id: 'pwsh-1' }),
      textResponse('Done.'),
    ]))
    const agent = await test.ctx.agentLoop.create(SessionId('pwsh-handoff'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run.' }], source: { kind: 'user' } }))
    const results = () => agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    await expect.poll(() => results().length).toBe(1)
    const moved = results()[0]!
    expect(moved.data.meta).toEqual({ background: true })
    expect(JSON.stringify(moved.data.message)).toContain('started')
    expect(JSON.stringify(moved.data.message)).toContain('continues in the background as job pwsh-1')
    expect(test.ctx.jobs.list(agent).map(job => [job.id, job.status])).toEqual([['pwsh-1', 'running']])
    await writeFile(sentinel, '')
    await expect.poll(() => results().length).toBe(2)
    expect(JSON.stringify(results()[1]!.data.message)).toContain('finished')
    expect(JSON.stringify(results()[1]!.data.message)).not.toContain('started')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
  })

  it('keeps an explicit timeout as a kill deadline without creating a job', async () => {
    const { ctx } = await setup()
    const result = await ctx.tools.execute({ name: 'pwsh', callId: ToolCallId('deadline'), signal: new AbortController().signal,
      arguments: { command: 'setInterval(()=>{},1000)', description: 'explicit deadline', timeoutMs: 20 } })
    expect(result).toMatchObject({ isError: false })
    if (result.isError) throw new Error('unexpected tool error')
    expect(result.value).toMatchObject({ kind: 'foreground', timedOut: true, exitCode: null })
    expect(ctx.jobs.list()).toEqual([])
  })

  it('transfers cancellation to the job after the default wait', async () => {
    const { ctx } = await setup()
    const controller = new AbortController()
    const result = await ctx.tools.execute({ name: 'pwsh', callId: ToolCallId('handoff'), signal: controller.signal,
      arguments: { command: 'setInterval(()=>{},1000)', description: 'handoff' } })
    expect(result).toMatchObject({ isError: false })
    if (result.isError) throw new Error('unexpected tool error')
    expect(result.value).toMatchObject({ kind: 'background', jobId: 'pwsh-1' })
    expect(result.meta).toEqual({ background: true })
    controller.abort('foreground ended')
    expect(ctx.jobs.list().map(job => job.status)).toEqual(['running'])
    const killed = await ctx.tools.execute({ name: 'job_kill', callId: ToolCallId('kill'), signal: new AbortController().signal,
      arguments: { job_id: 'pwsh-1' } })
    expect(killed.isError).toBe(false)
    await expect.poll(() => ctx.jobs.list().map(job => job.status)).toEqual(['killed'])
  })
  it('joins the process when job admission refuses ownership', async () => {
    const { ctx } = await setup()
    vi.spyOn(ctx.jobs, 'start').mockImplementation(() => { throw new Error('job capacity exhausted') })
    const result = await ctx.tools.execute({ name: 'pwsh', callId: ToolCallId('refusal'), signal: new AbortController().signal,
      arguments: { command: 'setInterval(()=>{},1000)', description: 'refused handoff' } })
    expect(result).toMatchObject({ isError: false })
    if (result.isError) throw new Error('unexpected tool error')
    expect(result.value).toMatchObject({ kind: 'foreground', timedOut: true, signal: 'SIGTERM' })
    expect(ctx.jobs.list()).toEqual([])
  })

  it('kills a detached process if cancellation wins before job admission', async () => {
    const { ctx } = await setup()
    const controller = new AbortController()
    const run = ctx.shell.run.bind(ctx.shell)
    let killed: ReturnType<typeof vi.fn> | undefined
    vi.spyOn(ctx.shell, 'run').mockImplementation(async spec => {
      const result = await run(spec)
      if (result.detached === undefined) throw new Error('expected default-wait handoff')
      const kill = result.detached.kill.bind(result.detached)
      killed = vi.fn(kill)
      result.detached.kill = killed
      controller.abort('cancel before job ownership')
      return result
    })
    const start = vi.spyOn(ctx.jobs, 'start')
    const result = await ctx.tools.execute({ name: 'pwsh', callId: ToolCallId('handoff-race'), signal: controller.signal,
      arguments: { command: 'setInterval(()=>{},1000)', description: 'cancelled handoff' } })
    expect(result.isError).toBe(true)
    expect(start).not.toHaveBeenCalled()
    expect(killed).toHaveBeenCalledOnce()
    expect(ctx.jobs.list()).toEqual([])
  })

})
