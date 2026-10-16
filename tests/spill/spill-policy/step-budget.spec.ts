/**
 * Window-scaled spill budgets, a small preview
 * separate from the spill threshold, a configurable exemption list, and the
 * per-step aggregate budget that spills the largest results of one committed
 * batch first through durable shadow-priced replacements.
 */

import { describe, expect, it } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { createToolResultMessage, ToolCallId } from "../../../src/library/model/llm/index.ts"
import type { ContentBlock } from "../../../src/library/model/llm/index.ts"
import { Session, SessionId } from "../../../src/library/session/journal/index.ts"
import type { SessionEvent } from "../../../src/library/session/journal/index.ts"
import SystemPrompt from "../../../src/library/context/assembly/index.ts"
import ToolRuntime, { defineContentToolFixture, TOOL_RUNTIME_SCHEDULER } from "../../../src/library/tools/index.ts"
import type { ToolBatchResult, ToolExecution } from "../../../src/library/tools/index.ts"
import type { Agent } from "../../../src/library/runtime/agents/index.ts"
import { SpillLocator, SpillStore } from "../../../src/library/output/spill/index.ts"
import type { SaveTextSpill, SpillRef } from "../../../src/library/output/spill/index.ts"
import * as SpillPolicy from "../../../src/library/output/policy/index.ts"
import { formatSpillNotice, hasSpillNotice } from "../../../src/library/output/policy/notice.ts"

class StubStore extends SpillStore {
  saves: SaveTextSpill[] = []
  fail = false
  gate: (() => void) | undefined

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    if (this.fail) throw new Error('disk full')
    this.gate?.()
    this.saves.push(input)
    return { locator: SpillLocator(`/spill/${input.suggestedName}`), bytes: Buffer.byteLength(input.content), retrievalHint: 'Use the stub retrieval path.' }
  }
}

async function setup(config: SpillPolicy.Config, beforePolicy?: (ctx: Context) => void): Promise<{ ctx: Context; spill: StubStore }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(StubStore)
  beforePolicy?.(ctx)
  await ctx.plugin(SpillPolicy, config)
  return { ctx, spill: ctx.spillStore as StubStore }
}

