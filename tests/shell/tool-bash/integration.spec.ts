import { createUserMessage } from "../../../src/library/model/llm/index.ts"
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId, type SessionEvent } from "../../../src/library/session/journal/index.ts"
import JsonlSessionPersistence from "../../../src/library/session/persistence-jsonl/index.ts"
import type { Agent } from "../../../src/library/runtime/agents/index.ts"
import AgentLoop from "../../../src/plugins/runtime.ts"
import { mountAgentLoopTestDependencies } from "../../support/test-support/agent-loop-testkit/src/index.ts"
import LocalJobRegistry from "../../../src/library/execution/jobs/jobs-local/index.ts"
import * as ToolJobs from "../../../src/library/execution/jobs/tool-jobs/index.ts"
import Background from "../../../src/library/execution/jobs/background/index.ts"
import { LocalBashExecutor } from "../../../src/library/execution/shell/bash-local/index.ts"
import LocalSubprocessRuntime from "../../../src/library/execution/process/subprocess-local/index.ts"
import * as ToolBash from "../../../src/library/execution/shell/tool-bash/index.ts"
import * as BashEnvPlugin from "../../../src/library/execution/shell/shell-env/index.ts"
import { MockAdapter, textResponse, toolCallResponse } from "../../core/agent-loop/mock-adapter.ts"

/**
 * Full-loop integration: a scripted mock model drives the REAL bash tool
 * through the agent loop, exercising the same execution paths a live model would
 * (tool/call + tool/result session events, the generic `ctx.jobs` runtime,
 * agent.inject completion notices).
 */
async function harness(adapter: MockAdapter, sessionRoot?: string, dshHome?: string, defaultWaitMs = 10_000, backgroundRoot?: string) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  if (sessionRoot !== undefined) {
    await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot, compression: 'none' })
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalJobRegistry)
  if (backgroundRoot !== undefined) await ctx.plugin(Background, { root: backgroundRoot })
  await ctx.plugin(ToolJobs)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(BashEnvPlugin, dshHome === undefined ? {} : { userDirectory: dshHome })
  await ctx.plugin(LocalBashExecutor, { timeoutMs: defaultWaitMs })
  await ctx.plugin(ToolBash)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function events(agent: Agent): readonly SessionEvent[] {
  return agent.session.snapshotEvents()
}

/** Find a session event by type, narrowed; throws when absent. */
function findEvent<T extends SessionEvent['type']>(
  log: readonly SessionEvent[],
  type: T,
  position: 'first' | 'last' = 'first',
): Extract<SessionEvent, { type: T }> {
  const found = position === 'first'
    ? log.find(event => event.type === type)
    : log.findLast(event => event.type === type)
  if (!found) throw new Error(`no ${type} event in the session log`)
  return found as Extract<SessionEvent, { type: T }>
}

