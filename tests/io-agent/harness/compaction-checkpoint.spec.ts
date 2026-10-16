/**
 * Compaction checkpoint fidelity on the default runtime path: real tools,
 * skills, persistence and the HTTP/SSE provider fixture (not live inference).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createIoAgent } from "../../../src/index.ts"
import type { IoAgentSession } from "../../../src/index.ts"
import type { SessionEvent } from "../../../src/library/session/journal/index.ts"
import { defineContentToolFixture } from "../../../src/library/tools/index.ts"
import { fixture, onFixtureCleanup, routerFixture, stream, tool } from './fixture.ts'
import type { Request } from './fixture.ts'

const TODOS = [
  { content: 'Reproduce the failure', status: 'completed' },
  { content: 'Fix src/app/math.ts', status: 'in_progress' },
  { content: 'Run the math tests', status: 'pending' },
]
const TASK = 'TASK-ALPHA: fix src/app/math.ts. Never edit docs/.'
const SECOND = 'SECOND-REQUEST: keep the public API of src/app/math.ts stable.'
const THIRD = 'THIRD-REQUEST: continue with the fix.'
const ERROR = "TypeError: Cannot read properties of undefined (reading 'total')"

const isSummaryRequest = (request: Request): boolean =>
  JSON.stringify(request.messages.at(-1)?.content).includes('compaction engine')
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part: unknown) => typeof part === 'object' && part !== null && 'text' in part
    ? String((part as { text: unknown }).text) : '').join('')
}
const checkpointOf = (request: Request | undefined): string | undefined =>
  request?.messages.map(message => textOf(message.content)).find(text => text.includes('<compacted-summary>'))
/** Positions of each marker; every marker must be present and in order. */
function expectOrdered(text: string, markers: readonly string[]): void {
  const positions = markers.map(marker => text.indexOf(marker))
  expect(positions.every(position => position >= 0), `missing one of ${JSON.stringify(markers)}`).toBe(true)
  expect([...positions].sort((a, b) => a - b)).toEqual(positions)
}
const checkpointEvents = (events: readonly SessionEvent[]) => events.filter((event): event is SessionEvent<'user/message'> =>
  event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === 'compact')