function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** A session with one open turn/step whose committed results the batch announces. */
function openStep(id: string): { session: Session; add: (name: string, text: string, isError?: boolean) => ToolBatchResult } {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  let calls = 0
  return {
    session,
    add(name, text, isError = false) {
      const callId = ToolCallId(`call-${++calls}`)
      const call = session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
      const event = session.append('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError }) },
      { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      return { event: event as SessionEvent<'tool/result'>, name }
    },
  }
}

function commit(ctx: Context, session: Session, results: ToolBatchResult[], signal = new AbortController().signal): Promise<void> {
  return ctx.tools[TOOL_RUNTIME_SCHEDULER].committed({ agent: { session } as Agent, turn: 1, step: 1, results, signal })
}

/** Current visible text of each committed result, in model order. */
function visibleTexts(session: Session): string[] {
  return session.deriveMessages().filter(message => message.role === 'tool').map(message => textOf(message.content))
}

describe('window-scaled budgets', () => {
  it('scales per-result and per-step budgets with the window, with floors and caps', () => {
    expect(SpillPolicy.toolOutputBudget(8_192)).toEqual({ maxInlineBytes: 8_000, previewBytes: 4_000, stepBudgetBytes: 16_000 })
    expect(SpillPolicy.toolOutputBudget(32_768)).toEqual({ maxInlineBytes: 19_660, previewBytes: 4_000, stepBudgetBytes: 39_321 })
    expect(SpillPolicy.toolOutputBudget(65_536)).toEqual({ maxInlineBytes: 39_321, previewBytes: 4_000, stepBudgetBytes: 78_643 })
    expect(SpillPolicy.toolOutputBudget(131_072)).toEqual({ maxInlineBytes: 50_000, previewBytes: 4_000, stepBudgetBytes: 100_000 })
    expect(SpillPolicy.toolOutputBudget(1_048_576)).toEqual({ maxInlineBytes: 50_000, previewBytes: 4_000, stepBudgetBytes: 100_000 })
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => SpillPolicy.toolOutputBudget(bad)).toThrow(/contextWindow/)
  })
})

describe('preview size and exemptions', () => {
  it('keeps a small head/tail preview for a spilled result while the threshold stays the cap', async () => {
    const { ctx, spill } = await setup({ maxInlineBytes: 5_000, previewBytes: 200 })
    const text = 'HEAD-' + 'x'.repeat(9_000) + '-TAIL'
    ctx.tools.register(defineContentToolFixture({ name: 'bash', description: 'bash', parameters: {},
      async execute() { return [{ type: 'text', text }] } }))
    const result = await ctx.tools.execute({ callId: ToolCallId('c1'), name: 'bash', arguments: {},
      agent: { session: { header: { id: SessionId('s1') } } }, signal: new AbortController().signal } as unknown as ToolExecution)
    const replaced = textOf(result.content)
    expect(spill.saves).toHaveLength(1)
    expect(spill.saves[0]?.content).toBe(text)
    expect(replaced.startsWith('HEAD-')).toBe(true)
    expect(replaced).toContain('-TAIL\n\n(')
    expect(hasSpillNotice(replaced)).toBe(true)
    // 200 preview bytes plus the separator and the notice, far below the 5,000-byte cap.
    expect(Buffer.byteLength(replaced)).toBeLessThan(400)
  })

  it('never lets a configured preview push the replacement past maxInlineBytes', async () => {
    const { ctx } = await setup({ maxInlineBytes: 300, previewBytes: 10_000 })
    ctx.tools.register(defineContentToolFixture({ name: 'bash', description: 'bash', parameters: {},
      async execute() { return [{ type: 'text', text: 'z'.repeat(5_000) }] } }))
    const result = await ctx.tools.execute({ callId: ToolCallId('c1'), name: 'bash', arguments: {},
      agent: { session: { header: { id: SessionId('s1') } } }, signal: new AbortController().signal } as unknown as ToolExecution)
    expect(hasSpillNotice(textOf(result.content))).toBe(true)
    expect(Buffer.byteLength(textOf(result.content))).toBeLessThanOrEqual(300)
  })

  it('exempts the configured tools instead of only read, and keeps read exempt by default', async () => {
    const run = async (config: SpillPolicy.Config, name: string): Promise<string> => {
      const { ctx } = await setup(config)
      ctx.tools.register(defineContentToolFixture({ name, description: name, parameters: {},
        async execute() { return [{ type: 'text', text: 'q'.repeat(2_000) }] } }))
      const result = await ctx.tools.execute({ callId: ToolCallId('c1'), name, arguments: {},
        agent: { session: { header: { id: SessionId('s1') } } }, signal: new AbortController().signal } as unknown as ToolExecution)
      return textOf(result.content)
    }
    expect(await run({ maxInlineBytes: 500 }, 'read')).toBe('q'.repeat(2_000))
    expect(await run({ maxInlineBytes: 500, exemptTools: ['read', 'skill'] }, 'skill')).toBe('q'.repeat(2_000))
    expect(hasSpillNotice(await run({ maxInlineBytes: 500, exemptTools: ['skill'] }, 'read'))).toBe(true)
  })

  it.each([
    [{ maxInlineBytes: 100, previewBytes: -1 }, /previewBytes/],
    [{ maxInlineBytes: 100, previewBytes: 1.5 }, /previewBytes/],
    [{ maxInlineBytes: 100, stepBudgetBytes: 99 }, /stepBudgetBytes/],
    [{ maxInlineBytes: 100, exemptTools: [''] }, /exemptTools/],
  ] as const)('rejects invalid config %j at load', async (config, pattern) => {
    await expect(setup(config as SpillPolicy.Config)).rejects.toThrow(pattern)
  })
})

describe('per-step aggregate budget', () => {
  const config = { maxInlineBytes: 1_000, previewBytes: 100, stepBudgetBytes: 2_000, boundOnSaveFailure: true }

  it('spills the largest result first and stops once the step fits, with shadow-priced replacements', async () => {
    const { ctx, spill } = await setup(config)
    const { session, add } = openStep('largest-first')
    const results = [add('bash', 'a'.repeat(600)), add('bash', 'b'.repeat(900)), add('grep', 'c'.repeat(800))]
    const originals = session.snapshotEvents()
    await commit(ctx, session, results)

    expect(spill.saves.map(save => save.content)).toEqual(['b'.repeat(900)])
    const texts = visibleTexts(session)
    expect(texts[0]).toBe('a'.repeat(600))
    expect(hasSpillNotice(texts[1]!)).toBe(true)
    const gap = '\n[... output omitted ...]\n'
    const remaining = config.previewBytes - Buffer.byteLength(gap)
    expect(texts[1]!.startsWith('b'.repeat(Math.ceil(remaining / 2))
      + gap + 'b'.repeat(Math.floor(remaining / 2)))).toBe(true)
    expect(texts[2]).toBe('c'.repeat(800))
    const events = session.snapshotEvents()
    // The full original results stay in the journal; the replacement is appended after them.
    expect(events.slice(0, originals.length)).toEqual(originals)
    expect(events.slice(originals.length).map(event => event.type)).toEqual(['compaction/prune', 'tool/result'])
    expect(events.at(-2)).toMatchObject({ data: { shadowedSeqs: [results[1]!.event.seq] } })
    expect(events.at(-1)).toMatchObject({ surfaceOp: { op: 'replace', startSeq: results[1]!.event.seq }, sourceEventSeqs: [results[1]!.event.seq] })
    // Replay derives the same model context.
    expect(Session.create(SessionId('largest-first-copy'), events).deriveMessages()).toEqual(session.deriveMessages())
  })

  it('counts exempt, failed and already-spilled results but never replaces them', async () => {
    const { ctx, spill } = await setup(config)
    const { session, add } = openStep('eligibility')
    const spilled = 'y'.repeat(300) + '\n\n' + formatSpillNotice({ kind: 'exact', count: 5_000 }, {
      locator: SpillLocator('/spill/earlier.txt'), retrievalHint: 'Read it.' })
    const results = [add('read', 'r'.repeat(900)), add('bash', 'e'.repeat(900), true), add('bash', spilled), add('bash', 'k'.repeat(700))]
    await commit(ctx, session, results)
    expect(spill.saves.map(save => save.content)).toEqual(['k'.repeat(700)])
    const texts = visibleTexts(session)
    expect(texts.slice(0, 3)).toEqual(['r'.repeat(900), 'e'.repeat(900), spilled])
    expect(hasSpillNotice(texts[3]!)).toBe(true)
  })

  it('does nothing while the step is within budget or when the arm is not configured', async () => {
    const within = await setup(config)
    const first = openStep('within')
    await commit(within.ctx, first.session, [first.add('bash', 'a'.repeat(900)), first.add('bash', 'b'.repeat(900))])
    expect(within.spill.saves).toHaveLength(0)

    const off = await setup({ maxInlineBytes: 1_000, previewBytes: 100 })
    const second = openStep('off')
    const before = second.session.snapshotEvents().length
    await commit(off.ctx, second.session, [second.add('bash', 'a'.repeat(900)), second.add('bash', 'b'.repeat(900)), second.add('bash', 'c'.repeat(900))])
    expect(off.spill.saves).toHaveLength(0)
    expect(second.session.snapshotEvents()).toHaveLength(before + 6)
  })

  it('skips a result whose save fails instead of replacing it without a file', async () => {
    const { ctx, spill } = await setup(config)
    spill.fail = true
    const { session, add } = openStep('save-failure')
    const results = [add('bash', 'a'.repeat(900)), add('bash', 'b'.repeat(900)), add('bash', 'c'.repeat(900))]
    const before = session.snapshotEvents()
    await commit(ctx, session, results)
    expect(session.snapshotEvents()).toEqual(before)
  })

  it('stops rewriting once the step is cancelled, including during a save', async () => {
    const { ctx, spill } = await setup(config)
    const early = openStep('aborted-before')
    const cancelled = new AbortController()
    cancelled.abort()
    const earlyResults = [early.add('bash', 'a'.repeat(900)), early.add('bash', 'b'.repeat(900)), early.add('bash', 'c'.repeat(900))]
    const earlyBefore = early.session.snapshotEvents()
    await commit(ctx, early.session, earlyResults, cancelled.signal)
    expect(early.session.snapshotEvents()).toEqual(earlyBefore)

    const during = openStep('aborted-during')
    const controller = new AbortController()
    spill.gate = () => { controller.abort() }
    const results = [during.add('bash', 'a'.repeat(900)), during.add('bash', 'b'.repeat(900)), during.add('bash', 'c'.repeat(900))]
    const before = during.session.snapshotEvents()
    await commit(ctx, during.session, results, controller.signal)
    expect(spill.saves).toHaveLength(1)
    expect(during.session.snapshotEvents()).toEqual(before)
  })

  it('contains a failing batch listener so later listeners still run and the step stays committed', async () => {
    const { ctx, spill } = await setup(config, (context) => {
      context.on('tools/batch-committed', () => { throw new Error('listener exploded') })
    })
    const { session, add } = openStep('contained')
    await expect(commit(ctx, session, [add('bash', 'a'.repeat(900)), add('bash', 'b'.repeat(900)), add('bash', 'c'.repeat(500))]))
      .resolves.toBeUndefined()
    expect(spill.saves).toHaveLength(1)
  })
})