function resultText(event: SessionEvent): string {
  if (event.type !== 'tool/result') return ''
  return event.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Poll until `predicate` holds (background settlement races turn end). */
async function pollUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

describe('bash tool through the agent loop', () => {
  it('first-turn bash receives session identity in a scrubbed DSH_* namespace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-bash-session-env-'))
    dirs.push(root)
    const dshHome = join(root, 'dsh-home')
    vi.stubEnv('IO_AGENT_STALE_PARENT', 'stale')
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'bash', {
        command: 'printf \'%s\\n%s\\n%s\\n%s\\n\' "$IO_AGENT_USER_DIR" "$IO_AGENT_SHELL" "$IO_AGENT_SESSION_ID" "${IO_AGENT_STALE_PARENT-unset}"',
        description: 'inspect session environment',
      }),
      textResponse('Session environment inspected.'),
    ])
    const ctx = await harness(adapter, root, dshHome)
    const handle = await ctx.agents.create({
      sessionId: SessionId('session-env-id'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = handle.agent

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'inspect the current session' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const result = findEvent(events(agent), 'tool/result')
    expect(resultText(result)).toBe(`${dshHome}\n1\nsession-env-id\nunset\n`)
    await handle.dispose()
  })

  it('foreground: model calls bash, sees the result, replies', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'bash', { command: 'echo integration-ok', description: 'test command' }, 'Running it.'),
      textResponse('The command printed integration-ok.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('it-fg'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run echo integration-ok' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = events(agent)
    const toolCall = findEvent(log, 'tool/call')
    expect(toolCall.data.name).toBe('bash')

    const toolResult = findEvent(log, 'tool/result')
    expect(toolResult.data.message.isError).toBe(false)
    expect(resultText(toolResult)).toBe('integration-ok\n')

    // The second model call saw the tool result in its derived history.
    const lastRequest = adapter.requests.at(-1)
    const toolResultBlocks = (lastRequest?.messages ?? [])
      .filter(message => message.role === 'tool')
    expect(toolResultBlocks).toHaveLength(1)

    const finalMessage = findEvent(log, 'assistant/message', 'last')
    expect(finalMessage.data.message.content.some(
      block => block.type === 'text' && block.text.includes('integration-ok'),
    )).toBe(true)
  })

  it('foreground: non-zero exit is reported in the result text, not as isError', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'bash', { command: 'exit 9', description: 'test command' }),
      textResponse('It failed with code 9.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('it-exit'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run exit 9' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const toolResult = findEvent(events(agent), 'tool/result')
    expect(toolResult.data.message.isError).toBe(false)
    expect(resultText(toolResult)).toContain('[exit code: 9]')
  })

  it('foreground: a command outlasting the default wait is not killed; it continues as a job that wakes the agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-moved-'))
    dirs.push(dir)
    const sentinel = join(dir, 'release')
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'bash', {
        command: `echo started; while [ ! -f ${JSON.stringify(sentinel)} ]; do sleep 0.02; done; echo finished`,
        description: 'long command',
      }),
      textResponse('It is still running.'),
      toolCallResponse('call-2', 'job_output', { job_id: 'bash-1' }),
      textResponse('It finished.'),
    ])
    const ctx = await harness(adapter, undefined, undefined, 1_000)
    const agent = await ctx.agentLoop.create(SessionId('it-moved'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run the long command' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const moved = findEvent(events(agent), 'tool/result')
    expect(moved.data.message.isError).toBe(false)
    expect(resultText(moved)).toBe('started\n[still running after 1s; it continues in the background as job bash-1]')
    expect(moved.data.meta).toEqual({ background: true })
    expect(ctx.jobs.list(agent).map(job => [job.id, job.status])).toEqual([['bash-1', 'running']])

    writeFileSync(sentinel, '')
    const lastResultText = (): string => {
      const found = events(agent).findLast(event => event.type === 'tool/result')
      return found === undefined ? '' : resultText(found)
    }
    await pollUntil(() => lastResultText().includes('finished'))
    // The completion opened the second turn by itself; the read continues after the output already shown.
    expect(events(agent).filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(lastResultText()).toBe('finished\n[status: completed, exit code: 0]')
  })

  it.skipIf(process.platform !== 'linux')('foreground: with background work available, the command runs durably from its start and the job it becomes is recorded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-moved-durable-'))
    dirs.push(dir)
    const sentinel = join(dir, 'release')
    const adapter = new MockAdapter([
      toolCallResponse('call-0', 'bash', { command: 'echo quick', description: 'quick command' }),
      toolCallResponse('call-1', 'bash', {
        command: `echo started; while [ ! -f ${JSON.stringify(sentinel)} ]; do sleep 0.02; done; echo finished`,
        description: 'long command',
      }),
      textResponse('It is still running.'),
      toolCallResponse('call-2', 'job_output', { job_id: 'bash-1' }),
      textResponse('It finished.'),
    ])
    const background = join(dir, 'background')
    const ctx = await harness(adapter, undefined, undefined, 1_000, background)
    const agent = await ctx.agentLoop.create(SessionId('it-moved-durable'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run both' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const results = events(agent).filter(event => event.type === 'tool/result').map(resultText)
    expect(results[0]).toContain('quick')
    expect(results[1]).toBe('started\n[still running after 1s; it continues in the background as job bash-1]')
    // The quick command's files are gone; the moved one is a job recorded with its process.
    const recorded = ctx.background.jobsOf(new Set(['it-moved-durable']))
    expect(recorded).toMatchObject([{ jobId: 'bash-1', phase: 'running', label: expect.stringContaining('echo started') }])
    expect(readdirSync(join(background, 'jobs'))).toEqual([recorded[0]!.token])
    expect(existsSync(join(background, 'jobs', recorded[0]!.token, 'launch.json'))).toBe(true)

    writeFileSync(sentinel, '')
    const lastResultText = (): string => {
      const found = events(agent).findLast(event => event.type === 'tool/result')
      return found === undefined ? '' : resultText(found)
    }
    await pollUntil(() => lastResultText().includes('finished'))
    expect(lastResultText()).toBe('finished\n[status: completed, exit code: 0]')
  })

  it('foreground: the model\'s own timeoutMs is still a kill deadline', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'bash', { command: 'sleep 30', description: 'bounded command', timeoutMs: 200 }),
      textResponse('It timed out.'),
    ])
    const ctx = await harness(adapter, undefined, undefined, 1_000)
    const agent = await ctx.agentLoop.create(SessionId('it-deadline'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run it with a deadline' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(resultText(findEvent(events(agent), 'tool/result'))).toContain('[timed out after 200ms]')
    expect(ctx.jobs.list(agent)).toEqual([])
  })

  it('background: start ack → completion wakes the idle agent → job_output collects it', async () => {
    // The command blocks on a sentinel this test creates only after the agent
    // has gone idle, so settlement cannot fold into the still-running turn.
    // Without that fence a fast command can settle before step 2's pre-step
    // claim, which folds the notice into a turn whose scripted reply is final:
    // the turn then closes with an empty next-step inbox and the collection
    // entries are never reached.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bg-'))
    dirs.push(dir)
    const sentinel = join(dir, 'release')
    // The job id is deterministic (a fresh LocalJobRegistry counts per kind from 1),
    // so the script can name `bash-1` without threading a generated id.
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'bash', {
        command: `while [ ! -f ${JSON.stringify(sentinel)} ]; do sleep 0.02; done; echo bg-ok`,
        description: 'test command',
        run_in_background: true,
      }),
      textResponse('Started it in the background.'),
      toolCallResponse('call-2', 'job_output', { job_id: 'bash-1' }),
      textResponse('Background job finished.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('it-bg'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run echo bg-ok in the background' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const firstResult = findEvent(events(agent), 'tool/result')
    expect(firstResult.data.message.isError).toBe(false)
    expect(resultText(firstResult)).toBe('started background job bash-1')
    // The turn closed with the task still running, so the notice cannot exist yet.
    const isNotice = (e: SessionEvent): e is SessionEvent<'user/message'> =>
      e.type === 'user/message' && e.data.source.kind === 'plugin'
    expect(events(agent).some(isNotice)).toBe(false)

    // Releasing the command now settles it against a provably idle owner. No
    // second user message: the wake alone opens the turn that collects it.
    writeFileSync(sentinel, '')
    const lastResultText = (): string => {
      const found = events(agent).findLast(event => event.type === 'tool/result')
      return found === undefined ? '' : resultText(found)
    }
    await pollUntil(() => events(agent).some(isNotice) && lastResultText().includes('bg-ok'))
    // Two turns: the user's, then the one the completion opened by itself.
    expect(events(agent).filter(event => event.type === 'turn/start')).toHaveLength(2)

    // The notice carries the gated command as its label, so this pins the id,
    // the terminal status, and the producer identity; the verbatim notice text
    // and its bounding are pinned in the tool-jobs unit tests.
    const notice = events(agent).find(isNotice)!
    const noticeText = notice.data.content
      .filter(block => block.type === 'text').map(block => block.text).join('')
    expect(noticeText).toContain('background job bash-1 (bash: ')
    expect(noticeText).toContain('finished [status: completed, exit code: 0]')
    expect(notice.data.source).toMatchObject({
      kind: 'plugin',
      plugin: 'tool-jobs',
      form: 'notice',
    })
    const readResult = findEvent(events(agent), 'tool/result', 'last')
    expect(readResult.data.message.isError).toBe(false)
    expect(resultText(readResult)).toContain('bg-ok')
    expect(resultText(readResult)).toContain('[status: completed, exit code: 0]')
  })
})
