/** Namespaced turn keys retain their exact identities through the real journal and runtime. */
import { describe, expect, it } from 'vitest'
import { identifier, steering, turnKey } from '../../../src/library/host/validation.ts'
import { tool } from './fixture.ts'
import { hostFixture, journal, pending, turn } from './host-fixture.ts'

describe('bounded host journal identities', () => {
  it('keeps session and steering limits separate from opaque turn keys', () => {
    expect(identifier('s'.repeat(128), 'session_id')).toHaveLength(128)
    expect(() => identifier('s'.repeat(129), 'session_id')).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(turnKey('t'.repeat(256), 'turn_id')).toHaveLength(256)
    for (const value of ['t'.repeat(257), 'short', 'turn/path', 'turn.key']) {
      expect(() => turnKey(value, 'turn_id')).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    }
    const body = { session_id: 'session', turn_id: 't'.repeat(256), steer_id: 's'.repeat(128), prompt: 'A hint.' }
    expect(steering(body)).toEqual(body)
    expect(() => steering({ ...body, steer_id: 's'.repeat(129) })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })

  it.each([198, 256])('retains a %i-character turn across retry, cancellation and restart', async length => {
    const f = await hostFixture((_request, response) => tool(response, 'ask_user_question', {
      questions: [{ id: 'choice', question: 'Which?', options: [{ label: 'one' }] }],
    }))
    const session = await f.host.createSession(`room-${'C'.repeat(64)}`)
    const key = `room:${'C'.repeat(64)}:${'m'.repeat(length - 70)}`
    const body = turn(session, 'Ask and wait.', key)
    expect(key).toHaveLength(length)
    expect(await f.host.lookupTurn(session, key)).toBeUndefined()
    const receipt = await f.host.submit(body)
    await pending(f.host, session, 'question')
    expect(await f.host.lookupTurn(session, key)).toEqual({ receipt: { ...receipt, duplicate: true } })
    expect(await f.host.submit(body)).toEqual({ ...receipt, duplicate: true })
    await expect(f.host.submit({ ...body, prompt: 'Different request.' })).rejects.toMatchObject({ code: 'TURN_CONFLICT' })
    await f.host.cancelTurn(session, key)
    expect(f.host.readActivity(session, receipt.activity_id!)).toMatchObject({ status: 'settled', end: 'cancelled' })
    expect((await f.host.history(session)).events.filter(event => event.type === 'turn' || event.type === 'end')
      .every(event => event.turn_id === key)).toBe(true)
    await f.host.close()

    const reopened = await f.open()
    expect(await reopened.lookupTurn(session, key)).toMatchObject({ receipt: { session_id: session, turn_id: key, duplicate: true } })
    expect(await reopened.submit(body)).toMatchObject({ turn_id: key, duplicate: true })
    const successor = await reopened.submit(turn(session, 'Ask again.', `next${key.slice(4)}`))
    await pending(reopened, session, 'question')
    await reopened.cancelTurn(session, key)
    expect(reopened.readActivity(session, successor.activity_id!).status).toBe('running')
    await reopened.cancelTurn(session, successor.turn_id)
    await reopened.cancelTurn(session, successor.turn_id)
    expect(reopened.readActivity(session, successor.activity_id!)).toMatchObject({ status: 'settled', end: 'cancelled' })
    expect(f.requests).toHaveLength(2)
    expect((await journal(f.context(), session)).filter(event => event.type === 'host/turn').map(event => event.data.turnId))
      .toEqual([key, successor.turn_id])
  }, 30000)

  it('rejects oversized keys before admission and keeps steering at 128 with a long target', async () => {
    const f = await hostFixture((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders()
    })
    const session = await f.host.createSession('session-with-long-turn')
    const body = turn(session, 'Wait during inference.', 't'.repeat(256))
    const oversized = 't'.repeat(257)
    await expect(f.host.submit({ ...body, turn_id: oversized })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.host.lookupTurn(session, oversized)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.host.cancelTurn(session, oversized)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.host.createSession('s'.repeat(129))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect((await journal(f.context(), session)).some(event => event.type === 'host/turn')).toBe(false)
    expect(f.requests).toHaveLength(0)

    const receipt = await f.host.submit(body)
    await expect.poll(() => f.requests.length).toBe(1)
    const hint = { session_id: session, turn_id: body.turn_id, steer_id: 's'.repeat(128), prompt: 'One hint.' }
    await expect(f.host.steer({ ...hint, steer_id: 's'.repeat(129) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.host.steer({ ...hint, turn_id: oversized })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await f.host.steer(hint)).toEqual({ accepted: true })
    expect(await f.host.steer(hint)).toEqual({ accepted: true })
    const events = await journal(f.context(), session)
    expect(events.filter(event => event.type === 'host/steer').map(event => event.data.turnId)).toEqual([body.turn_id])
    await f.host.cancelTurn(session, body.turn_id)
    expect(f.host.readActivity(session, receipt.activity_id!)).toMatchObject({ status: 'settled', end: 'cancelled' })
    expect(f.requests).toHaveLength(1)
  }, 30000)
})
