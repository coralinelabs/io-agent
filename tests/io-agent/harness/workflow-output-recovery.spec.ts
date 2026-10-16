/** The workflow's product reaches the existing spill store whole, not as an earlier preview. */
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { fixture, stream, tool } from './fixture.ts'
import type { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import type { SaveTextSpill, SpillRef } from '../../../src/library/output/spill/index.ts'
import { JobId } from '../../../src/library/execution/jobs/jobs/index.ts'
import { SessionId } from '../../../src/library/session/journal/index.ts'

const value = Array.from({ length: 24 }, (_, stage) => ({ stage, payload: 'x'.repeat(14_000), end: `STAGE_${stage}_COMPLETE` }))
const script = 'return Array.from({ length: 24 }, (_, stage) => ({ stage, payload: "x".repeat(14000), end: `STAGE_${stage}_COMPLETE` }))'
const canonical = `workflow "large-report" completed (0 agents).\nReturn value:\n${JSON.stringify(value, null, 2)}`
const middleLine = canonical.split('\n').findIndex(line => line.includes('STAGE_12_COMPLETE')) + 1

describe('workflow result recovery through the default runtime', () => {
  for (const background of [false, true]) {
    it(`retains the complete ${background ? 'background' : 'foreground'} product and reads an omitted middle section`, async () => {
      let ctx!: Context
      let jobId = ''
      const saved: { input: SaveTextSpill; ref: SpillRef }[] = []
      let phase = 0
      const f = await fixture((request, res) => {
        if (phase++ === 0) {
          tool(res, 'workflow', { meta: { name: 'large-report', description: 'Produce the complete report.' }, script, run_in_background: background })
          return
        }
        if (background && phase === 2) {
          const text = JSON.stringify(request.messages.filter(message => message.role === 'tool'))
          jobId = /job (workflow-\d+)/.exec(text)?.[1] ?? 'workflow-1'
          tool(res, 'job_output', { job_id: jobId, wait: true }, 'read-job')
          return
        }
        if (phase === (background ? 3 : 2)) {
          const artifact = saved.find(entry => entry.input.source.kind === 'tool'
            && entry.input.source.toolName === (background ? 'job_output' : 'workflow'))
          if (artifact === undefined) { stream(res, [{ content: 'Missing report artifact.' }]); return }
          tool(res, 'read', { file_path: String(artifact.ref.locator), offset: middleLine, limit: 1 }, 'read-middle')
          return
        }
        stream(res, [{ content: 'Report inspected.' }])
      }, { configure(context) {
        ctx = context
        const save = ctx.spillStore.saveText.bind(ctx.spillStore)
        vi.spyOn(ctx.spillStore, 'saveText').mockImplementation(async input => {
          const ref = await save(input)
          saved.push({ input, ref })
          return ref
        })
      } })
      const session = await f.app.createSession()
      const result = await session.run('Produce the complete large report and inspect stage 12.')
      expect(result.text).toBe('Report inspected.')
      const reports = saved.filter(entry => entry.input.source.kind === 'tool'
        && entry.input.source.toolName === (background ? 'job_output' : 'workflow'))
      expect(reports).toHaveLength(1)
      const report = reports[0]!
      const expected = canonical + (background ? '\n[status: completed]' : '')
      expect(report.input.content).toBe(expected)
      expect(await readFile(String(report.ref.locator), 'utf8')).toBe(expected)
      expect(report.ref.bytes).toBe(Buffer.byteLength(expected))
      const lastRequest = f.requests.at(-1)!
      const readResults = lastRequest.messages.filter(message => message.role === 'tool')
      expect(JSON.stringify(readResults.at(-1)?.content)).toContain('STAGE_12_COMPLETE')
      // The read reply also names its source path; the preceding tool result is the preview.
      const output = readResults.at(-2)!
      const preview = typeof output.content === 'string' ? output.content : JSON.stringify(output.content)
      expect(preview).toContain(String(report.ref.locator))
      expect(Buffer.byteLength(preview)).toBeLessThan(5000)
      expect(preview).toContain('[... output omitted ...]')
      expect(preview).not.toContain('[truncated:')
      if (background) {
        const owner = ctx.agents.get(SessionId(session.id))!
        expect(ctx.jobs.read(JobId(jobId), owner).text).toBe(canonical)
        expect(ctx.jobs.read(JobId(jobId), owner).text).toBe(canonical)
      }
      await f.app.close()
      expect(await readFile(String(report.ref.locator), 'utf8')).toBe(expected)
    }, 30_000)
  }
  it('keeps the canonical background report when storage fails and labels the unavailable artifact honestly', async () => {
    let ctx!: Context
    let jobId = ''
    const attempted: string[] = []
    let phase = 0
    const f = await fixture((request, res) => {
      if (phase++ === 0) {
        tool(res, 'workflow', { meta: { name: 'large-report', description: 'Produce a report.' }, script, run_in_background: true })
      } else if (phase === 2) {
        jobId = /job (workflow-\d+)/.exec(JSON.stringify(request.messages))?.[1] ?? 'workflow-1'
        tool(res, 'job_output', { job_id: jobId, wait: true }, 'read-job')
      } else stream(res, [{ content: 'Storage failure observed; execution is not repeated.' }])
    }, { configure(context) {
      ctx = context
      vi.spyOn(ctx.spillStore, 'saveText').mockImplementation(async input => {
        attempted.push(input.content)
        throw new Error('CONTROLLED_STORAGE_FAILURE')
      })
    } })
    const session = await f.app.createSession()
    await session.run('Produce the report.')
    expect(attempted).toEqual([canonical + '\n[status: completed]'])
    const output = JSON.stringify(f.requests.at(-1)!.messages.filter(message => message.role === 'tool').at(-1)?.content)
    expect(output).toContain('The full output could not be retained.')
    expect(output).not.toContain('Full output saved')
    const owner = ctx.agents.get(SessionId(session.id))!
    expect(ctx.jobs.get(JobId(jobId), owner).status).toBe('completed')
    expect(ctx.jobs.read(JobId(jobId), owner).text).toBe(canonical)
    expect((await session.events()).filter(event => event.type === 'tool-workflow/run-start')).toHaveLength(1)
  }, 30_000)

})