describe('compaction checkpoint fidelity', () => {
  it('keeps user words, open todos, unloaded skills and anchors through iterative compaction and resume', async () => {
    const main: Request[] = []
    const summaries: Request[] = []
    const { app, workspace } = await fixture((request, res) => {
      if (isSummaryRequest(request)) {
        summaries.push(request)
        return stream(res, [{ content: `## Primary Request and Intent\n- LLM-SUMMARY-${summaries.length}` }])
      }
      const index = main.push(request) - 1
      switch (index) {
        case 0: return tool(res, 'skill', { name: 'demo' }, 'skill-1')
        case 1: return tool(res, 'read', { file_path: 'logs/failure.txt' }, 'read-1')
        case 2: return stream(res, [{ content: 'Investigated the failure.' }])
        // The plan is written in the latest turn, so it is still current when compacted.
        case 3: return tool(res, 'todo_write', { todos: TODOS }, 'todo-1')
        case 5: return tool(res, 'skill', { name: 'demo' }, 'skill-2')
        default: return stream(res, [{ content: `Reply ${index}.` }])
      }
    }, { skills: { watch: false } })
    await mkdir(join(workspace, '.agents/skills/demo'), { recursive: true })
    await writeFile(join(workspace, '.agents/skills/demo/SKILL.md'), '---\nname: demo\ndescription: Demo workflow for math fixes.\n---\n'
      + `DEMO-SKILL-BODY: always run the math tests after editing.\n${'Guidance line for the demo workflow.\n'.repeat(60)}`)
    await mkdir(join(workspace, 'logs'))
    await writeFile(join(workspace, 'logs/failure.txt'), `${ERROR}\n    at sum (src/app/math.ts:12:5)\nbisected to commit 9f8e7d6c5b4a\n`)

    const session = await app.createSession({ id: 'checkpoint-fidelity' })
    await session.run(TASK)
    await session.run(SECOND)
    expect(await session.compact()).not.toBeNull()
    await session.run(THIRD)

    const first = checkpointOf(main[5])!
    expect(first).toBeDefined()
    expectOrdered(first, [
      '<compacted-summary>',
      'LLM-SUMMARY-1',
      '## User Messages (verbatim, newest first)',
      `> ${SECOND}`,
      `First user message of the session:\n> ${TASK}`,
      '## Active Todo List',
      '- [in_progress] Fix src/app/math.ts\n- [pending] Run the math tests',
      '## Skills No Longer Loaded',
      '`demo`',
      '## Anchor Index',
      '</compacted-summary>',
    ])
    expect(first).not.toContain('Reproduce the failure')
    expect(first).toContain('load it again with the `skill` tool')
    for (const anchor of ['src/app/math.ts', ERROR, '9f8e7d6c5b4a', 'logs/failure.txt']) expect(first).toContain(anchor)
    expect(JSON.stringify(main[5]!.messages)).not.toContain('DEMO-SKILL-BODY')
    // The reload returns the full body again rather than the "unchanged" reply.
    const reload = textOf(main[6]!.messages.at(-1)?.content)
    expect(reload).toContain('DEMO-SKILL-BODY')
    expect(reload).not.toContain('is unchanged')

    const events = await session.events()
    // The summary event keeps the model output only; the sections are outside it.
    expect(events.find(event => event.type === 'compaction/summary')?.data).toMatchObject({
      summary: [{ type: 'text', text: '## Primary Request and Intent\n- LLM-SUMMARY-1' }],
    })
    const [checkpoint] = checkpointEvents(events)
    expect(checkpoint!.data.source).toMatchObject({
      record: {
        version: 1,
        users: [{ text: TASK, first: true }, { text: SECOND }],
        omittedUsers: 0,
        skills: ['demo'],
        todos: TODOS,
      },
    })

    expect(await session.compact()).not.toBeNull()
    await session.run('FOURTH-REQUEST: finish up.')
    const second = checkpointOf(main[7])!
    expectOrdered(second, [
      'LLM-SUMMARY-2',
      `> ${THIRD}`,
      `> ${SECOND}`,
      `First user message of the session:\n> ${TASK}`,
      '`demo`',
      '9f8e7d6c5b4a',
    ])
    // Carried sections come from the record, not from the summarizer's output.
    expect(second).not.toContain('LLM-SUMMARY-1')
    // THIRD followed the plan's write, so the plan is no longer shown as current.
    expect(second).not.toContain('## Active Todo List')
    expect(checkpointEvents(await session.events())[1]!.data.source).not.toHaveProperty('record.todos')
    // Anchors are carried by value: nothing new was indexed, so the index is byte-identical.
    const anchorIndex = (text: string): string => text.slice(text.indexOf('## Anchor Index'), text.indexOf('\n\n## Session Log'))
    expect(anchorIndex(second)).toBe(anchorIndex(first))
    // The Session Log pointer is rendered per checkpoint, but its start is carried: the second one's
    // span condenses the first checkpoint, and its range reaches back to the first span's start
    // (the earliest original event), not to the first checkpoint's own seq.
    const span = (text: string): number[] => /recall from=(\d+) to=(\d+) lists them/.exec(text)!.slice(1).map(Number)
    const [firstCheckpoint, secondCheckpoint] = checkpointEvents(await session.events())
    const firstSeq = firstCheckpoint!.seq
    expect(span(first)[1]).toBeLessThan(firstSeq)
    expect(span(second)[0]).toBe(span(first)[0])
    expect(span(second)[0]).toBeLessThan(firstSeq)
    expect(span(second)[1]).toBeGreaterThan(firstSeq)
    expect(firstCheckpoint!.data.source).toMatchObject({ record: { condensedFrom: span(first)[0] } })
    expect(secondCheckpoint!.data.source).toMatchObject({ record: { condensedFrom: span(first)[0] } })
    expect(textOf(summaries[1]!.messages.at(-1)?.content)).toContain('carried forward automatically')
    expect(summaries[1]!.messages.some(message => textOf(message.content) === first)).toBe(true)

    await session.close()
    const resumed = await app.resumeSession('checkpoint-fidelity')
    await resumed.run('FIFTH-REQUEST: report.')
    expect(checkpointOf(main[8])).toBe(second)
  }, 60000)

  it('names the loaded skill and the current plan when the provider reuses one call id', async () => {
    const main: Request[] = []
    const { app, workspace } = await fixture((request, res) => {
      if (isSummaryRequest(request)) return stream(res, [{ content: '## Current Work\n- Fixing math.' }])
      const index = main.push(request) - 1
      switch (index) {
        case 0: return tool(res, 'skill', { name: 'demo' }, 'call_1')
        case 1: return tool(res, 'todo_write', { todos: TODOS }, 'call_1')
        case 2: return tool(res, 'bash', { command: 'ls', description: 'List files' }, 'call_1')
        default: return stream(res, [{ content: `Reply ${index}.` }])
      }
    }, { skills: { watch: false } })
    await mkdir(join(workspace, '.agents/skills/demo'), { recursive: true })
    await writeFile(join(workspace, '.agents/skills/demo/SKILL.md'), '---\nname: demo\ndescription: Demo workflow for math fixes.\n---\n'
      + 'DEMO-SKILL-BODY: always run the math tests after editing.\n')
    const session = await app.createSession()
    await session.run(TASK)
    expect(await session.compact()).not.toBeNull()
    await session.run(SECOND)

    const checkpoint = checkpointOf(main.at(-1))!
    expectOrdered(checkpoint, ['## Active Todo List', '- [in_progress] Fix src/app/math.ts\n- [pending] Run the math tests',
      '## Skills No Longer Loaded', '`demo`'])
    const [event] = checkpointEvents(await session.events())
    expect(event!.data.source).toMatchObject({ record: { skills: ['demo'], todos: TODOS } })
  }, 60000)

  describe('with a stubbed fork report', () => {
    afterEach(() => { vi.useRealTimers() })

    it('does not list a fork skill whose report was stubbed before a checkpoint condensed it', async () => {
      vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
      const main: Request[] = []
      const { app, workspace } = await fixture((request, res) => {
        if (isSummaryRequest(request)) return stream(res, [{ content: '## Current Work\n- Audited.' }])
        // The fork child runs the skill body in its own context and reports back at length.
        if (JSON.stringify(request.messages).includes('FORK-AUDIT-BODY')) {
          return stream(res, [{ content: `AUDIT-REPORT ${'finding '.repeat(300)}` }])
        }
        const index = main.push(request) - 1
        if (index === 0) return tool(res, 'skill', { name: 'audit' }, 'call_fork')
        if (index <= 5) return tool(res, 'bash', { command: `echo step-${index}`, description: 'Echo' }, `call_echo_${index}`)
        return stream(res, [{ content: `Reply ${index}.` }])
      }, { skills: { watch: false } })
      await mkdir(join(workspace, '.agents/skills/audit'), { recursive: true })
      await writeFile(join(workspace, '.agents/skills/audit/SKILL.md'),
        '---\nname: audit\ndescription: A scoped audit.\ncontext: fork\nallowed-tools: [read]\n---\nFORK-AUDIT-BODY: audit and report.\n')
      const session = await app.createSession()
      await session.run(TASK)
      expect(main).toHaveLength(7)
      // After an idle hour the report, five tool groups old and over 2,048 characters, becomes a stub.
      vi.setSystemTime(Date.now() + 61 * 60_000)
      await session.run(SECOND)
      expect(JSON.stringify(main[7]!.messages)).toContain('[Pruned older skill result to save context. Call: name=\\"audit\\".')
      expect(JSON.stringify(main[7]!.messages)).not.toContain('AUDIT-REPORT')
      expect(await session.compact()).not.toBeNull()
      await session.run(THIRD)

      const checkpoint = checkpointOf(main[8])!
      expect(checkpoint).toContain(`> ${SECOND}`)
      // A fork loaded nothing into this context, so the checkpoint never asks for it to run again.
      expect(checkpoint).not.toContain('## Skills No Longer Loaded')
      const [event] = checkpointEvents(await session.events())
      expect(event!.data.source).toMatchObject({ record: { skills: [] } })
    }, 90000)
  })

  it('does not bring back a todo list that a later user turn redirected', async () => {
    const main: Request[] = []
    const { app } = await fixture((request, res) => {
      if (isSummaryRequest(request)) return stream(res, [{ content: '## Current Work\n- Writing docs for B.' }])
      const index = main.push(request) - 1
      if (index === 0) {
        return tool(res, 'todo_write', { todos: [
          { content: 'Refactor module A', status: 'in_progress' },
          { content: 'Delete legacy A files', status: 'pending' },
        ] }, 'todo-a')
      }
      // Replies long enough that the compacted span outweighs its checkpoint whatever the runtime-context wording.
      return stream(res, [{ content: `Reply ${index}: noted, continuing with the requested work and reporting back when it is done.` }])
    })
    const session = await app.createSession()
    await session.run('Refactor module A.')
    await session.run('Stop. Do not touch module A at all; instead only write docs for B.')
    await session.run('ok go')
    expect(await session.compact()).not.toBeNull()
    await session.run('continue')

    const checkpoint = checkpointOf(main.at(-1))!
    expectOrdered(checkpoint, ['> ok go', '> Stop. Do not touch module A at all', 'First user message of the session:\n> Refactor module A.'])
    expect(checkpoint).not.toContain('## Active Todo List')
    expect(checkpoint).not.toContain('Delete legacy A files')
    const [event] = checkpointEvents(await session.events())
    expect(event!.data.source).toHaveProperty('record.users')
    expect(event!.data.source).not.toHaveProperty('record.todos')
  }, 60000)

  it('restores the runtime context after overflow recovery; a transient retry resends the same request', async () => {
    const main: Request[] = []
    let summaries = 0
    let overflowed = false
    let failedOnce = false
    const router = await routerFixture((request, res) => {
      if (isSummaryRequest(request)) {
        summaries += 1
        return stream(res, [{ content: '## Current Work\n- OVERFLOW-SUMMARY' }])
      }
      const index = main.push(request) - 1
      const sent = JSON.stringify(request.messages)
      if (sent.includes('SECOND-PROMPT') && !overflowed) {
        overflowed = true
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { code: 'context_length_exceeded', type: 'invalid_request_error',
          message: "This model's maximum context length is 65536 tokens. However, your messages resulted in 70123 tokens." } }))
      }
      if (sent.includes('THIRD-PROMPT') && !failedOnce) {
        failedOnce = true
        res.writeHead(503, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'fixture overloaded' } }))
      }
      if (!sent.includes('SECOND-PROMPT') && index < 4) return tool(res, 'probe', { round: index }, `probe-${index}`)
      stream(res, [{ content: `Done ${index}.` }])
    })
    const app = await createIoAgent({
      workspace: router.workspace, stateDirectory: router.stateDirectory, sandbox: 'danger-full-access', approval: 'never',
      model: { api: 'chat-completions', baseURL: router.baseURL, model: 'fixture-model', contextWindow: 65536, maxTokens: 2048 },
      configure: (ctx) => {
        ctx.tools.register(defineContentToolFixture({
          name: 'probe', description: 'Return a probe report', parameters: { round: { type: 'number' } },
          async execute(args) { return [{ type: 'text', text: `PROBE-${String(args.round)} ${'z'.repeat(3000)}` }] },
        }))
      },
    })
    onFixtureCleanup(() => app.close())
    const session = await app.createSession()
    await session.run('FIRST-PROMPT: collect four probe reports.')
    const recovered = await session.run('SECOND-PROMPT: summarize the reports.')
    expect(recovered.text).toBe(`Done ${main.length - 1}.`)
    expect(summaries).toBe(1)

    const snapshotsOf = (request: Request | undefined): string[] => (request?.messages ?? [])
      .map(message => textOf(message.content)).filter(text => text.startsWith('Current runtime context'))
    const [snapshot] = snapshotsOf(main[0])
    expect(snapshot).toBeDefined()
    const failed = main.findIndex(request => JSON.stringify(request.messages).includes('SECOND-PROMPT'))
    // Turn 1's snapshot is still visible, so turn 2 projected none of its own.
    expect(snapshotsOf(main[failed])).toEqual([snapshot])
    expect(checkpointOf(main[failed])).toBeUndefined()
    // Overflow compaction condensed that snapshot; the retried attempt carries it again, once.
    const retried = main[failed + 1]!
    expectOrdered(JSON.stringify(retried.messages.map(message => textOf(message.content))),
      ['OVERFLOW-SUMMARY', 'SECOND-PROMPT', 'Current runtime context'])
    expect(snapshotsOf(retried)).toEqual([snapshot])

    const transient = await session.run('THIRD-PROMPT: once more.')
    expect(transient.events.some(event => event.type === 'llm/retry')).toBe(true)
    const third = main.findIndex(request => JSON.stringify(request.messages).includes('THIRD-PROMPT'))
    // A plain retry changes no surface, so the attempt is resent unchanged with one snapshot.
    expect(main[third + 1]!.messages).toEqual(main[third]!.messages)
    expect(snapshotsOf(main[third + 1])).toEqual([snapshot])
    expect(summaries).toBe(1)
  }, 60000)

  it('recovers an overflow whose condensed span is mostly one large first prompt', async () => {
    const main: Request[] = []
    let summaries = 0
    let overflowed = false
    const router = await routerFixture((request, res) => {
      if (isSummaryRequest(request)) {
        summaries += 1
        return stream(res, [{ content: '## Current Work\n- PROMPT-SUMMARY' }])
      }
      main.push(request)
      if (JSON.stringify(request.messages).includes('SECOND-PROMPT') && !overflowed) {
        overflowed = true
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { code: 'context_length_exceeded', type: 'invalid_request_error',
          message: "This model's maximum context length is 65536 tokens. However, your messages resulted in 70123 tokens." } }))
      }
      stream(res, [{ content: 'Read it.' }])
    })
    const app = await createIoAgent({
      workspace: router.workspace, stateDirectory: router.stateDirectory, sandbox: 'danger-full-access', approval: 'never',
      model: { api: 'chat-completions', baseURL: router.baseURL, model: 'fixture-model', contextWindow: 65536, maxTokens: 2048 },
    })
    onFixtureCleanup(() => app.close())
    const session = await app.createSession()
    // About 5 KB: within the first-prompt quote this window allows, so quoting it whole cannot shrink the span.
    await session.run(`FIRST-PROMPT: the specification.\n${'requirement line of the spec\n'.repeat(170)}`)
    const recovered = await session.run('SECOND-PROMPT: implement it.')
    expect(recovered.stopReason).toEqual({ kind: 'completed' })
    expect(recovered.text).toBe('Read it.')
    expect(summaries).toBe(1)
    const checkpoint = checkpointOf(main.at(-1))!
    expect(checkpoint).toContain('PROMPT-SUMMARY')
    // The quoted first prompt is cut so the checkpoint is smaller than what it replaces.
    expect(checkpoint.split('requirement line of the spec').length - 1).toBeLessThan(170)
  }, 60000)

  it.each([true, false])('ends the checkpoint with the recall range of the condensed span, which the model can follow (recall: %s)', async (withRecall) => {
    const main: Request[] = []
    const { app, workspace } = await fixture((request, res) => {
      if (isSummaryRequest(request)) return stream(res, [{ content: '## Current Work\n- LOG-SUMMARY' }])
      const index = main.push(request) - 1
      if (index === 0) return tool(res, 'read', { file_path: 'logs/failure.txt' }, 'read-1')
      if (index === 1) return stream(res, [{ content: 'Investigated the failure.' }])
      // After the checkpoint: follow its pointer to the condensed span, if it has one.
      const pointer = /recall from=(\d+) to=(\d+) lists them/.exec(checkpointOf(request) ?? '')
      if (index === 2 && pointer !== null) return tool(res, 'recall', { from: Number(pointer[1]), to: Number(pointer[2]) }, 'recall-1')
      return stream(res, [{ content: 'Done.' }])
    }, withRecall ? {} : { recall: false })
    await mkdir(join(workspace, 'logs'))
    await writeFile(join(workspace, 'logs/failure.txt'), `${ERROR}\n    at sum (src/app/math.ts:12:5)\n${'    at frame (src/app/loop.ts:3:1)\n'.repeat(80)}`)
    const session = await app.createSession()
    await session.run(TASK)
    expect(await session.compact()).not.toBeNull()
    await session.run(THIRD)

    const checkpoint = checkpointOf(main[2])!
    expect(checkpoint).toContain('LOG-SUMMARY')
    if (!withRecall) {
      expect(checkpoint).not.toContain('## Session Log')
      expect(main).toHaveLength(3)
      return
    }
    // The pointer names exactly the span the summary condensed, and comes last.
    const summary = (await session.events()).find(event => event.type === 'compaction/summary')
    const condensed = summary?.type === 'compaction/summary' ? summary.data.shadowedSeqs.map(Number) : []
    expect(condensed.length).toBeGreaterThan(2)
    const range = `recall from=${Math.min(...condensed)} to=${Math.max(...condensed)}`
    expectOrdered(checkpoint, ['LOG-SUMMARY', '## Anchor Index', '## Session Log', `${range} lists them`, 'recall seq=<number>', '</compacted-summary>'])
    // Following it lists the condensed read, whose result the checkpoint only summarised.
    const listing = main[3]!.messages.filter(message => message.role === 'tool').map(message => textOf(message.content)).at(-1)!
    expect(listing).toMatch(/#\d+ tool\/result read \[removed from context\]: .*TypeError: Cannot read properties of undefined/)
    expect(listing).toContain(TASK)
    expect(main).toHaveLength(4)
  }, 60000)

  it('summarizes a 3 KB bash error that the same pressure pass stubbed as it was sent, and indexes its error', async () => {
    const main: Request[] = []
    const summaries: Request[] = []
    let session!: IoAgentSession
    const router = await routerFixture(async (request, res) => {
      if (isSummaryRequest(request)) {
        summaries.push(request)
        return stream(res, [{ content: '## Current Work\n- BUILD-SUMMARY' }])
      }
      const index = main.push(request) - 1
      if (index === 0) return tool(res, 'bash', { command: 'cat logs/build.log; exit 2', description: 'Build' }, 'call_build')
      if (index <= 5) return tool(res, 'read', { file_path: `src/f${index}.ts` }, `call_read_${index}`)
      if (index === 6) {
        // Size one read so the surface stays over the threshold after the pass stubs the build log
        // (about 650 tokens saved), and falls below it once the summary replaces the sources.
        const { tokens, thresholdTokens } = session.metrics().context
        const need = (thresholdTokens ?? 0) - tokens + 1500
        if (need < 3200 || need * 4 > 45_000) throw new Error(`cannot size the crossing read: ${tokens} of ${String(thresholdTokens)} tokens`)
        const line = 'service=api status=ok elapsed=12ms message="request handled without retry"\n'
        await writeFile(join(router.workspace, 'logs/big.log'), line.repeat(Math.ceil(need * 4 / line.length)))
        // An explicit limit reads past io-agent's 16 KB default window, up to the 50 KB cap.
        return tool(res, 'read', { file_path: 'logs/big.log', limit: 2000 }, 'call_big')
      }
      stream(res, [{ content: 'Done.' }])
    })
    const app = await createIoAgent({
      workspace: router.workspace, stateDirectory: router.stateDirectory, sandbox: 'danger-full-access', approval: 'never',
      model: { api: 'chat-completions', baseURL: router.baseURL, model: 'fixture-model', contextWindow: 20000, maxTokens: 2048 },
    })
    onFixtureCleanup(() => app.close())
    const BUILD_ERROR = "src/app/math.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'"
    const lines = Array.from({ length: 90 }, (_, n) => `compiling module ${n + 1} of 90 ... ok`)
    lines.splice(45, 0, 'LINKER-DETAIL: libmath resolved from vendor/lib')
    await mkdir(join(router.workspace, 'logs'))
    await writeFile(join(router.workspace, 'logs/build.log'), `${lines.join('\n')}\n${BUILD_ERROR}\n`)
    await mkdir(join(router.workspace, 'src'))
    // Sources just under the 2,048-character stub size: the pass keeps them, the summary condenses them.
    for (let n = 1; n <= 5; n++) {
      await writeFile(join(router.workspace, `src/f${n}.ts`),
        Array.from({ length: 40 }, (_, i) => `export const value${n}_${i} = ${i} // pad\n`).join(''))
    }
    session = await app.createSession()
    const result = await session.run('BUILD-TASK: build, inspect the sources, then read the service log.')
    expect(result.text).toBe('Done.')

    // The pass stubbed the build log (six tool groups old, over 2,048 characters) before it summarised.
    const events = await session.events()
    const stub = events.find(event => event.type === 'tool/result' && event.surfaceOp !== 'append'
      && JSON.stringify(event.data.message.content).includes('[Pruned older bash result'))
    expect(stub).toBeDefined()
    expect(summaries).toHaveLength(1)
    // The summary replays that result as the last request sent it, so the call is that request's prefix.
    const replay = summaries[0]!.messages.slice(0, -1)
    expect(replay).toEqual(main[6]!.messages)
    const sent = JSON.stringify(replay)
    expect(sent).toContain('LINKER-DETAIL: libmath resolved from vendor/lib')
    expect(sent).not.toContain('[Pruned older bash result')
    // The Anchor Index harvests the recorded result, not its stub.
    const checkpoint = checkpointOf(main[7])!
    expectOrdered(checkpoint, ['BUILD-SUMMARY', '## Anchor Index', 'error TS2322'])
    expect(checkpoint).toContain(BUILD_ERROR.slice(BUILD_ERROR.indexOf('error TS2322')))
  }, 60000)

  it('re-projects runtime context and quotes the running prompt when pressure compacts mid-turn', async () => {
    const main: Request[] = []
    let summaries = 0
    const router = await routerFixture((request, res) => {
      if (isSummaryRequest(request)) {
        summaries += 1
        return stream(res, [{ content: '## Current Work\n- PRESSURE-SUMMARY' }])
      }
      const index = main.push(request) - 1
      if (checkpointOf(request) === undefined && index < 12) return tool(res, 'probe', { round: index }, `probe-${index}`)
      stream(res, [{ content: 'Finished after compaction.' }])
    })
    const app = await createIoAgent({
      workspace: router.workspace, stateDirectory: router.stateDirectory, sandbox: 'danger-full-access', approval: 'never',
      model: { api: 'chat-completions', baseURL: router.baseURL, model: 'fixture-model', contextWindow: 16384, maxTokens: 2048 },
      configure: (ctx) => {
        ctx.tools.register(defineContentToolFixture({
          name: 'probe', description: 'Return a probe report', parameters: { round: { type: 'number' } },
          // Under the 8192-character prune threshold, so only compaction can relieve pressure.
          async execute(args) { return [{ type: 'text', text: `PROBE-${String(args.round)} ${'y'.repeat(6000)}` }] },
        }))
      },
    })
    onFixtureCleanup(() => app.close())
    const session = await app.createSession()
    const result = await session.run('PRESSURE-TASK: probe until the report is complete.')

    expect(summaries).toBe(1)
    expect(result.events.some(event => event.type === 'compaction/summary')).toBe(true)
    const after = main.findIndex(request => checkpointOf(request) !== undefined)
    expect(after).toBeGreaterThan(1)
    const checkpoint = checkpointOf(main[after])!
    expectOrdered(checkpoint, ['PRESSURE-SUMMARY', 'First user message of the session:\n> PRESSURE-TASK: probe until the report is complete.'])
    const snapshotOf = (request: Request | undefined): string | undefined => request?.messages.map(message => textOf(message.content))
      .find(text => text.startsWith('Current runtime context'))
    expect(snapshotOf(main[0])).toBeDefined()
    expect(snapshotOf(main[after])).toBe(snapshotOf(main[0]))
    expect(result.text).toBe('Finished after compaction.')
  }, 60000)
})
