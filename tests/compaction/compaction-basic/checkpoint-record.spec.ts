/** Deterministic checkpoint sections: pure builder over the visible surface. */
import { describe, expect, it } from 'vitest'
import {
  createMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId,
} from "../../../src/library/model/llm/index.ts"
import type { ContentBlock, MessageSource } from "../../../src/library/model/llm/index.ts"
import { Session, SessionId } from "../../../src/library/session/journal/index.ts"
import type { SessionEvent, SessionSeq } from "../../../src/library/session/journal/index.ts"
import { visibleMessages } from "../../../src/library/context/visibility.ts"
import { modelText } from "../../../src/library/context/text/index.ts"
import { renderSkillContent } from "../../../src/library/skills/skill/index.ts"
import {
  buildCheckpointAppendix, condensedSpanStart, cutText, EMPTY_CHECKPOINT_APPENDIX, withLogPointer,
} from "../../../src/library/context/compaction/basic/checkpoint-record.ts"
import type { CheckpointAppendix } from "../../../src/library/context/compaction/basic/checkpoint-record.ts"
import { checkpointRecordProblem, CompactionId, compactCheckpointSource } from "../../../src/library/context/compaction/compaction/index.ts"
import { recordedToolResult } from "../../../src/library/context/compaction/compaction/replace.ts"
import { renderSkillRemovedMarker, renderToolResultStub } from "../../../src/library/context/compaction/tool-result-pruner/index.ts"
import { prunedToolResultFormats, recallCheckpointLog } from "../../../src/plugins/tool-results.ts"
import type { CheckpointRecord, CheckpointTodo } from "../../../src/library/context/compaction/compaction/index.ts"
import type { CheckpointReaders, ResolvedCheckpointConfig } from "../../../src/library/context/compaction/basic/types.ts"
import { injectedSkillName, loadedSkillName } from "../../../src/library/skills/tool-skill/history.ts"
import { writtenTodoList } from "../../../src/library/tasks/tool-todo/list.ts"

const CONFIG: ResolvedCheckpointConfig = {
  userMessageBytes: 16384, firstUserMessageMaxBytes: 8192, userMessageMaxBytes: 4096,
  anchorBytes: 4096, maxSkills: 20, maxTodoItems: 50,
}
/** The owners' readers, as `src/plugins/index.ts` wires them. */
const READERS: CheckpointReaders = { skillLoad: loadedSkillName, skillInjection: injectedSkillName, todoList: writtenTodoList }
const MODEL = { kind: 'model' as const, provider: 'fixture', model: 'fixture' }
let sessions = 0

/** A realistic single-turn log; each helper appends one or two surface nodes. */
class Log {
  readonly session = Session.create(SessionId(`checkpoint-record-${++sessions}`))
  private calls = 0
  private step = 1
  constructor() {
    this.session.append('turn/start', { turn: 1 })
    this.session.append('step/start', { turn: 1, step: 1 })
    this.session.append('system/message', {
      turn: 1, step: 1, message: createSystemMessage('SYSTEM HEAD', '@deepseek-ai/dsh-system-prompt'),
    }, { surfaceOp: 'append' })
  }
  /** Close this step and open the next one in the same turn. */
  nextStep(): void {
    this.session.append('step/end', { turn: 1, step: this.step })
    this.step += 1
    this.session.append('step/start', { turn: 1, step: this.step })
  }
  user(content: string | ContentBlock[], source: MessageSource = { kind: 'user' }): SessionSeq {
    return this.session.append('user/message', createUserMessage({
      content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, source,
    }), { surfaceOp: 'append' }).seq
  }
  assistant(content: string | ContentBlock[]): SessionSeq {
    return this.session.append('assistant/message', {
      turn: 1, step: this.step, stream: [],
      message: createMessage({
        role: 'assistant', source: MODEL,
        content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
      }),
    }, { surfaceOp: 'append' }).seq
  }
  /** One assistant tool call and its paired result; returns the result event. `id` reuses a call id, as some providers do. */
  call(name: string, args: object, result: string, isError = false, id?: string): SessionEvent<'tool/result'> {
    const callId = ToolCallId(id ?? `call-${++this.calls}`)
    this.assistant([{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }])
    this.session.append('tool/call', { turn: 1, step: this.step, callId, name, arguments: JSON.stringify(args) })
    return this.session.append('tool/result', {
      turn: 1, step: this.step,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: result }], isError }),
    }, { surfaceOp: 'append' })
  }
  /** Rewrite one tool result in place, as a pruner does (citing the node it shadows). */
  rewrite(event: SessionEvent<'tool/result'>, text: string): void {
    const [result] = event.data.message.content
    this.session.append('tool/result', {
      ...event.data,
      message: { ...event.data.message, content: [{ type: 'text', text }] },
    }, { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] })
  }
  checkpoint(text: string, record?: CheckpointRecord): SessionSeq {
    return this.user(text, compactCheckpointSource(CompactionId(`prior-${sessions}`), undefined, record))
  }
  /** Condense surface nodes from `first` through `last` (defaults to the end). */
  appendix(first: SessionSeq, last?: SessionSeq, config = CONFIG, fromSurfaceStart = true, readers = READERS): CheckpointAppendix {
    const nodes = this.session.surface.nodes
    const end = last === undefined ? nodes.length - 1 : nodes.indexOf(last)
    const shadowed = new Set(nodes.slice(nodes.indexOf(first), end + 1))
    // Recorded results are read back through the replacement chain, as the engine wires it.
    return buildCheckpointAppendix(visibleMessages(this.session), shadowed, {
      config, readers, fromSurfaceStart, cwd: '/work/repo',
      recordedResult: (event) => {
        const recorded = recordedToolResult(this.session, event)
        return recorded === undefined ? undefined : this.session.deriveEventMessage(recorded) ?? undefined
      },
    })
  }
}

