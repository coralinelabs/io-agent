/** Question availability follows the fully configured host composition. */
import { describe, expect, it } from 'vitest'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from "../../../src/library/interaction/user-questions/index.ts"
import { fixture, stream, tool, type Request } from './fixture.ts'

function questionModes(request: Request): string[] | undefined {
  const tool = request.tools?.find(t => t.function.name === 'ask_user_question')
  return (tool?.function as { parameters?: { properties?: { mode?: { enum: string[] } } } } | undefined)?.parameters?.properties?.mode?.enum
}

const questions = [{ id: 'branch', question: 'Which branch?', options: [{ label: 'main' }] }]
const answer = { answers: [{ id: 'branch', selected: ['main'] }] }

function askThenReply(text = 'Done.'): Parameters<typeof fixture>[0] {
  return (_request, response, index) => {
    if (index === 0) tool(response, 'ask_user_question', { mode: 'blocking', questions })
    else stream(response, [{ content: text }])
  }
}

describe('configured human-question capability', () => {
  it('offers continued questions without a responder but rejects unavailable blocking mode', async () => {
    const { app, requests } = await fixture(askThenReply('The decision remains unresolved.'))
    const result = await (await app.createSession()).run('Use only available capabilities.')
    expect(requests).toHaveLength(2)
    for (const request of requests) expect(questionModes(request)).toEqual(['continue'])
    expect(questionModes(requests[0]!)).not.toContain('blocking')
    const outcomes = result.events.filter(event => event.type === 'tool/result')
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.data.message.isError).toBe(true)
    expect(JSON.stringify(outcomes)).not.toContain('"selected"')
  }, 30000)

  it('advertises the callback responder and returns its answer to the model', async () => {
    const seen: AskUserQuestionRequest[] = []
    const { app, requests } = await fixture(askThenReply('Using main.'), {
      onQuestion: async (request) => { seen.push(request); return answer },
    })
    const result = await (await app.createSession()).run('Ask which branch to use.')
    expect(requests[0]!.tools?.map(item => item.function.name)).toContain('ask_user_question')
    expect(seen.map(request => request.questions)).toEqual([questions])
    expect(result.stopReason).toEqual({ kind: 'completed' })
    expect(requests[1]!.messages.filter(message => message.role === 'tool').map(message => message.content))
      .toEqual([JSON.stringify(answer)])
  }, 30000)

  it('waits for asynchronous configure to install a responder without onQuestion', async () => {
    const seen: AskUserQuestionRequest[] = []
    const { app, requests } = await fixture(askThenReply('Using main.'), {
      configure: async (context) => {
        await Promise.resolve()
        context.on('user-questions/request', async (request) => { seen.push(request); return answer })
      },
    })
    const result = await (await app.createSession()).run('Ask which branch to use.')
    expect(requests[0]!.tools?.map(item => item.function.name)).toContain('ask_user_question')
    expect(seen.map(request => request.questions)).toEqual([questions])
    expect(result.stopReason).toEqual({ kind: 'completed' })
    expect(requests[1]!.messages.filter(message => message.role === 'tool').map(message => message.content))
      .toEqual([JSON.stringify(answer)])
  }, 30000)

  it('does not advertise a responder removed before configure finishes', async () => {
    const { app, requests } = await fixture((_request, response) => { stream(response, [{ content: 'Done.' }]) }, {
      configure: (context) => {
        const dispose = context.on('user-questions/request', async () => answer)
        dispose()
      },
    })
    await (await app.createSession()).run('Report available work.')
    expect(questionModes(requests[0]!)).toEqual(['continue'])
  }, 30000)

  it('advertises a creation-time scoped responder only to its matching agent', async () => {
    let configuredAgents = 0
    const seen: AskUserQuestionRequest[] = []
    const { app, requests } = await fixture(askThenReply('Done.'), {
      configure: (context) => {
        context.on('agent/created', ({ agent }) => {
          if (configuredAgents++ === 0) {
            agent.ctx.on('user-questions/request', async (request) => { seen.push(request); return answer })
          }
        })
      },
    })
    const first = await app.createSession(), second = await app.createSession()
    await first.run('Ask a question.')
    await second.run('Report available work.')
    expect(requests[0]!.tools?.map(item => item.function.name)).toContain('ask_user_question')
    expect(questionModes(requests[2]!)).toEqual(['continue'])
    expect(questionModes(requests[2]!)).not.toContain('blocking')
    expect(seen.map(request => request.agent?.id)).toEqual([first.id])
  }, 30000)

  it('preserves global answerers registered from a scoped context', async () => {
    let configuredAgents = 0
    const { app, requests } = await fixture(askThenReply('Done.'), {
      configure: (context) => {
        context.on('agent/created', ({ agent }) => {
          if (configuredAgents++ === 0) agent.ctx.on('user-questions/request', async () => answer, { global: true })
        })
      },
    })
    await app.createSession()
    const second = await app.createSession()
    const result = await second.run('Ask a question through the global answerer.')
    expect(requests[0]!.tools?.map(item => item.function.name)).toContain('ask_user_question')
    expect(result.events.filter(event => event.type === 'tool/result').map(event => event.data.message.isError)).toEqual([false])
  }, 30000)

  it('does not mistake an existing agent cancellation wrapper for a responder on a later agent', async () => {
    let removeAnswerer!: () => boolean
    const { app, requests } = await fixture((_request, response) => { stream(response, [{ content: 'Done.' }]) }, {
      configure: (context) => {
        removeAnswerer = context.on('user-questions/request', async () => answer)
      },
    })
    const first = await app.createSession()
    await first.run('Report available work.')
    expect(requests[0]!.tools?.map(item => item.function.name)).toContain('ask_user_question')
    removeAnswerer()
    const second = await app.createSession()
    await second.run('Report available work.')
    expect(questionModes(requests[1]!)).toEqual(['continue'])
  }, 30000)

  it('omits human interaction from owned children and rejects their unsolicited questions', async () => {
    const seen: AskUserQuestionRequest[] = []
    const { app, requests } = await fixture((_request, response, index) => {
      if (index === 0) tool(response, 'subagent', { description: 'Inspect task', prompt: 'Inspect without asking the human.', run_in_background: false })
      else if (index === 1) tool(response, 'ask_user_question', { questions })
      else stream(response, [{ content: index === 2 ? 'The child decision remains unresolved.' : 'Parent finished.' }])
    }, { onQuestion: async (request) => { seen.push(request); return answer } })
    const result = await (await app.createSession()).run('Delegate a short inspection.')
    expect(result.text).toBe('Parent finished.')
    expect(requests).toHaveLength(4)
    for (const index of [0, 3]) expect(requests[index]!.tools?.map(item => item.function.name)).toContain('ask_user_question')
    for (const index of [1, 2]) expect(requests[index]!.tools?.map(item => item.function.name)).not.toContain('ask_user_question')
    expect(JSON.stringify(requests[1]!.messages)).not.toContain('ask_user_question')
    expect(seen).toEqual([])
    expect(JSON.stringify(requests[2]!.messages)).not.toContain('"selected"')
  }, 30000)

  it('keeps hostless planning conditional on available questions and never invents plan approval', async () => {
    const { app, requests } = await fixture((_request, response, index) => {
      if (index === 0) tool(response, 'exit_plan_mode', { plan: '# Proposed work\nThe user must choose a branch before implementation.' })
      else stream(response, [{ content: 'The plan remains unapproved.' }])
    }, {
      configure: (context) => {
        context.on('agent/created', ({ agent }) => { context.planMode.set(agent, true) })
      },
    })
    const result = await (await app.createSession()).run('Prepare the plan.')
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(questionModes(request)).toEqual(['continue'])
      const text = JSON.stringify(request.messages)
      expect(text).toContain('When ask_user_question is available, use it only for')
      expect(text).toContain('otherwise retain unresolved user-owned choices in the plan')
      expect(text).toContain('If the review channel is unavailable or aborted, stay in plan mode')
    }
    expect(result.events.filter(event => event.type === 'tool/result').map(event => event.data.message.isError)).toEqual([true])
    expect(result.events.filter(event => event.type === 'plan/mode').some(event => !event.data.active)).toBe(false)
  }, 30000)

  it('cancels a configured responder and ignores its late answer', async () => {
    const reached = Promise.withResolvers<boolean>()
    const pending = Promise.withResolvers<AskUserQuestionAnswer>()
    let requestSignal: AbortSignal | undefined
    const { app, requests } = await fixture(askThenReply('Following the next explicit request.'), {
      configure: (context) => {
        context.on('user-questions/request', (request) => {
          requestSignal = request.signal
          reached.resolve(true)
          return pending.promise
        })
      },
    })
    const session = await app.createSession()
    const controller = new AbortController()
    const running = session.run('Ask which branch to use.', { signal: controller.signal })
    await reached.promise
    controller.abort(new Error('host cancelled the question'))
    expect(requestSignal?.aborted).toBe(true)
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const bounded = Promise.race([
        running.then(() => 'settled'),
        new Promise<string>((resolve) => { deadline = setTimeout(() => { resolve('still waiting for the human') }, 1000) }),
      ])
      expect(await bounded).toBe('settled')
    } finally {
      clearTimeout(deadline)
      pending.resolve(answer)
      await running
    }
    const result = await running
    expect(result.stopReason?.kind).toBe('aborted')
    expect(result.events.filter(event => event.type === 'tool/result').map(event => event.data.message.isError)).toEqual([true])
    expect(requests).toHaveLength(1)
    expect((await session.run('Continue without the cancelled answer.')).stopReason?.kind).toBe('completed')
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1]!.messages)).not.toContain('"selected"')
  }, 30000)
})
