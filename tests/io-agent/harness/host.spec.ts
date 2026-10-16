/** Host delivery exercises the real io-agent loop, router, tools and persistence. */
import { describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHost } from "../../../src/library/host/index.ts"
import type { HostEvent } from "../../../src/library/host/index.ts"
import { onFixtureCleanup, stream, tool } from './fixture.ts'
import { hostFixture, journal, pending, run, turn } from './host-fixture.ts'
import { sandboxUsable } from '../../support/sandbox-usable.ts'

const ofType = <T extends HostEvent['type']>(events: readonly HostEvent[], type: T) =>
  events.filter((event): event is Extract<HostEvent, { type: T }> => event.type === type)

describe('host delivery over one io-agent session owner', () => {
  it('streams and commits a turn, and reconnects without a duplicate edit or inference', async () => {
    const f = await hostFixture((_request, response, index) => {
      if (index === 0) tool(response, 'write', { file_path: 'answer.txt', content: '42\n' }, 'write-once')
      else stream(response, [{ content: 'Frag' }, { content: 'mented reply.' }])
    })
    const id = await f.host.createSession('application-edit')
    const body = turn(id, 'Write the answer.')
    const first = await f.host.submit(body)
    const retry = await f.host.submit(body)
    expect(first.duplicate).toBe(false)
    expect(retry).toEqual({ ...first, duplicate: true })
    if (first.activity_id === undefined) throw new Error('no activity')
    expect((await f.host.settled(id, first.activity_id)).end).toBe('done')
    expect(await readFile(join(f.workspace, 'answer.txt'), 'utf8')).toBe('42\n')
    expect(f.requests).toHaveLength(2)
    const page = f.host.readSession(id, first.after)
    expect(page.events.filter(event => event.v !== 1 || event.session_id !== id || event.turn_id !== body.turn_id
      || event.activity_id !== first.activity_id)).toEqual([])
    const seqs = page.events.map(event => event.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(seqs).toEqual(seqs.toSorted((a, b) => a - b))
    expect(ofType(page.events, 'turn')[0]?.input).toEqual({ text: 'Write the answer.', images: [] })
    expect(ofType(page.events, 'tool_start')[0]).toMatchObject({ call_id: 'write-once', tool: 'write', kind: 'write', title: 'Write answer.txt', locations: [{ path: 'answer.txt' }] })
    expect(ofType(page.events, 'tool_end')[0]).toMatchObject({ call_id: 'write-once', kind: 'write', ok: true, diffs: [{ path: 'answer.txt', old: null, new: '42\n' }] })
    expect(ofType(page.events, 'text').map(event => event.delta)).toEqual(['Frag', 'mented reply.'])
    expect(ofType(page.events, 'message').at(-1)).toMatchObject({ text: 'Fragmented reply.' })
    expect(ofType(page.events, 'end').map(event => event.reason)).toEqual(['done'])
    expect(page.events.at(-1)).toMatchObject({ type: 'activity', state: 'settled' })
    const cursor = page.events[Math.floor(page.events.length / 2)]!.seq
    const replay: HostEvent[] = []
    for await (const event of f.host.watchSession(id, cursor)) {
      replay.push(event)
      if (event.seq >= page.last_seq) break
    }
    expect(replay).toEqual(page.events.filter(event => event.seq > cursor))
    expect(await f.host.submit(body)).toMatchObject({ duplicate: true })
    expect(f.requests).toHaveLength(2)
    await expect(f.host.submit({ ...body, prompt: 'Different work.' })).rejects.toMatchObject({ code: 'TURN_CONFLICT' })
    await expect(f.host.submit({ ...body, model: 'another-route' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.host.submit({ ...body, workspace: '/' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  }, 30000)

  it('previews a file edit while the model is still writing it, before the call runs', async () => {
    const args = JSON.stringify({ file_path: 'notes.md', old_string: 'teh plan', new_string: 'the plan, with every step written out' })
    const cut = args.indexOf('every')
    const f = await hostFixture((_request, response, index) => {
      if (index === 0) stream(response, [
        { tool_calls: [{ index: 0, id: 'edit-streamed', type: 'function', function: { name: 'edit', arguments: args.slice(0, cut) } }] },
        { tool_calls: [{ index: 0, function: { arguments: args.slice(cut) } }] },
      ], 'tool_calls')
      else stream(response, [{ content: 'Edited.' }])
    }, { approval: 'never' })
    await writeFile(join(f.workspace, 'notes.md'), 'teh plan\n')
    const id = await f.host.createSession()
    const { receipt } = await run(f.host, turn(id, 'Fix the plan.'))
    const events = f.host.readSession(id, receipt.after).events
    const preview = ofType(events, 'tool_preview')[0]
    expect(preview).toMatchObject({ call_id: 'edit-streamed', tool: 'edit', kind: 'edit', title: 'Edit notes.md', locations: [{ path: 'notes.md' }],
      diffs: [{ path: 'notes.md', old: 'teh plan', new: 'the plan, with ' }] })
    expect(events.indexOf(preview!)).toBeLessThan(events.findIndex(event => event.type === 'tool_start'))
    // live only: history carries the call itself and no preview
    expect(ofType((await f.host.history(id)).events, 'tool_preview')).toEqual([])
  }, 30000)

  it('delivers nested AGENTS before mutation and retains failed edit outcomes', async () => {
    const f = await hostFixture((request, response, index) => {
      if (index === 0 || index === 1) {
        if (index === 1) expect(JSON.stringify(request.messages)).toContain('NESTED_RULE_APPLICATION')
        tool(response, 'write', { file_path: 'nested/value.txt', content: 'before' }, `write-${index}`)
      } else if (index === 2) tool(response, 'edit', { file_path: 'nested/value.txt', old_string: 'absent', new_string: 'bad' }, 'failed-edit')
      else if (index === 3) tool(response, 'read', { file_path: 'nested/value.txt' }, 'observe')
      else if (index === 4) tool(response, 'edit', { file_path: 'nested/value.txt', old_string: 'before', new_string: 'after' }, 'edit')
      else stream(response, [{ content: 'Edited after receiving guidance.' }])
    })
    await mkdir(join(f.workspace, 'nested'))
    await writeFile(join(f.workspace, 'nested/AGENTS.md'), 'NESTED_RULE_APPLICATION: retain ordinary editing guards.\n')
    const id = await f.host.createSession()
    await run(f.host, turn(id, 'Edit nested/value.txt.'))
    expect(await readFile(join(f.workspace, 'nested/value.txt'), 'utf8')).toBe('after')
    const ends = ofType((await f.host.history(id)).events, 'tool_end')
    expect(ends.map(event => event.ok)).toEqual([false, true, false, true, true])
    expect(ends.map(event => event.kind)).toEqual(['write', 'write', 'edit', 'read', 'edit'])
    expect(ends.at(-1)?.diffs?.[0]).toMatchObject({ path: 'nested/value.txt', new: 'after' })
  }, 30000)

  it('keeps selected skill instructions and contained resource guards in the runtime', async () => {
    const f = await hostFixture((request, response, index) => {
      if (index === 0) {
        expect(JSON.stringify(request.messages)).not.toContain('SELECTED_SKILL_BODY_APPLICATION')
        tool(response, 'skill', { name: 'adapter-skill' }, 'select')
      } else if (index === 1) {
        expect(JSON.stringify(request.messages)).toContain('SELECTED_SKILL_BODY_APPLICATION')
        tool(response, 'skill_read', { name: 'adapter-skill', path: 'reference.txt' }, 'resource')
      } else if (index === 2) tool(response, 'skill_read', { name: 'adapter-skill', path: '../outside.txt' }, 'escape')
      else stream(response, [{ content: 'Used the selected resource.' }])
    })
    const directory = join(f.workspace, '.agents/skills/adapter-skill')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), '---\nname: adapter-skill\ndescription: Inspect a contained reference.\n---\nSELECTED_SKILL_BODY_APPLICATION\n')
    await writeFile(join(directory, 'reference.txt'), 'RESOURCE_APPLICATION\n')
    await writeFile(join(directory, '../outside.txt'), 'MUST_NOT_LEAK_RESOURCE\n')
    const id = await f.host.createSession()
    await run(f.host, turn(id, 'Use adapter-skill.'))
    expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain('RESOURCE_APPLICATION')
    expect(JSON.stringify(f.requests)).not.toContain('MUST_NOT_LEAK_RESOURCE')
    expect(ofType((await f.host.history(id)).events, 'tool_end').map(event => event.ok)).toEqual([true, true, false])
  }, 30000)

  it('retains full questions across a disconnected observer and settles duplicate replies once', async () => {
    const questions = [{ id: 'choice', question: 'Which options?', multiSelect: true,
      options: ['one', 'two', 'three', 'four', 'five'].map(label => ({ label, description: `Meaning of ${label}` })) }]
    const f = await hostFixture((_request, response, index) => {
      if (index === 0) tool(response, 'ask_user_question', { questions: questions.map(({ multiSelect, ...question }) => ({ ...question, multi_select: multiSelect })) })
      else stream(response, [{ content: 'Using the chosen options.' }])
    })
    const id = await f.host.createSession()
    const receipt = await f.host.submit(turn(id, 'Ask the human.'))
    const { request } = await pending(f.host, id, 'question')
    if (request.kind !== 'question') throw new Error('wrong interaction kind')
    expect(request.questions).toEqual(questions)
    expect(f.host.readSession(id).status).toBe('needs_you')
    expect(ofType(f.host.readSession(id, receipt.after).events, 'tool_start').at(-1)).toMatchObject({ kind: 'question', title: 'Which options?' })
    const signal = new AbortController(); signal.abort()
    await expect(f.host.watchSession(id, undefined, signal.signal).next()).rejects.toThrow()
    expect(f.host.readSession(id).activity?.status).toBe('running')
    expect(f.requests).toHaveLength(1)
    const reply = { session_id: id, request_id: request.request_id, kind: 'question',
      answer: { answers: [{ id: 'choice', selected: ['one', 'five'], custom: 'Additional context.' }] } }
    expect(f.host.reply(reply)).toEqual(f.host.reply(reply))
    expect(() => f.host.reply({ ...reply, answer: { answers: [{ id: 'choice', selected: ['two'] }] } })).toThrow()
    expect((await f.host.settled(id, receipt.activity_id!)).end).toBe('done')
    expect(JSON.stringify(f.requests[1]!.messages)).toContain('Additional context.')
    expect(f.requests[0]!.tools!.map(entry => entry.function.name)).toContain('ask_user_question')
    const events = f.host.readSession(id, receipt.after).events
    expect(events.find(event => event.type === 'interaction_closed')).toMatchObject({ request_id: request.request_id, reason: 'answered' })
  }, 30000)

  it('keeps permissions distinct from questions and commits an explicitly approved memory mutation', async () => {
    const f = await hostFixture((_request, response, index) => {
      if (index === 0) tool(response, 'memory', { action: 'put', key: 'application-note', value: 'approved-value', revision: 0 })
      else stream(response, [{ content: 'Memory stored.' }])
    })
    const id = await f.host.createSession()
    const receipt = await f.host.submit(turn(id, 'Store the approved note.'))
    const { request } = await pending(f.host, id, 'approval')
    if (request.kind !== 'approval') throw new Error('wrong interaction kind')
    expect(request.toolName).toBe('memory')
    expect(request.reason).toContain('application-note')
    expect(() => f.host.reply({ session_id: id, request_id: request.request_id, kind: 'approval', decision: ['allowed-once'] })).toThrow()
    expect(() => f.host.reply({ session_id: id, request_id: request.request_id, kind: 'question', answer: { answers: [] } })).toThrow()
    f.host.reply({ session_id: id, request_id: request.request_id, kind: 'approval', decision: 'allowed-once' })
    await f.host.settled(id, receipt.activity_id!)
    const events = await journal(f.context(), id)
    expect(events.some(event => event.type === 'approval/decided' && event.data.outcome === 'allowed-once')).toBe(true)
    expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain('approved-value')
    await f.host.close()
    const replacement = await f.open()
    const secondId = await replacement.createSession()
    await run(replacement, turn(secondId, 'Inspect the saved memory snapshot.', 'memory-reopen-turn'))
    expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain('approved-value')
  }, 30000)

  it('cancels a pending question, rejects its late answer and never restarts inference', async () => {
    const f = await hostFixture((_request, response, index) => {
      if (index === 0) tool(response, 'ask_user_question', { questions: [{ id: 'choice', question: 'Which?', options: [{ label: 'one' }] }] })
      else stream(response, [{ content: 'Must not resume.' }])
    })
    const id = await f.host.createSession()
    const receipt = await f.host.submit(turn(id, 'Ask then wait.'))
    const { request } = await pending(f.host, id, 'question')
    expect((await f.host.cancel(id, receipt.activity_id))?.end).toBe('cancelled')
    expect(() => f.host.reply({ session_id: id, request_id: request.request_id, kind: 'question',
      answer: { answers: [{ id: 'choice', selected: ['one'] }] } })).toThrow()
    expect(f.requests).toHaveLength(1)
    expect(f.host.readActivity(id, receipt.activity_id!).pending_requests).toEqual([])
    expect(ofType(f.host.readSession(id, receipt.after).events, 'end').map(event => event.reason)).toEqual(['cancelled'])
  }, 30000)

  it('fails closed when the disconnected approval bridge times out', async () => {
    const f = await hostFixture((_request, response, index) => {
      if (index === 0) tool(response, 'memory', { action: 'put', key: 'not-authorized', value: 'no', revision: 0 })
      else stream(response, [{ content: 'Permission remains unavailable.' }])
    }, {}, { interactionTimeoutMs: 30 })
    const id = await f.host.createSession()
    await run(f.host, turn(id, 'Request a protected change.'))
    const events = await journal(f.context(), id)
    expect(events.filter(event => event.type === 'approval/decided').map(event => event.data.outcome)).toEqual(['unavailable'])
    expect(events.filter(event => event.type === 'tool/result').map(event => event.data.message.isError)).toEqual([true])
  }, 30000)

  it('cancels stalled inference; a replacement host keeps idempotency and refuses the old cursor as a gap', async () => {
    const started = Promise.withResolvers<undefined>()
    const f = await hostFixture((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders(); started.resolve(undefined) })
    const id = await f.host.createSession('recover-application')
    const body = turn(id, 'Wait during inference.')
    const receipt = await f.host.submit(body)
    await started.promise
    expect((await f.host.cancel(id))?.end).toBe('cancelled')
    const original = await journal(f.context(), id)
    const oldCursor = f.host.readSession(id).last_seq
    await f.host.close()
    const replacement = await f.open()
    await replacement.resumeSession(id)
    expect(await replacement.resumeSession(id)).toBe(id)
    const resumed = await journal(f.context(), id)
    expect(resumed.slice(0, original.length)).toEqual(original)
    expect(resumed.slice(original.length).every(event => event.type === 'session/end-seed')).toBe(true)
    expect(() => replacement.readSession(id, oldCursor)).toThrow(expect.objectContaining({ code: 'REPLAY_GAP' }))
    const history = await replacement.history(id)
    expect(replacement.readSession(id, history.cursor).events).toEqual([])
    expect(history.events.map(event => event.type)).toEqual(['turn', 'end'])
    expect(history.events[0]?.turn_id).toBe(body.turn_id)
    expect(await replacement.submit(body)).toMatchObject({ duplicate: true, turn_id: body.turn_id })
    expect(receipt.activity_id).toBeDefined()
    expect(f.requests).toHaveLength(1)
  }, 30000)

  it('closes a pending permission before shutdown and does not persist a fabricated answer', async () => {
    const f = await hostFixture((_request, response) => { tool(response, 'memory', { action: 'put', key: 'shutdown-note', value: 'no', revision: 0 }) })
    const id = await f.host.createSession()
    const receipt = await f.host.submit(turn(id, 'Wait for permission.'))
    const { request } = await pending(f.host, id, 'approval')
    const done = f.host.settled(id, receipt.activity_id!)
    await f.host.close()
    await done
    expect(() => f.host.reply({ session_id: id, request_id: request.request_id, kind: 'approval', decision: 'allowed-once' })).toThrow()
    const replacement = await f.open()
    await replacement.resumeSession(id)
    const events = await journal(f.context(), id)
    expect(events.filter(event => event.type === 'approval/decided').every(event => event.data.outcome !== 'allowed-once')).toBe(true)
    expect(events.filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind).toBe('aborted')
    expect(f.requests).toHaveLength(1)
  }, 30000)

  it('reports replay eviction as a gap, keeps history, and admits turns without an identity capacity', async () => {
    const f = await hostFixture((_request, response) => { stream(response, Array.from({ length: 40 }, () => ({ content: 'fragment ' }))) }, {},
      { maxReplayEvents: 4 })
    const id = await f.host.createSession()
    const body = turn(id, 'Produce enough frames to exceed replay storage.')
    const { receipt } = await run(f.host, body)
    expect(() => f.host.readSession(id, receipt.after)).toThrow(expect.objectContaining({ code: 'REPLAY_GAP' }))
    expect(f.host.readSession(id).events).toHaveLength(4)
    expect(ofType((await f.host.history(id)).events, 'message')[0]?.text).toBe('fragment '.repeat(40))
    for (let index = 0; index < 3; index += 1) await run(f.host, turn(id, `Next turn ${String(index)}.`, `later-turn-${String(index)}`))
    expect(await f.host.submit(body)).toMatchObject({ duplicate: true })
    expect(f.requests).toHaveLength(4)
  }, 30000)

  it('keeps foreground child ownership and background jobs in the existing runtime', async () => {
    let jobId: string | undefined
    let childId: string | undefined
    const f = await hostFixture((_request, response, index) => {
      if (index === 0) tool(response, 'subagent', { description: 'Inspect', prompt: 'Report CHILD_APPLICATION.', run_in_background: false }, 'child')
      else if (index === 1) stream(response, [{ content: 'CHILD_APPLICATION' }])
      else if (index === 2) tool(response, 'bash', { command: 'sleep 0.05; printf JOB_APPLICATION', description: 'Run background work', run_in_background: true }, 'background')
      else if (index === 3) {
        if (!jobId) throw new Error('background tool did not return a job id')
        tool(response, 'job_output', { job_id: jobId, wait: true, timeout_ms: 10000 }, 'output')
      } else stream(response, [{ content: 'Foreground and background work finished.' }])
    }, { configure: (context) => {
      context.on('tools/result', (exec, result) => {
        if (exec.name === 'bash') jobId = (result.value as { jobId?: string } | undefined)?.jobId
      })
      context.on('agent/created', ({ agent }) => {
        if (agent.session.header.parentSession !== undefined) childId = String(agent.id)
      })
    } })
    const id = await f.host.createSession()
    const { activity } = await run(f.host, turn(id, 'Delegate, then run background work.'))
    expect(activity.end).toBe('done')
    expect(f.requests).toHaveLength(5)
    expect(f.requests.every(request => request.model === 'fixture-model')).toBe(true)
    const final = JSON.stringify(f.requests.at(-1)!.messages)
    expect(final).toContain('CHILD_APPLICATION'); expect(final).toContain('JOB_APPLICATION')
    const ends = ofType((await f.host.history(id)).events, 'tool_end')
    expect(ends.every(event => event.ok)).toBe(true)
    expect(ends.map(event => event.kind)).toEqual(['delegate', 'command', 'read'])
    expect(childId).toBeDefined()
    expect((await f.host.listSessions()).map(entry => entry.id)).toEqual([id])
    await expect(f.host.resumeSession(childId!)).rejects.toMatchObject({ code: 'UNKNOWN_SESSION' })
  }, 30000)

  it.each([false, true])('preserves child approval policy and exact action evidence (host asks: %s)', async (hostAsks) => {
    let outside = ''
    const mutation = () => ({ file_path: outside, content: 'approved-child-write', sandbox_permissions: 'danger-full-access', justification: 'Write the test-owned sibling file' })
    const f = await hostFixture((_request, response, index) => {
      if (index === 0) tool(response, 'subagent', { description: 'Write', prompt: 'Request permission for the sibling write.', run_in_background: false }, 'child')
      else if (index === 1) tool(response, 'write', mutation(), 'child-write')
      else if (index === 2) stream(response, [{ content: 'Child write finished.' }])
      else stream(response, [{ content: 'Delegation finished.' }])
    }, { configure: (context) => {
      if (hostAsks) context.on('agent/created', ({ agent }) => {
        if (agent.session.header.parentSession !== undefined) context.approval.setPolicy(agent, 'ask')
      })
    } })
    outside = join(f.workspace, '..', 'owned-child-output.txt')
    const id = await f.host.createSession()
    const receipt = await f.host.submit(turn(id, 'Delegate the sibling write.'))
    if (!hostAsks) {
      await f.host.settled(id, receipt.activity_id!)
      expect(f.host.readSession(id, receipt.after).events.some(event => event.type === 'interaction')).toBe(false)
      expect(JSON.stringify(f.requests[2]!.messages)).toContain('rejected escalating')
      await expect(readFile(outside, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      return
    }
    const { request } = await pending(f.host, id, 'approval')
    if (request.kind !== 'approval') throw new Error('wrong interaction kind')
    expect(request.agent_id).not.toBe(id)
    expect(request.toolName).toBe('write')
    expect(request.callId).toBe('child-write')
    expect(request.arguments).toEqual(mutation())
    await expect(readFile(outside, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    // Rendering a detached request must not rewrite the action being authorized.
    const displayed = request.arguments as { content: string }
    displayed.content = 'mutated-display-copy'
    const again = await pending(f.host, id, 'approval')
    expect(again.request.kind === 'approval' && again.request.arguments).toEqual(mutation())
    f.host.reply({ session_id: id, request_id: request.request_id, kind: 'approval', decision: 'allowed-once' })
    expect((await f.host.settled(id, receipt.activity_id!)).end).toBe('done')
    expect(f.requests).toHaveLength(4)
    expect(await readFile(outside, 'utf8')).toBe('approved-child-write')
    expect(JSON.stringify(f.requests)).not.toContain('mutated-display-copy')
  }, 30000)

  // its bash runs confined: it needs a confinement backend
  it.skipIf(!sandboxUsable)('cancels a running foreground tool before its delayed filesystem mutation', async () => {
    const f = await hostFixture((_request, response, index) => {
      if (index === 0) tool(response, 'bash', { command: 'printf ready > started.txt; sleep 30; printf bad > should-not-exist.txt', description: 'Wait for cancellation', timeout_ms: 40000 })
      else stream(response, [{ content: 'Must not continue after cancellation.' }])
    })
    const id = await f.host.createSession()
    const receipt = await f.host.submit(turn(id, 'Run until cancelled.'))
    await expect.poll(async () => readFile(join(f.workspace, 'started.txt'), 'utf8').catch(() => ''), { timeout: 5000 }).toBe('ready')
    expect(ofType(f.host.readSession(id, receipt.after).events, 'tool_start').at(-1)).toMatchObject({ kind: 'command', detail: 'Wait for cancellation' })
    expect((await f.host.cancel(id, receipt.activity_id))?.end).toBe('cancelled')
    await expect(readFile(join(f.workspace, 'should-not-exist.txt'))).rejects.toThrow()
    expect(f.requests).toHaveLength(1)
  }, 30000)

  it('uses explicit native compaction and tool-free review on the same connection', async () => {
    const f = await hostFixture((_request, response, index) => { stream(response, [{ content: index < 2 ? 'evidence '.repeat(700)
      : index === 2 ? '## Current Work\nPreserve the original task and requirements.'
        : '{"status":"passed","summary":"Recorded evidence is consistent.","findings":[]}' }]) })
    const id = await f.host.createSession()
    for (let i = 0; i < 2; i++) await run(f.host, turn(id, 'Retain this task: ' + 'requirement '.repeat(200), `maintenance-turn-${i}`))
    expect(await f.host.compact(id)).not.toBeNull()
    const review = await f.host.verify(id)
    expect(review.status).toBe('passed'); expect(review.findings).toEqual([])
    expect(f.requests.every(request => request.model === 'fixture-model')).toBe(true)
    expect(f.requests.at(-1)!.tools).toBeUndefined()
    expect(f.requests.at(-1)!.max_tokens).toBe(2048)
    expect((await journal(f.context(), id)).some(event => event.type === 'compaction/summary')).toBe(true)
  }, 30000)

  it('rejects a persisted session belonging to another canonical workspace', async () => {
    const f = await hostFixture((_request, response) => { stream(response, [{ content: 'Durable original.' }]) })
    const id = await f.host.createSession()
    await run(f.host, turn(id, 'Record the original workspace.'))
    const original = await journal(f.context(), id)
    await f.host.close()
    const otherWorkspace = join(f.workspace, 'other'); await mkdir(otherWorkspace)
    const wrong = await createHost({ ...f.options, ioAgent: { ...f.options.ioAgent, workspace: otherWorkspace } })
    onFixtureCleanup(() => wrong.close())
    await expect(wrong.resumeSession(id)).rejects.toMatchObject({ code: 'UNKNOWN_SESSION' })
    await expect(wrong.history(id)).rejects.toMatchObject({ code: 'UNKNOWN_SESSION' })
    await wrong.close()
    const restored = await f.open()
    await restored.resumeSession(id)
    const resumed = await journal(f.context(), id)
    expect(resumed.slice(0, original.length)).toEqual(original)
    expect(resumed.slice(original.length).every(event => event.type === 'session/end-seed')).toBe(true)
  }, 30000)

  it('preserves native plan-review intent and detail without interpreting a generic answer as approval', async () => {
    const plan = '# Inspect the project\nRead the current implementation, then propose the exact edit.'
    const f = await hostFixture((_request, response, index) => {
      if (index === 0) tool(response, 'exit_plan_mode', { plan }, 'plan-review')
      else stream(response, [{ content: 'The plan remains unapproved.' }])
    }, {
      configure: (context) => { context.on('agent/created', ({ agent }) => { context.planMode.set(agent, true) }) },
    })
    const id = await f.host.createSession()
    const receipt = await f.host.submit(turn(id, 'Present the plan.'))
    const { request } = await pending(f.host, id, 'question')
    if (request.kind !== 'question') throw new Error('missing plan review')
    const question = request.questions[0]!
    expect(question.detail).toBe(plan)
    expect(question.intent?.kind).toBe('plan-review')
    const decline = question.options!.find(option => option.label !== question.intent!.approve)!.label
    f.host.reply({ session_id: id, request_id: request.request_id, kind: 'question', answer: { answers: [{ id: question.id, selected: [decline] }] } })
    await f.host.settled(id, receipt.activity_id!)
    expect(ofType((await f.host.history(id)).events, 'tool_start')[0]).toMatchObject({ kind: 'plan', title: 'Inspect the project' })
    expect((await journal(f.context(), id)).filter(event => event.type === 'plan/mode').some(event => !event.data.active)).toBe(false)
  }, 30000)
})
