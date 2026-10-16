/** Background orchestration is owned by the existing job/session lifecycle, not a submitted turn. */
import { describe, expect, it, vi } from 'vitest'
import { fixture, stream, tool } from './fixture.ts'
import type { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import { JobId } from '../../../src/library/execution/jobs/jobs/index.ts'
import { SessionId } from '../../../src/library/session/journal/index.ts'

const meta = { name: 'audit', description: 'Independent audit while the parent continues.' }

describe('background workflows on the default runtime', () => {
  it('lets the parent settle, then wakes it with the child result and durable run records', async () => {
    const child = Promise.withResolvers<void>()
    let ctx!: Context
    const f = await fixture(async (request, res) => {
      const history = JSON.stringify(request.messages)
      if (request.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('INDEPENDENT_CHILD_REQUEST'))) {
        await child.promise
        stream(res, [{ content: 'AUDIT_EVIDENCE_42' }]); return
      }
      const calls = request.messages.filter(m => m.role === 'tool')
      if (calls.length === 0) tool(res, 'workflow', { meta, script: 'return await agent("INDEPENDENT_CHILD_REQUEST")', run_in_background: true })
      else {
        const notice = request.messages.find(m => m.role === 'user' && /background job .*finished/.test(JSON.stringify(m.content)))
        if (notice && !history.includes('AUDIT_EVIDENCE_42')) {
          const jobId = /background job ([^ ]+)/.exec(typeof notice.content === 'string' ? notice.content : JSON.stringify(notice.content))![1]!
          tool(res, 'job_output', { job_id: jobId }, 'read-audit')
        } else stream(res, [{ content: history.includes('AUDIT_EVIDENCE_42') ? 'Incorporated the audit.' : 'Continuing while the audit runs.' }])
      }
    }, { configure(context) { ctx = context } })
    const session = await f.app.createSession()
    const first = await session.run('Start an independent audit.')
    expect(first.text).toBe('Continuing while the audit runs.')
    const owner = ctx.agents.get(SessionId(session.id))!
    const [job] = ctx.jobs.list(owner).filter(j => j.kind === 'workflow')
    expect(job?.status).toBe('running')
    expect(first.events.find(e => e.type === 'tool-workflow/run-start')?.data).toMatchObject({ jobId: job!.id })
    child.resolve()
    await vi.waitFor(() => expect(ctx.jobs.get(job!.id, owner).status).toBe('completed'))
    await session.whenIdle()
    await vi.waitFor(() => expect(f.requests.some(r => JSON.stringify(r.messages).includes('AUDIT_EVIDENCE_42')
      && !r.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('INDEPENDENT_CHILD_REQUEST')))).toBe(true))
    const events = await session.events()
    expect(events.filter(e => e.type === 'tool-workflow/run-end')).toHaveLength(1)
    expect(events.find(e => e.type === 'tool-workflow/run-end')?.data.stopReason).toBe('completed')
    expect(ctx.jobs.read(job!.id, owner).text).toContain('AUDIT_EVIDENCE_42')
    expect(ctx.jobs.read(job!.id, owner).text).toContain('AUDIT_EVIDENCE_42')
  }, 30000)

  it('records a script failure as a failed job, never a successful completion', async () => {
    let ctx!: Context
    const f = await fixture((request, res) => {
      if (!request.messages.some(m => m.role === 'tool')) tool(res, 'workflow', {
        meta, script: 'throw new Error("AUDIT_BROKE")', run_in_background: true,
      })
      else stream(res, [{ content: 'Recorded the outcome.' }])
    }, { configure(context) { ctx = context } })
    const session = await f.app.createSession()
    await session.run('Launch the audit.')
    const owner = ctx.agents.get(SessionId(session.id))!
    await vi.waitFor(() => expect(ctx.jobs.list(owner).find(j => j.kind === 'workflow')?.status).toBe('failed'))
    const job = ctx.jobs.list(owner).find(j => j.kind === 'workflow')!
    expect(ctx.jobs.read(job.id, owner).text).toContain('AUDIT_BROKE')
    expect((await session.events()).find(e => e.type === 'tool-workflow/run-end')?.data.stopReason).toBe('error')
  }, 30000)

  it('kills the workflow and its child without cancelling a later parent activity', async () => {
    let ctx!: Context
    const ready = Promise.withResolvers<void>()
    const f = await fixture(async (request, res) => {
      if (request.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('BLOCKED_AUDIT_CHILD'))) {
        ready.resolve()
        await new Promise<void>(resolve => res.on('close', resolve)); return
      }
      if (!request.messages.some(m => m.role === 'tool')) tool(res, 'workflow', {
        meta, script: 'return await agent("BLOCKED_AUDIT_CHILD")', run_in_background: true,
      })
      else stream(res, [{ content: 'Parent remains usable.' }])
    }, { configure(context) { ctx = context } })
    const session = await f.app.createSession()
    await session.run('Start the audit.')
    await ready.promise
    const owner = ctx.agents.get(SessionId(session.id))!
    const job = ctx.jobs.list(owner).find(j => j.kind === 'workflow')!
    ctx.jobs.kill(JobId(job.id), owner)
    await vi.waitFor(() => expect(ctx.jobs.get(job.id, owner).status).toBe('killed'))
    await session.whenIdle()
    expect((await session.run('Continue unrelated work.')).text).toBe('Parent remains usable.')
    expect((await session.events()).find(e => e.type === 'tool-workflow/run-end')?.data.stopReason).toBe('cancelled')
  }, 30000)

  it('does not seal a successful workflow record when owned cleanup failed', async () => {
    let ctx!: Context
    const f = await fixture((request, res) => {
      if (!request.messages.some(m => m.role === 'tool')) tool(res, 'workflow', {
        meta, script: 'return { evidence: "COMMITTED_EVIDENCE_42" }', run_in_background: true,
      })
      else stream(res, [{ content: 'Recorded the job outcome.' }])
    }, { configure(context) {
      ctx = context
      const start = ctx.workflowEngine.start.bind(ctx.workflowEngine)
      vi.spyOn(ctx.workflowEngine, 'start').mockImplementation(request => {
        const run = start(request)
        return { ...run, async dispose() {
          await run.dispose()
          throw new Error('CONTROLLED_CLEANUP_FAILURE')
        } }
      })
    } })
    const session = await f.app.createSession()
    await session.run('Run the independent audit.')
    const owner = ctx.agents.get(SessionId(session.id))!
    await vi.waitFor(() => expect(ctx.jobs.list(owner).find(j => j.kind === 'workflow')?.status).toBe('failed'))
    const job = ctx.jobs.list(owner).find(j => j.kind === 'workflow')!
    expect(ctx.jobs.read(job.id, owner).text).toContain('COMMITTED_EVIDENCE_42')
    expect(ctx.jobs.read(job.id, owner).text).toContain('CONTROLLED_CLEANUP_FAILURE')
    const ends = (await session.events()).filter(e => e.type === 'tool-workflow/run-end')
    expect(ends).toHaveLength(1)
    expect(ends[0]?.data.stopReason).toBe('error')
  }, 30000)

})
