/** Delegated retries follow the existing runtime and root journal, never the model surface. */
import { describe, expect, it } from 'vitest'
import { MemorySettings } from '../../settings/settings/memory.ts'
import { SessionId } from '../../../src/library/session/journal/index.ts'
import { stream, tool } from './fixture.ts'
import { hostFixture, journal, run, turn } from './host-fixture.ts'

describe('delegated retry projection', () => {
  it.each([false, true])('projects a child retry live and after restart (background=%s)', async background => {
    let childId = '', childCalls = 0, rootCalls = 0
    const f = await hostFixture((request, response) => {
      const child = JSON.stringify(request.messages.find(message => message.role === 'user')?.content ?? '').includes('CHILD_RETRY_PROBE')
      if (child) {
        childCalls += 1
        if (childCalls === 1) { response.writeHead(503); response.end('temporarily unavailable'); return }
        stream(response, [{ content: 'Child done.' }]); return
      }
      rootCalls += 1
      if (rootCalls === 1) tool(response, 'subagent', { description: 'Inspect', prompt: 'CHILD_RETRY_PROBE', run_in_background: background }, 'delegate')
      else stream(response, [{ content: 'Root done.' }])
    }, { sandbox: 'danger-full-access', configure: context => {
      context.on('agent/created', ({ agent }) => {
        if (agent.session.header.parentSession !== undefined) childId = String(agent.session.id)
      })
    } })
    const id = await f.host.createSession()
    const other = await f.host.createSession()
    const receipt = await f.host.submit(turn(id, 'Delegate the inspection.'))
    await expect.poll(() => f.host.readSession(id).events.filter(event => event.type === 'retry').length).toBe(1)
    const live = f.host.readSession(id).events.find(event => event.type === 'retry')!
    expect(live).toMatchObject({ type: 'retry', session_id: id, child_session_id: childId, attempt: 1, max_attempts: 30 })
    expect(live).not.toHaveProperty('turn_id')
    expect(f.host.readSession(other).events.filter(event => event.type === 'retry')).toEqual([])
    await expect.poll(() => childCalls).toBe(2)
    await f.host.settled(id, receipt.activity_id!)
    // Wait for the generic background job to settle before closing the owning root.
    await expect.poll(() => f.context().agents.list().filter(agent => agent.session.header.parentSession !== undefined)
      .every(agent => agent.status === 'idle')).toBe(true)
    const rootLog = await journal(f.context(), id)
    const childLog = await journal(f.context(), childId)
    const forwarded = rootLog.filter(event => event.type === 'host/child-retry')
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]?.data).toMatchObject({ sessionId: childId, sourceSeq: childLog.find(event => event.type === 'llm/retry')?.seq })
    expect(rootLog.filter(event => event.type === 'llm/retry')).toEqual([])
    expect(JSON.stringify(f.requests)).not.toContain('host/child-retry')
    const { activity_id: _activity, ...durable } = live
    expect((await f.host.history(id)).events.filter(event => event.type === 'retry')).toEqual([durable])
    await f.host.close()
    const reopened = await f.open()
    expect((await reopened.history(id)).events.filter(event => event.type === 'retry')).toEqual([durable])
  }, 20000)

  it('projects a nested descendant directly onto its root, once', async () => {
    const calls = new Map<string, number>()
    const f = await hostFixture((request, response) => {
      const prompt = JSON.stringify(request.messages.find(message => message.role === 'user')?.content ?? '')
      const role = prompt.includes('GRANDCHILD_PROBE') ? 'grandchild' : prompt.includes('CHILD_PROBE') ? 'child' : 'root'
      const count = (calls.get(role) ?? 0) + 1
      calls.set(role, count)
      if (count === 1 && role !== 'grandchild') {
        tool(response, 'subagent', { description: 'Inspect', prompt: role === 'root' ? 'CHILD_PROBE' : 'GRANDCHILD_PROBE', run_in_background: false }, 'delegate')
      } else if (count === 1) { response.writeHead(503); response.end('temporarily unavailable') }
      else stream(response, [{ content: 'Done.' }])
    }, { sandbox: 'danger-full-access' })
    await f.context().plugin(MemorySettings)
    await f.context().settings.update('subagent', { maxDepth: 2 })
    const id = await f.host.createSession()
    await run(f.host, turn(id, 'Delegate twice.'))
    const retries = (await f.host.history(id)).events.filter(event => event.type === 'retry')
    expect(retries).toHaveLength(1)
    const event = retries[0]!
    expect(event.type).toBe('retry')
    if (event.type !== 'retry' || event.child_session_id === undefined) throw new Error('missing descendant identity')
    const childHeader = (await f.context().sessionQuery.readSession(SessionId(event.child_session_id))).session
    expect(childHeader.parentSession).toBeDefined()
    expect(childHeader.parentSession).not.toBe(id)
    expect(childHeader.delegationDepth).toBe(2)
    expect(calls.get('grandchild')).toBe(2)
  }, 10000)

  it('keeps a root retry local and tagged to its own turn', async () => {
    const f = await hostFixture((_request, response, index) => {
      if (index === 0) { response.writeHead(503); response.end('temporarily unavailable') }
      else stream(response, [{ content: 'Done.' }])
    })
    const id = await f.host.createSession()
    await run(f.host, turn(id, 'Retry the root.', 'root-retry'))
    const retries = (await f.host.history(id)).events.filter(event => event.type === 'retry')
    expect(retries).toHaveLength(1)
    expect(retries[0]).toMatchObject({ turn_id: 'root-retry', attempt: 1 })
    expect(retries[0]).not.toHaveProperty('child_session_id')
  }, 10000)
})
