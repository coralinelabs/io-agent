/** Owned workflow execution over the existing jobs service; no second scheduler. */
import type { Context } from '../../runtime/vendor/cordis/index.ts'
import type { Agent } from '../../runtime/agents/index.ts'
import type { JobOutcome } from '../../execution/jobs/jobs/index.ts'
import type { WorkflowRun, WorkflowResult } from '../workflow/index.ts'
import { modelText } from '../../context/text/index.ts'

declare module '../../execution/jobs/jobs/index.ts' { interface JobKindMap { workflow: 'workflow' } }

export interface BackgroundWorkflow {
  readonly name: string
  start(): WorkflowRun
  record(run: WorkflowRun, jobId: string): void
  finish(run: WorkflowRun, result: WorkflowResult): void
  render(result: WorkflowResult): string
}

/** Register before executing; lifetime belongs to the job/owner, not its initiating tool call. */
export function startBackgroundWorkflow(ctx: Context, owner: Agent, request: BackgroundWorkflow) {
  const jobs = ctx.get('jobs')
  if (jobs === undefined) throw new Error(modelText('workflow/background-unavailable'))
  let run!: WorkflowRun
  const id = jobs.start({
    kind: 'workflow', owner, label: request.name,
    run() {
      run = request.start() // Synchronous parse/admission failure leaves no job or live script.
      let progress = ''
      let final: string | undefined
      const limit = 32_768
      const write = (text: string) => {
        progress += text + '\n'
        if (progress.length > limit) {
          // Avoid splitting a surrogate pair at the retained-tail boundary.
          const tail = progress.slice(-limit)
          progress = modelText('workflow/progress-truncated') + '\n'
            + (/^[\uDC00-\uDFFF]/u.test(tail) ? tail.slice(1) : tail)
        }
      }
      const stop = [
        ctx.on('workflow/log', (info, text) => { if (info.id === run.id) write(text) }),
        ctx.on('workflow/phase', (info, phase) => { if (info.id === run.id) write(modelText('workflow/progress-phase', { phase })) }),
        ctx.on('workflow/agent-start', (info, member) => {
          if (info.id === run.id) write(modelText('workflow/progress-member', { label: member.label, state: 'started' }))
        }),
        ctx.on('workflow/agent-end', (info, member) => {
          if (info.id === run.id) write(modelText('workflow/progress-member', { label: member.label, state: member.outcome }))
        }),
      ]
      const done = (async (): Promise<JobOutcome> => {
        let result: WorkflowResult
        try { result = await run.result }
        catch (error) { result = { stopReason: 'error', error: String(error), value: null, agentsStarted: 0 } }
        let cleanupError: unknown
        try { await run.dispose() }
        catch (error) { cleanupError = error }
        finally { for (const dispose of stop) dispose() }
        final = request.render(result)
        if (cleanupError !== undefined) {
          const detail = modelText('workflow/background-cleanup-error', { error: String(cleanupError) })
          // Execution may have completed and produced useful evidence, but the owned
          // workflow did not settle cleanly. The durable record must agree with the job.
          request.finish(run, { ...result, stopReason: 'error', error: detail })
          final += '\n' + detail
          return { status: 'failed', detail: 'cleanup failed', output: final }
        }
        request.finish(run, result)
        return {
          status: result.stopReason === 'completed' ? 'completed' : result.stopReason === 'cancelled' ? 'killed' : 'failed',
          ...(result.error === undefined ? {} : { detail: result.error }), output: final,
        }
      })()
      return {
        cancel: (reason?: string) => run.cancel(reason ?? 'workflow job cancelled'),
        done,
        readOutput: () => {
          // Progress is consumable; done.output owns the idempotent final report.
          const text = progress; progress = ''; return text
        },
      }
    },
  })
  request.record(run, id)
  return { kind: 'background' as const, jobId: id, runId: run.id }
}