const skillBody = (name: string): string => renderSkillContent({
  name, provider: 'fixture', resourceBase: { kind: 'directory', path: `/skills/${name}` }, content: `Body of ${name}: see skill/body.ts`,
})
const text = (appendix: CheckpointAppendix): string => appendix.blocks.map(block => block.text).join('')

describe('verbatim user messages', () => {
  it('keeps the first message and the newest others within the byte budget, cutting only straddlers', () => {
    const log = new Log()
    const firstText = `FIRST-START ${'λ'.repeat(3000)} FIRST-END`
    const start = log.user(firstText)
    log.assistant('ack 1')
    const others = [2, 3, 4, 5, 6].map((index) => {
      const seq = log.user(`U${index}-START ${'x'.repeat(2900)} U${index}-END`)
      log.assistant(`ack ${index}`)
      return seq
    })
    const last = log.assistant('ready')
    log.user('KEEP-VISIBLE retained prompt')
    const config = { ...CONFIG, userMessageBytes: 12000, firstUserMessageMaxBytes: 4000, userMessageMaxBytes: 3000 }

    const appendix = log.appendix(start, last, config)
    const record = appendix.record!
    expect(record.users.map(user => user.seq)).toEqual([start, others[2], others[3], others[4]].map(Number))
    expect(record.omittedUsers).toBe(2)
    const [first, cut, fifth, sixth] = record.users
    expect(first!.first).toBe(true)
    expect(Buffer.byteLength(first!.text)).toBeLessThanOrEqual(4000)
    // A multibyte cut keeps whole code points on both sides of the marker.
    expect(first!.text).toMatch(/^FIRST-START λ+\n\[\.\.\. \d+ bytes of this message omitted \.\.\.\]\nλ+ FIRST-END$/)
    expect(cut!.text).toMatch(/^U4-START x+\n\[\.\.\. \d+ bytes of this message omitted \.\.\.\]\nx+ U4-END$/)
    expect(fifth!.text).toBe(`U5-START ${'x'.repeat(2900)} U5-END`)
    expect(sixth!.text).toBe(`U6-START ${'x'.repeat(2900)} U6-END`)
    const total = record.users.reduce((sum, user) => sum + Buffer.byteLength(user.text), 0)
    expect(total).toBeLessThanOrEqual(12000)
    // A cut text is already within its cap, so carrying it forward keeps its bytes.
    expect(cutText(cut!.text, Buffer.byteLength(cut!.text))).toBe(cut!.text)

    const rendered = text(appendix)
    expect(rendered.startsWith('\n\n## User Messages (verbatim, newest first)\n')).toBe(true)
    const order = ['U6-START', 'U5-START', 'U4-START', '[2 older user messages omitted]',
      'First user message of the session:\n> FIRST-START'].map(marker => rendered.indexOf(marker))
    expect(order.every(index => index > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(rendered).not.toContain('KEEP-VISIBLE')
    expect(rendered).not.toContain('U3-START')
    expect(log.appendix(start, last, config)).toEqual(appendix)
  })

  it('carries a prior record forward byte-for-byte and never invents a first message after a checkpoint', () => {
    const prior: CheckpointRecord = {
      version: 1,
      users: [{ seq: 3, text: 'ORIGINAL TASK: fix math.ts', first: true }, { seq: 9, text: 'CORRECTION: never edit docs/' }],
      omittedUsers: 4,
      skills: [],
    }
    const log = new Log()
    const start = log.checkpoint('prior summary', prior)
    log.user([{ type: 'text', text: 'NEXT ' }, { type: 'text', text: 'REQUEST' },
      { type: 'image', attachment: { attachmentId: 'sha256:0123456789abcdef', mediaType: 'image/png', width: 1, height: 1, bytes: 1, name: 'shot.png' } } as ContentBlock])
    log.user('steer', { kind: 'goal', goalId: 'g', revision: 1, round: 2 } as unknown as MessageSource)
    const last = log.assistant('done')
    const record = log.appendix(start, last).record!
    expect(record.users).toEqual([
      prior.users[0],
      prior.users[1],
      { seq: record.users[2]!.seq, text: 'NEXT REQUEST[image attachment sha256:01234567]' },
    ])
    expect(record.omittedUsers).toBe(4)

    const legacy = new Log()
    const legacyStart = legacy.checkpoint('summary written before records existed')
    legacy.user('AFTER-LEGACY request')
    const rendered = legacy.appendix(legacyStart)
    expect(rendered.record!.users).toEqual([{ seq: rendered.record!.users[0]!.seq, text: 'AFTER-LEGACY request' }])
    expect(text(rendered)).not.toContain('First user message of the session')
  })

  it('counts every message as omitted, the carried ones included, when the user budget was scaled to nothing', () => {
    const prior: CheckpointRecord = {
      version: 1,
      users: [{ seq: 3, text: 'ORIGINAL TASK: fix math.ts', first: true }, { seq: 9, text: 'CORRECTION: never edit docs/' }],
      omittedUsers: 4,
      skills: [],
    }
    const log = new Log()
    const start = log.checkpoint('prior summary', prior)
    log.user('NEXT REQUEST')
    const last = log.assistant('done')
    const nodes = log.session.surface.nodes
    const scaled = { ...CONFIG, userMessageBytes: 0, firstUserMessageMaxBytes: 0, userMessageMaxBytes: 0 }
    const build = (usersScaledOut: boolean): CheckpointAppendix => buildCheckpointAppendix(visibleMessages(log.session),
      new Set(nodes.slice(nodes.indexOf(start), nodes.indexOf(last) + 1)), { config: scaled, readers: READERS, fromSurfaceStart: true, usersScaledOut })
    const appendix = build(true)
    expect(appendix.record).toMatchObject({ users: [], omittedUsers: 7 })
    expect(text(appendix)).toContain('[7 older user messages omitted]')
    // Turned off rather than scaled down, the section and its count stay out.
    expect(build(false).record?.omittedUsers ?? 0).toBe(0)
  })
})

describe('anchor index', () => {
  it('harvests exact identifiers by category, most frequent first, relative to the workspace', () => {
    const log = new Log()
    const start = log.user('Fix /work/repo/src/app/math.ts and ./lib/util.js; docs at '
      + 'https://user:secret@example.com/docs/page?token=abc#frag; request 123e4567-e89b-12d3-a456-426614174000')
    log.assistant([{ type: 'reasoning', text: 'maybe reasoning/only.ts' }, { type: 'text', text: "Reading src/app/math.ts first: the log shows `TypeError: Cannot read properties of undefined (reading 'total')` and Node.js 22." }])
    log.call('read', { path: '/work/repo/src/app/math.ts' }, [
      "TypeError: Cannot read properties of undefined (reading 'total')",
      '    at sum (src/app/math.ts:12:5)',
      'ENOENT: no such file',
      'HEAD is 9f8e7d6c5b4a; also deadbeef, 1234567 and 0123abc',
      'src/app/math.ts(3,1): error TS2345: Argument of type string',
      ' FAIL  tests/math.spec.ts > sums > adds 12ms',
      'tests/test_calc.py::TestCalc::test_add[1-2] FAILED',
      '--- FAIL: TestSum (0.00s)',
    ].join('\n'))
    log.user('Current runtime context: snapshot/only.ts', {
      kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [{ name: 'policy', text: 'snapshot/only.ts' }],
    })
    log.call('skill', { name: 'demo' }, skillBody('demo'))
    const last = log.assistant('done')

    const rendered = text(log.appendix(start, last, { ...CONFIG, userMessageBytes: 0, maxSkills: 0 }))
    const lines = rendered.split('\n')
    expect(rendered.startsWith('\n\n## Anchor Index\n')).toBe(true)
    expect(lines.find(line => line.startsWith('Files: '))!.startsWith('Files: src/app/math.ts (x5), ')).toBe(true)
    expect(rendered).toContain('lib/util.js')
    const errors = lines.find(line => line.startsWith('Errors: '))!
    // A Markdown code span ends the message, so both mentions count as one anchor.
    expect(errors.startsWith("Errors: TypeError: Cannot read properties of undefined (reading 'total') (x2), ")).toBe(true)
    expect(errors).toContain('ENOENT')
    expect(errors).toContain('error TS2345: Argument of type string')
    const tests = lines.find(line => line.startsWith('Tests: '))!
    expect(tests).toContain('tests/math.spec.ts > sums > adds')
    expect(tests).not.toContain('12ms')
    expect(tests).toContain('tests/test_calc.py::TestCalc::test_add[1-2]')
    expect(tests).toContain('--- FAIL: TestSum')
    expect(lines.find(line => line.startsWith('Commits and hashes: '))).toBe('Commits and hashes: 0123abc, 9f8e7d6c5b4a')
    expect(lines.find(line => line.startsWith('URLs: '))).toBe('URLs: https://example.com/docs/page')
    for (const excluded of ['secret', 'token=abc', '#frag', 'reasoning/only.ts', 'snapshot/only.ts', 'skill/body.ts', '123e4567', 'deadbeef', '/work/repo', 'Node.js', '`']) {
      expect(rendered).not.toContain(excluded)
    }

    const budgeted = text(log.appendix(start, last, { ...CONFIG, userMessageBytes: 0, maxSkills: 0, anchorBytes: 24 }))
    expect(budgeted).toBe(`\n\n${modelText('compaction/checkpoint-anchors', { lines: 'Files: src/app/math.ts (x5)' })}`)
  })


  it('carries the index by value, so iterative compactions keep every value byte for byte', () => {
    const log = new Log()
    const start = log.user('Run the suite.')
    log.call('bash', { command: 'npx vitest run' }, [
      ' FAIL  tests/b.spec.ts > io > reads config 4ms',
      ' FAIL  tests/a.spec.ts > math > sums totals',
      "TypeError: Cannot read properties of undefined (reading 'total')",
    ].join('\n'))
    // Model prose lists values with commas and runs on into sentences.
    const last = log.assistant('Failing: tests/b.spec.ts > io > reads config, tests/a.spec.ts > math > sums totals. '
      + "The second throws TypeError: Cannot read properties of undefined (reading 'total'), and b hits ENOENT.")
    const first = log.appendix(start, last, { ...CONFIG, userMessageBytes: 0 })
    const tests = [
      { value: 'tests/a.spec.ts > math > sums totals', count: 2 },
      { value: 'tests/b.spec.ts > io > reads config', count: 2 },
    ]
    expect(first.record!.anchors).toEqual({
      files: [{ value: 'tests/a.spec.ts', count: 2 }, { value: 'tests/b.spec.ts', count: 2 }],
      errors: [{ value: "TypeError: Cannot read properties of undefined (reading 'total')", count: 2 }, { value: 'ENOENT', count: 1 }],
      tests,
    })

    // The rendered index sits in the checkpoint text, but only the record is read back.
    const second = log.checkpoint(`LLM summary mentions src/never-indexed.ts\n${text(first)}`, first.record)
    log.user('Fix a first.')
    const secondLast = log.assistant('Fixing `tests/a.spec.ts > math > sums totals` now.')
    const again = log.appendix(second, secondLast, { ...CONFIG, userMessageBytes: 0 })
    expect(again.record!.anchors!.tests).toEqual([{ ...tests[0]!, count: 3 }, tests[1]])
    expect(again.record!.anchors!.errors).toEqual(first.record!.anchors!.errors)
    expect(text(again)).not.toContain('never-indexed')

    const third = log.checkpoint(`another summary\n${text(again)}`, again.record)
    const thirdLast = log.assistant('Still working.')
    const settled = log.appendix(third, thirdLast, { ...CONFIG, userMessageBytes: 0 })
    expect(settled.record!.anchors).toEqual(again.record!.anchors)
    const anchorLines = (appendix: CheckpointAppendix) => text(appendix).slice(text(appendix).indexOf('## Anchor Index'))
    expect(anchorLines(settled)).toBe(anchorLines(again))
    expect(anchorLines(settled)).toContain('Tests: tests/a.spec.ts > math > sums totals (x3), tests/b.spec.ts > io > reads config (x2)')
  })

  it('never copies credential-shaped values forward', () => {
    const log = new Log()
    const start = log.user('Check the deploy.')
    log.call('read', { path: '.env' }, [
      'DATADOG_API_KEY=0123456789abcdef0123456789abcdef',
      'GITHUB_TOKEN=abcdef0123456789abcdef0123456789abcdef01',
      'SLACK_WEBHOOK=https://hooks.slack.com/services/T0123ABCD/B0123ABCD/aBcDeFgHiJkLmNoPqRsTuVwX',
      'cached 0123456789abcdef0123456789abcdef',
      'AuthenticationError: invalid key sk-proj-AbCdEfGhIjKlMnOpQrStUv',
      'see https://example.com/guide/setup and https://api.example.com/v1/items/q9ZxY3wV7uT5sR1pN8mK2jL4',
      'bisected to commit 9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e',
    ].join('\n'))
    const last = log.assistant('done')
    const rendered = text(log.appendix(start, last, { ...CONFIG, userMessageBytes: 0 }))
    const lines = rendered.split('\n')
    expect(lines.find(line => line.startsWith('Commits and hashes: '))).toBe('Commits and hashes: 9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e')
    expect(lines.find(line => line.startsWith('URLs: '))).toBe(
      'URLs: https://api.example.com, https://example.com/guide/setup, https://hooks.slack.com')
    for (const secret of ['0123456789abcdef0123456789abcdef', 'abcdef0123456789abcdef0123456789abcdef01', 'T0123ABCD',
      'aBcDeFgH', 'sk-proj', 'q9ZxY3', 'AuthenticationError']) {
      expect(rendered).not.toContain(secret)
    }
  })
})

describe('skills whose instructions left the context', () => {
  it('lists condensed loads not visible afterwards, newest first, with carried names and a cap', () => {
    const log = new Log()
    const start = log.checkpoint('prior', { version: 1, users: [], omittedUsers: 0, skills: ['older-1', 'beta'] })
    log.call('skill', { name: 'alpha' }, skillBody('alpha'))
    log.call('skill', { name: 'beta' }, skillBody('beta'))
    log.call('skill', { name: 'gamma' }, skillBody('gamma'))
    log.user(skillBody('delta'), { kind: 'skill-invocation', name: 'delta', form: 'instructions' })
    log.call('skill', { name: 'eps' }, modelText('skills/unchanged', { name: 'eps' }))
    log.call('skill', { name: 'zeta' }, 'Error: skill failed', true)
    log.call('skill', { name: 'eta' }, modelText('skills/fork-result', { name: 'eta', run_id: 'run-1', result: 'child report' }))
    const theta = log.call('skill', { name: 'theta' }, skillBody('theta'))
    log.rewrite(theta, '[skill output removed by a pruner]')
    const last = log.assistant('continuing')
    log.call('skill', { name: 'beta' }, skillBody('beta'))
    const gammaReload = log.call('skill', { name: 'gamma' }, skillBody('gamma'))
    log.rewrite(gammaReload, `${skillBody('gamma').slice(0, 40)}[... pruned ...]`)

    const appendix = log.appendix(start, last)
    expect(appendix.record!.skills).toEqual(['theta', 'delta', 'gamma', 'alpha', 'older-1'])
    expect(text(appendix)).toContain(`\n\n${modelText('compaction/checkpoint-skills', {
      skills: '`theta`, `delta`, `gamma`, `alpha`, `older-1`',
    })}`)
    expect(log.appendix(start, last, { ...CONFIG, maxSkills: 2 }).record!.skills).toEqual(['theta', 'delta'])
  })

  it('classifies a pruned result by what its call recorded: a stubbed fork report is no load, a marked body is', () => {
    const formats = prunedToolResultFormats()
    const log = new Log()
    const start = log.user('Audit, then deploy.')
    // A fork skill's child report over the pruner's 2,048-character stub size, stubbed like any old result.
    const report = modelText('skills/fork-result', { name: 'audit', run_id: 'run-1', result: `Child report: ${'finding '.repeat(300)}` })
    expect(report.length).toBeGreaterThan(2048)
    const fork = log.call('skill', { name: 'audit' }, report)
    const forkStub = renderToolResultStub({ tool: 'skill', argumentsJson: '{"name":"audit"}', text: report, seq: fork.seq }, formats)
    log.rewrite(fork, forkStub)
    const body = log.call('skill', { name: 'deploy' }, skillBody('deploy'))
    log.rewrite(body, renderSkillRemovedMarker('deploy'))
    // An aged 3 KB test run whose error line only the recorded result still holds.
    const run = `${'ok 1 - passes\n'.repeat(220)}AssertionError: expected 41 to equal 42\n    at tests/math.spec.ts:7:3\n`
    const failing = log.call('bash', { command: 'npm test' }, run)
    log.rewrite(failing, renderToolResultStub({ tool: 'bash', argumentsJson: '{"command":"npm test"}', text: run, seq: failing.seq }, formats))
    const last = log.assistant('continuing')

    const appendix = log.appendix(start, last)
    expect(appendix.record!.skills).toEqual(['deploy'])
    expect(appendix.record!.anchors!.errors).toEqual([{ value: 'AssertionError: expected 41 to equal 42', count: 1 }])
    expect(text(appendix)).toContain('tests/math.spec.ts')
    // The loader's reader judges the recorded text, never the stub standing in for it.
    const call = { name: 'skill', arguments: '{"name":"audit"}' }
    expect(loadedSkillName({ call, text: forkStub, rewritten: true, recordedText: report })).toBeUndefined()
    expect(loadedSkillName({ call, text: forkStub, rewritten: true })).toBeUndefined()
    expect(loadedSkillName({ call: { name: 'skill', arguments: '{"name":"deploy"}' }, text: renderSkillRemovedMarker('deploy'),
      rewritten: true, recordedText: skillBody('deploy') })).toBe('deploy')
  })
})

describe('results matched to the call their own step issued', () => {
  it('reads the loaded skill and the plan when a provider reuses one call id across steps', () => {
    const plan: CheckpointTodo[] = [{ content: 'Ship the deploy', status: 'pending' }]
    const log = new Log()
    const start = log.user('Deploy it.')
    log.call('skill', { name: 'deploy' }, skillBody('deploy'), false, 'call_1')
    log.nextStep()
    log.call('todo_write', { todos: plan }, 'Todos updated.', false, 'call_1')
    log.nextStep()
    log.call('bash', { command: 'ls' }, 'src/app/math.ts', false, 'call_1')
    const last = log.assistant('Listed the files.')
    log.nextStep()
    // A later visible call under the same id is neither the loader nor the plan.
    log.call('bash', { command: 'pwd' }, '/work/repo', false, 'call_1')

    const appendix = log.appendix(start, last)
    expect(appendix.record!.skills).toEqual(['deploy'])
    expect(appendix.record!.todos).toEqual(plan)
    expect(text(appendix)).toContain(modelText('compaction/checkpoint-skills', { skills: '`deploy`' }))
    expect(text(appendix)).toContain(modelText('compaction/checkpoint-todos', { completed: 0, todos: '- [pending] Ship the deploy' }))
    // The loaded instructions are not task evidence; the listing is.
    expect(appendix.record!.anchors!.files).toEqual([{ value: 'src/app/math.ts', count: 1 }])
  })
})

describe('todo list re-shown after compaction', () => {
  const list: CheckpointTodo[] = [
    { content: 'Reproduce the failure', status: 'completed' },
    { content: 'Fix src/app/math.ts', status: 'in_progress' },
    { content: 'Run the math tests', status: 'pending' },
  ]

  it('shows open items from the latest successful todo_write and carries the full list', () => {
    const log = new Log()
    const start = log.user('Track the work.')
    log.call('todo_write', { todos: list }, 'Todos updated.')
    log.call('todo_write', { todos: [{ content: 'REJECTED LIST', status: 'pending' }] }, 'Error: invalid', true)
    const last = log.assistant('working')
    const appendix = log.appendix(start, last)
    expect(appendix.record!.todos).toEqual(list)
    expect(text(appendix)).toContain(`\n\n${modelText('compaction/checkpoint-todos', {
      completed: 1, todos: '- [in_progress] Fix src/app/math.ts\n- [pending] Run the math tests',
    })}`)
    expect(text(appendix)).not.toContain('REJECTED LIST')

    // A newer successful list still visible after the checkpoint makes the section redundant.
    log.call('todo_write', { todos: list.slice(1) }, 'Todos updated.')
    const suppressed = log.appendix(start, last)
    expect(suppressed.record!.todos).toEqual(list)
    expect(text(suppressed)).not.toContain('## Active Todo List')
  })

  it('drops the list once a user message follows the write; goal rounds keep it', () => {
    const plan = [
      { content: 'Refactor module A', status: 'in_progress' },
      { content: 'Delete legacy A files', status: 'pending' },
    ]
    const redirected = new Log()
    const start = redirected.user('Refactor module A.')
    redirected.call('todo_write', { todos: plan }, 'Todos updated.')
    redirected.user('Stop. Do not touch module A at all; instead only write docs for B.')
    redirected.assistant('Understood.')
    redirected.user('ok go')
    const last = redirected.assistant('Writing docs for B.')
    const appendix = redirected.appendix(start, last)
    expect(appendix.record!.todos).toBeUndefined()
    expect(text(appendix)).not.toContain('## Active Todo List')
    expect(text(appendix)).not.toContain('Delete legacy A files')

    // A user message still visible after the span ends the list as well.
    const retained = new Log()
    const retainedStart = retained.user('Refactor module A.')
    retained.call('todo_write', { todos: plan }, 'Todos updated.')
    const retainedLast = retained.assistant('Working on it.')
    retained.user('Stop.')
    expect(retained.appendix(retainedStart, retainedLast).record!.todos).toBeUndefined()

    // So does a later user message after a list a prior checkpoint carried.
    const carried = new Log()
    const carriedStart = carried.checkpoint('prior', { version: 1, users: [], omittedUsers: 0, skills: [], todos: list })
    carried.user('Different task now.')
    const carriedLast = carried.assistant('ok')
    expect(carried.appendix(carriedStart, carriedLast).record!.todos).toBeUndefined()

    // A goal round continues the same work, so its list stays current.
    const goal = new Log()
    const goalStart = goal.user('Reach the goal.')
    goal.call('todo_write', { todos: list }, 'Todos updated.')
    goal.user('Continue toward the goal.', { kind: 'goal', goalId: 'g', revision: 1, round: 2 } as unknown as MessageSource)
    const goalLast = goal.assistant('continuing')
    expect(goal.appendix(goalStart, goalLast).record!.todos).toEqual(list)
  })

  it('carries a prior list when the span wrote none, and shows nothing once every item is complete', () => {
    const log = new Log()
    const start = log.checkpoint('prior', { version: 1, users: [], omittedUsers: 0, skills: [], todos: list })
    const last = log.assistant('more work')
    expect(text(log.appendix(start, last))).toContain('- [pending] Run the math tests')

    const done = new Log()
    const first = done.user('Finish.')
    done.call('todo_write', { todos: list.map(item => ({ ...item, status: 'completed' })) }, 'Todos updated.')
    expect(text(done.appendix(first))).not.toContain('## Active Todo List')
  })
})

it('recognizes skill loads and todo lists only through the owners\' readers', () => {
  const log = new Log()
  const start = log.user('Plan it.')
  log.call('todo_write', { todos: [{ content: 'Fix it', status: 'pending' }] }, 'Todos updated.')
  log.call('skill', { name: 'alpha' }, skillBody('alpha'))
  // Attributed to the loader only when the body renders the requested skill.
  log.call('skill', { name: 'beta' }, skillBody('alpha'))
  const last = log.assistant('ok')
  expect(log.appendix(start, last).record!.skills).toEqual(['alpha'])
  const bare = log.appendix(start, last, CONFIG, true, {})
  expect(bare.record!.skills).toEqual([])
  expect(bare.record!.todos).toBeUndefined()
  expect(text(bare)).not.toContain('## Active Todo List')
})

it('builds nothing when every budget is 0, the library default', () => {
  const log = new Log()
  const start = log.user('Fix src/app/math.ts')
  log.call('todo_write', { todos: [{ content: 'Fix it', status: 'pending' }] }, 'Todos updated.')
  const zero = { userMessageBytes: 0, firstUserMessageMaxBytes: 0, userMessageMaxBytes: 0, anchorBytes: 0, maxSkills: 0, maxTodoItems: 0 }
  expect(log.appendix(start, undefined, zero)).toBe(EMPTY_CHECKPOINT_APPENDIX)
})

it('puts the log pointer after every section, never in the record, and adds nothing for an absent pointer', () => {
  const log = new Log()
  const start = log.user('Fix src/app/math.ts')
  log.call('read', { path: 'src/app/math.ts' }, "TypeError: Cannot read properties of undefined (reading 'total')")
  const last = log.assistant('ok')
  const appendix = log.appendix(start, last)
  const pointer = recallCheckpointLog({ from: 3, to: 9 })
  const pointed = withLogPointer(appendix, pointer)
  expect(pointed.record).toBe(appendix.record)
  expect(pointed.blocks.slice(0, -1)).toEqual(appendix.blocks)
  expect(pointed.blocks.at(-1)).toEqual({ type: 'text', text: `\n\n${pointer}` })
  const rendered = text(pointed)
  expect(rendered.indexOf('## Anchor Index')).toBeGreaterThan(0)
  expect(rendered.indexOf('## Anchor Index')).toBeLessThan(rendered.indexOf('## Session Log'))
  expect(pointer).toBe('## Session Log\nThe condensed messages and tool results remain in this session\'s log: '
    + 'recall from=3 to=9 lists them; recall seq=<number> returns one in full.')
  expect(withLogPointer(appendix, undefined)).toBe(appendix)
  expect(withLogPointer(EMPTY_CHECKPOINT_APPENDIX, pointer).blocks).toEqual([{ type: 'text', text: `\n\n${pointer}` }])
})

it('carries the earliest original event behind a span across checkpoints', () => {
  const log = new Log()
  const start = log.user('Fix src/app/math.ts')
  log.call('read', { path: 'src/app/math.ts' }, 'export const sum = 1')
  const last = log.assistant('ok')
  const first = log.appendix(start, last)
  expect(first.record!.condensedFrom).toBe(Number(start))

  // A later span that condenses the first checkpoint reaches back to that checkpoint's start.
  const prior = log.checkpoint(`summary\n${text(first)}`, first.record)
  expect(Number(prior)).toBeGreaterThan(Number(start))
  log.user('Now the tests.')
  const secondLast = log.assistant('running')
  const nodes = log.session.surface.nodes
  const span = new Set(nodes.slice(nodes.indexOf(prior), nodes.indexOf(secondLast) + 1))
  expect(condensedSpanStart(visibleMessages(log.session), span)).toBe(Number(start))
  const second = log.appendix(prior, secondLast)
  expect(second.record!.condensedFrom).toBe(Number(start))

  // A checkpoint written without the member stands for the earliest event it cites.
  const legacy = new Log()
  const legacyStart = legacy.user('Fix it')
  const legacyLast = legacy.assistant('ok')
  const cited = legacy.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'old checkpoint' }], source: compactCheckpointSource(CompactionId('legacy'), undefined, {
      version: 1, users: [], omittedUsers: 0, skills: [],
    }),
  }), { surfaceOp: 'append', sourceEventSeqs: [legacyStart, legacyLast] }).seq
  const after = legacy.assistant('continuing')
  expect(condensedSpanStart(visibleMessages(legacy.session), new Set([cited, after]))).toBe(Number(legacyStart))
  expect(condensedSpanStart(visibleMessages(legacy.session), new Set())).toBeUndefined()

  expect(checkpointRecordProblem({ ...first.record, condensedFrom: -1 })).toBe('condensedFrom must be a non-negative safe integer')
  expect(checkpointRecordProblem(first.record)).toBeUndefined()
})
