/**
 * One-line stubs sized on the
 * recorded result, and skill bodies that are protected while recently
 * requested and otherwise replaced by the canonical skill-removed marker.
 * Results are matched to the call their own step issued, so call ids reused
 * across steps never cross-attribute a stub or marker.
 */

import { describe, expect, it } from 'vitest'
import { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import { createMessage, createToolResultMessage, ToolCallId } from "../../../src/library/model/llm/index.ts"
import type { ContentBlock } from "../../../src/library/model/llm/index.ts"
import { Session, SessionId } from "../../../src/library/session/journal/index.ts"
import type { SessionSeq } from "../../../src/library/session/journal/index.ts"
import Projections from "../../../src/library/session/projection/index.ts"
import TokenMeter from "../../../src/library/model/token-meter/index.ts"
import Pruner, {
  describeCallArguments,
  PRUNE_MARKER,
  removedSkillNames,
  renderSkillRemovedMarker,
  renderToolResultStub,
  resolveConfig,
} from "../../../src/library/context/compaction/tool-result-pruner/index.ts"
import type { PruneRetentionPolicy } from "../../../src/library/context/compaction/tool-result-pruner/index.ts"
import { appendToolResultReplacement } from "../../../src/library/context/compaction/compaction/replace.ts"
import { renderSkillContent, skillContentName } from "../../../src/library/skills/skill/index.ts"
import { formatSpillNotice } from "../../../src/library/output/policy/notice.ts"
import { SpillLocator } from "../../../src/library/output/spill/index.ts"
import { prunedToolResultFormats, recallLogPointer, toolResultPrunerConfig } from "../../../src/plugins/tool-results.ts"

const FORMATS = prunedToolResultFormats()

function pruner(retention: PruneRetentionPolicy, sizes = { thresholdChars: 200, headChars: 40, tailChars: 20 }): Pruner {
  const ctx = new Context(); new Projections(ctx); new TokenMeter(ctx)
  return new Pruner(ctx, { ...sizes, retention, formats: FORMATS })
}

/** io-agent's exact pruner configuration, as the default runtime mounts it. */
function ioAgentPruner(): Pruner {
  const ctx = new Context(); new Projections(ctx); new TokenMeter(ctx)
  return new Pruner(ctx, toolResultPrunerConfig())
}

/** `id` overrides the call id, for providers that reuse ids across steps. */
interface Call { name: string; args: Record<string, unknown>; text: string; isError?: boolean; id?: string }

/** Append one closed turn with one step issuing `calls`, each result citing its call; returns the result seqs. */
function group(session: Session, calls: Call[]): SessionSeq[] {
  const turn = session.snapshotEvents().filter(event => event.type === 'turn/start').length + 1
  session.append('turn/start', { turn }); session.append('step/start', { turn, step: 1 })
  const blocks = calls.map((call, index) => ({ type: 'tool-call' as const, id: ToolCallId(call.id ?? `t${turn}c${index}`), name: call.name, arguments: JSON.stringify(call.args) }))
  session.append('assistant/message', { turn, step: 1, stream: [], message: createMessage({ role: 'assistant', content: blocks,
    source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
  const seqs = calls.map((call, index) => {
    const block = blocks[index]!
    const callSeq = session.append('tool/call', { turn, step: 1, callId: block.id, name: block.name, arguments: block.arguments }).seq
    const content: ContentBlock[] = [{ type: 'text', text: call.text }]
    return session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId: block.id, content, isError: call.isError === true }) },
      { surfaceOp: 'append', sourceEventSeqs: [callSeq] }).seq
  })
  session.append('step/end', { turn, step: 1 }); session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return seqs
}

function bash(index: number, size = 3_000): Call {
  return { name: 'bash', args: { command: `yes ${index} | head -c ${size}` }, text: `${index}\n`.repeat(size / 2) }
}

/** Current visible texts of every result for one call id, in context order. */
function resultTexts(session: Session, callId: string): string[] {
  return session.deriveMessages().flatMap(message => message.role === 'tool' && message.toolCallId === callId
    ? [message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')] : [])
}

/** Current visible text of the only result for one call id. */
function resultText(session: Session, callId: string): string {
  const texts = resultTexts(session, callId)
  if (texts.length !== 1) throw new Error(`expected one visible result for ${callId}, found ${texts.length}`)
  return texts[0]!
}

const BANDS: PruneRetentionPolicy = { keepRecentToolGroups: 2, stubAfterToolGroups: 5, stubMinChars: 1_000, minimumSavingsChars: 0 }

describe('stub band beyond the head/tail band', () => {
  it('keeps the newest groups verbatim, head/tails the middle band and stubs older groups', () => {
    const session = Session.create(SessionId('bands'))
    const seqs = Array.from({ length: 12 }, (_, index) => group(session, [bash(index + 1)])[0]!)
    const result = pruner(BANDS).pruneSession(session)
    const kinds = new Map(result.pruned.map(entry => [entry.originalSeq, entry.kind]))
    // Twelve groups: ranks 11..0. Ranks 0-1 verbatim, 2-4 head/tail, 5+ stub.
    expect(seqs.map(seq => kinds.get(seq))).toEqual([
      'stub', 'stub', 'stub', 'stub', 'stub', 'stub', 'stub', 'head-tail', 'head-tail', 'head-tail', undefined, undefined,
    ])
    expect(resultText(session, 't1c0')).toBe(renderToolResultStub({ tool: 'bash', argumentsJson: JSON.stringify(bash(1).args), text: bash(1).text, seq: seqs[0]! }, FORMATS))
    expect(resultText(session, 't1c0')).toContain('Call: command="yes 1 | head -c 3000".')
    expect(resultText(session, 't1c0')).toContain(`session log as event ${seqs[0]}.`)
    expect(resultText(session, 't9c0')).toContain(PRUNE_MARKER)
    expect(resultText(session, 't12c0')).toBe(bash(12).text)
  })

  it('head/tails an old result no longer than stubMinChars and keeps errors verbatim', () => {
    const session = Session.create(SessionId('min-chars'))
    const small = group(session, [{ name: 'bash', args: { command: 'ls' }, text: 'f\n'.repeat(400) }])[0]!
    const failed = group(session, [{ ...bash(2), isError: true }])[0]!
    for (let index = 0; index < 6; index += 1) group(session, [bash(index + 3)])
    const result = pruner({ ...BANDS, preserveErrors: true }).pruneSession(session)
    expect(result.pruned.find(entry => entry.originalSeq === small)?.kind).toBe('head-tail')
    expect(result.pruned.some(entry => entry.originalSeq === failed)).toBe(false)
  })

  it('points a stub at the original event once a head/tail excerpt ages into the stub band', () => {
    const session = Session.create(SessionId('pointer-chain'))
    // Excerpts of ~1,240 code points (like io-agent's 4,096 + 1,024) are longer than a stub.
    const sizes = { thresholdChars: 2_000, headChars: 800, tailChars: 400 }
    const seqs = Array.from({ length: 5 }, (_, index) => group(session, [bash(index + 1)])[0]!)
    const first = pruner(BANDS, sizes).pruneSession(session)
    expect(first.pruned.map(entry => entry.kind)).toEqual(['head-tail', 'head-tail', 'head-tail'])
    for (let index = 0; index < 3; index += 1) group(session, [bash(index + 10)])
    const second = pruner(BANDS, sizes).pruneSession(session)
    const restubbed = second.pruned.find(entry => entry.originalSeq === first.pruned[0]!.replacementSeq)
    expect(restubbed?.kind).toBe('stub')
    expect(resultText(session, 't1c0')).toContain(`session log as event ${seqs[0]}.`)
    expect(resultText(session, 't1c0')).not.toContain(PRUNE_MARKER)
    // The size is the recorded result's (1,500 lines, 3,000 characters), not the ~1,240-character excerpt's.
    expect(resultText(session, 't1c0')).toBe(renderToolResultStub({ tool: 'bash', argumentsJson: JSON.stringify(bash(1).args), text: bash(1).text, seq: seqs[0]! }, FORMATS))
    expect(resultText(session, 't1c0')).toContain('The result had 1500 lines (3000 characters).')
  })

  it('sizes a stub on the full result recorded before a step-budget spill and keeps the spill notice as its pointer', () => {
    const session = Session.create(SessionId('spill-chain'))
    const full = 'x'.repeat(99) + '\n'
    const [seq] = group(session, [{ name: 'bash', args: { command: 'make' }, text: full.repeat(400) + '[exit code: 2]' }])
    const notice = formatSpillNotice({ kind: 'exact', count: 36_000 }, { locator: SpillLocator('/state/spill/make.txt'), retrievalHint: 'Use read with offset and limit.' })
    const event = session.snapshotEvents()[seq!]!
    if (event.type !== 'tool/result') throw new Error('expected the recorded result')
    const preview = createToolResultMessage({ callId: event.data.message.source.callId, content: [{ type: 'text', text: `${full.repeat(40)}\n\n${notice}` }], isError: false })
    appendToolResultReplacement(session, event, event.data.message, preview.content, 1)
    for (let index = 0; index < 6; index += 1) group(session, [bash(index + 2)])
    pruner(BANDS).pruneSession(session)
    const stub = resultText(session, 't1c0')
    expect(stub).toContain('The result had 401 lines (40014 characters) and ended with [exit code: 2]. ')
    expect(stub.endsWith(`${notice}]`)).toBe(true)
    expect(stub).not.toContain('session log')
  })

  it('reuses a spill notice verbatim as the stub pointer', () => {
    const notice = formatSpillNotice({ kind: 'exact', count: 90_000 }, { locator: SpillLocator('/state/spill/bash.txt'), retrievalHint: 'Use read with offset and limit.' })
    const spilled = 'head line\n'.repeat(150) + '\n[exit code: 1]\n\n' + notice
    const session = Session.create(SessionId('spill-pointer'))
    group(session, [{ name: 'bash', args: { command: 'npm test' }, text: spilled }])
    for (let index = 0; index < 6; index += 1) group(session, [bash(index + 2)])
    pruner(BANDS).pruneSession(session)
    const stub = resultText(session, 't1c0')
    expect(stub).toContain(notice)
    // The recorded result was already only a preview: the stub says so instead of calling it the whole result.
    expect(stub).toContain("Call: command=\"npm test\". The result's inline preview had 152 lines (1515 characters) and ended with [exit code: 1]. (")
    expect(stub).not.toContain('session log')
  })

  it('names the recorded result through the composition\'s log pointer, which a spill notice still outranks', () => {
    const notice = formatSpillNotice({ kind: 'exact', count: 90_000 }, { locator: SpillLocator('/state/spill/bash.txt'), retrievalHint: 'Use read with offset and limit.' })
    const session = Session.create(SessionId('recall-pointer'))
    const plain = group(session, [bash(1)])[0]!
    group(session, [{ name: 'bash', args: { command: 'npm test' }, text: 'head line\n'.repeat(150) + '\n' + notice }])
    for (let index = 0; index < 6; index += 1) group(session, [bash(index + 3)])
    const asked: [SessionSeq, string][] = []
    const ctx = new Context(); new Projections(ctx); new TokenMeter(ctx)
    new Pruner(ctx, { thresholdChars: 200, headChars: 40, tailChars: 20, retention: BANDS,
      formats: prunedToolResultFormats((seq, owner) => { asked.push([seq, owner.id]); return recallLogPointer(seq) }) }).pruneSession(session)
    expect(resultText(session, 't1c0')).toMatch(new RegExp(`\\. The full result is kept in the session log; recall seq=${plain} returns it\\.\\]$`))
    expect(resultText(session, 't1c0')).not.toContain('as event')
    expect(resultText(session, 't2c0')).toContain(notice)
    expect(resultText(session, 't2c0')).not.toContain('recall seq=')
    expect(asked).toContainEqual([plain, 'recall-pointer'])
    // `undefined` keeps the generic pointer.
    const other = Session.create(SessionId('no-recall'))
    const first = group(other, [bash(1)])[0]!
    for (let index = 0; index < 6; index += 1) group(other, [bash(index + 2)])
    const ctx2 = new Context(); new Projections(ctx2); new TokenMeter(ctx2)
    new Pruner(ctx2, { thresholdChars: 200, headChars: 40, tailChars: 20, retention: BANDS,
      formats: prunedToolResultFormats(() => undefined) }).pruneSession(other)
    expect(resultText(other, 't1c0')).toContain(`session log as event ${first}.`)
  })

  it('is replay-identical and a second pass over the same surface is a no-op', () => {
    const session = Session.create(SessionId('replay-stubs'))
    for (let index = 0; index < 9; index += 1) group(session, [bash(index + 1)])
    expect(pruner(BANDS).pruneSession(session).pruned.length).toBeGreaterThan(0)
    const restored = Session.create(SessionId('replay-stubs-copy'), session.snapshotEvents())
    expect(restored.deriveMessages()).toEqual(session.deriveMessages())
    expect(pruner(BANDS).pruneSession(restored)).toEqual({ pruned: [], charsRemoved: 0 })
  })
})

describe('stub rendering', () => {
  it('renders tool, key argument with up to two short scalars, size, exit marker and log pointer', () => {
    const text = 'alpha\nbeta\n[exit code: 2]'
    expect(renderToolResultStub({ tool: 'bash', argumentsJson: JSON.stringify({ command: 'make test', timeout: 60, description: 'Run tests', extra: true }),
      text, seq: 41 as SessionSeq }, FORMATS)).toBe('[Pruned older bash result to save context. Call: command="make test", timeout=60, description="Run tests". '
      + 'The result had 3 lines (25 characters) and ended with [exit code: 2]. The full result is kept in the session log as event 41.]')
    expect(renderToolResultStub({ tool: 'bash', argumentsJson: '{"command":"sleep 99"}', text: 'partial\n[killed by signal: SIGKILL]', seq: 7 as SessionSeq }, FORMATS))
      .toContain(' and ended with [killed by signal: SIGKILL].')
    expect(renderToolResultStub({ tool: 'grep', argumentsJson: '{"pattern":"x"}', text: 'a\nb\n', seq: 3 as SessionSeq }, FORMATS))
      .toContain('The result had 2 lines (4 characters). The full')
    // Only the tools whose format renders exit markers are read for one.
    expect(renderToolResultStub({ tool: 'read', argumentsJson: '{"file_path":"log.txt"}', text: 'a\n[exit code: 2]', seq: 5 as SessionSeq }, FORMATS))
      .toContain('The result had 2 lines (16 characters). The full')
  })

  it('describes arguments as bounded one-line data and falls back to raw JSON', () => {
    expect(describeCallArguments('{"file_path":"src/a.ts","offset":10,"limit":200}')).toBe('file_path="src/a.ts", offset=10, limit=200')
    const long = describeCallArguments(JSON.stringify({ command: 'echo ' + 'x'.repeat(300) + '\nsecond line' }))
    expect(Array.from(long).length).toBeLessThanOrEqual(160)
    expect(long).toMatch(/^command="echo x+…"$/)
    expect(describeCallArguments(JSON.stringify({ command: 'a\nb' }))).toBe('command="a b"')
    expect(describeCallArguments('{"alpha":1,"beta":[1,2]}')).toBe('{"alpha":1,"beta":[1,2]}')
    expect(describeCallArguments('not json')).toBe('not json')
    expect(describeCallArguments('')).toBe('{}')
  })
})

describe('skill bodies', () => {
  const SKILL_RETENTION: PruneRetentionPolicy = { ...BANDS, skillToolName: 'skill', keepRecentSkillToolGroups: 5 }
  const body = renderSkillContent({ name: 'demo', provider: 'filesystem', content: 'DEMO_SKILL_BODY\n' + 'step\n'.repeat(600) })

  it('replaces an old, unreferenced skill body with the canonical marker instead of an excerpt or stub', () => {
    const session = Session.create(SessionId('skill-marker'))
    const skill = group(session, [{ name: 'skill', args: { name: 'demo' }, text: body }])[0]!
    for (let index = 0; index < 6; index += 1) group(session, [bash(index + 1)])
    const result = pruner(SKILL_RETENTION).pruneSession(session)
    expect(result.pruned.find(entry => entry.originalSeq === skill)?.kind).toBe('skill')
    expect(resultText(session, 't1c0')).toBe(renderSkillRemovedMarker('demo'))
    expect(removedSkillNames(resultText(session, 't1c0'))).toEqual(['demo'])
  })

  it('keeps a skill body verbatim while that skill was requested recently, even in the head/tail band', () => {
    const referenced = Session.create(SessionId('skill-referenced'))
    group(referenced, [{ name: 'skill', args: { name: 'demo' }, text: body }])
    for (let index = 0; index < 6; index += 1) group(referenced, [bash(index + 1)])
    // A later "unchanged" reload keeps the original body in use.
    group(referenced, [{ name: 'skill', args: { name: 'demo' }, text: 'Skill "demo" is unchanged.' }])
    pruner(SKILL_RETENTION).pruneSession(referenced)
    expect(resultText(referenced, 't1c0')).toBe(body)

    const banded = Session.create(SessionId('skill-band'))
    group(banded, [{ name: 'skill', args: { name: 'demo' }, text: body }])
    for (let index = 0; index < 3; index += 1) group(banded, [bash(index + 1)])
    pruner(SKILL_RETENTION).pruneSession(banded)
    expect(resultText(banded, 't1c0')).toBe(body)
  })

  it('treats skill results like any other result when no skill tool is configured', () => {
    const session = Session.create(SessionId('skill-unconfigured'))
    group(session, [{ name: 'skill', args: { name: 'demo' }, text: body }])
    for (let index = 0; index < 6; index += 1) group(session, [bash(index + 1)])
    pruner(BANDS).pruneSession(session)
    expect(resultText(session, 't1c0')).toContain('[Pruned older skill result')
  })

  it('round-trips skill names through the rendered body and the marker', () => {
    expect(skillContentName(body)).toBe('demo')
    expect(skillContentName(renderSkillContent({ name: 'a"b<c&d', provider: 'p', content: 'x' }))).toBe('a"b<c&d')
    for (const text of ['Skill "demo" is unchanged.', 'plain', '<skill_content name="">', '<skill_content name="open']) {
      expect(skillContentName(text)).toBeUndefined()
    }
    const text = `before ${renderSkillRemovedMarker('alpha')} middle ${renderSkillRemovedMarker('beta-2')} ${renderSkillRemovedMarker('alpha')}`
    expect(removedSkillNames(text)).toEqual(['alpha', 'beta-2'])
    const forged = renderSkillRemovedMarker('alpha').replace('name "alpha"', 'name "beta"')
    expect(removedSkillNames(forged)).toEqual([])
  })
})

describe('retention validation', () => {
  it.each([
    [{ keepRecentToolGroups: 5, stubAfterToolGroups: 4 }, /stubAfterToolGroups/],
    [{ stubMinChars: -1 }, /stubMinChars/],
    [{ keepRecentSkillToolGroups: 1.5 }, /keepRecentSkillToolGroups/],
    [{ skillToolName: '' }, /skillToolName/],
    [{ skillToolName: 'skill' }, /formats\.skillBodyName/],
  ] as const)('rejects %j', (retention, pattern) => {
    expect(() => resolveConfig({ retention: retention as PruneRetentionPolicy })).toThrow(pattern)
  })
  it('rejects formats that are not functions', () => {
    expect(() => resolveConfig({ formats: { skillBodyName: 'skill' as never } })).toThrow(/formats\.skillBodyName/)
    expect(() => resolveConfig({ formats: { outcomeMarkers: { bash: true as never } } })).toThrow(/outcomeMarkers/)
    expect(() => resolveConfig({ formats: { other: () => undefined } as never })).toThrow(/unknown formats key/)
    expect(() => resolveConfig({ formats: { logPointer: 'recall' as never } })).toThrow(/formats\.logPointer/)
  })
  it('accepts the io-agent policy: 5 groups verbatim, stubs from the 6th, skills marked after 10', () => {
    // Through the plugin's config schema, exactly as the default runtime mounts it.
    const config = resolveConfig(Pruner.Config(toolResultPrunerConfig()))
    expect(config.retention).toMatchObject({ keepRecentToolGroups: 5, stubAfterToolGroups: 5, skillToolName: 'skill', keepRecentSkillToolGroups: 10 })
    expect(config.formats).toEqual(FORMATS)
  })
})

describe('results a recent pointer stands for', () => {
  it('keeps a pointed-at result verbatim while its pointer is in the newest groups, then prunes it like any old result', () => {
    const pointers = new Map<SessionSeq, SessionSeq>()
    const ctx = new Context(); new Projections(ctx); new TokenMeter(ctx)
    const config = toolResultPrunerConfig()
    const pruner = new Pruner(ctx, { ...config, formats: { ...config.formats, pointedResults: () => pointers } })
    const session = Session.create(SessionId('pointed'))
    const full = 'line of the file\n'.repeat(300)
    const original = group(session, [{ name: 'read', args: { file_path: 'big.ts' }, text: full }])[0]!
    for (let index = 1; index <= 5; index += 1) group(session, [bash(index)])
    const notice = group(session, [{ name: 'read', args: { file_path: 'big.ts' }, text: 'Unchanged: big.ts lines 1-300 of 300.' }])[0]!
    pointers.set(notice, original)

    pruner.pruneSession(session)
    // Six groups old, but the newest group points at it.
    expect(resultText(session, 't1c0')).toBe(full)
    expect(resultText(session, 't2c0')).toContain('[Pruned older bash result to save context. Call: command="yes 1 | head -c 3000".')

    // Once the pointer is itself five groups old, the original is an ordinary old result.
    for (let index = 6; index <= 10; index += 1) group(session, [bash(index)])
    pruner.pruneSession(session)
    expect(resultText(session, 't1c0')).toContain('[Pruned older read result to save context. Call: file_path="big.ts".')
  })
})

describe('call ids reused across steps (io-agent policy)', () => {
  const reused = (call: Omit<Call, 'id'>): Call => ({ ...call, id: 'call_1' })

  it('stubs each result with the call its own step issued', () => {
    const session = Session.create(SessionId('reused-ids'))
    group(session, [reused({ name: 'bash', args: { command: 'npm test' }, text: 'ok\n'.repeat(1_000) + '[exit code: 1]' })])
    for (let index = 2; index <= 10; index += 1) group(session, [reused({ name: 'read', args: { file_path: `f${index}.ts` }, text: `${index}\n`.repeat(1_500) })])
    ioAgentPruner().pruneSession(session)
    const texts = resultTexts(session, 'call_1')
    expect(texts).toHaveLength(10)
    expect(texts[0]).toMatch(/^\[Pruned older bash result to save context\. Call: command="npm test"\. The result had 1001 lines \(3014 characters\) and ended with \[exit code: 1\]\./)
    for (let index = 2; index <= 5; index += 1) expect(texts[index - 1]).toContain(`[Pruned older read result to save context. Call: file_path="f${index}.ts". `)
    // The newest five tool groups stay verbatim.
    for (let index = 6; index <= 10; index += 1) expect(texts[index - 1]).toBe(`${index}\n`.repeat(1_500))
  })

  it('marks a skill body whose id a later bash call reused, and names each skill that shared an id', () => {
    const session = Session.create(SessionId('reused-skill-ids'))
    const body = (name: string): string => renderSkillContent({ name, provider: 'filesystem', content: `${name.toUpperCase()}_BODY\n` + 'step\n'.repeat(600) })
    group(session, [reused({ name: 'skill', args: { name: 'alpha' }, text: body('alpha') })])
    group(session, [reused({ name: 'skill', args: { name: 'beta' }, text: body('beta') })])
    for (let index = 1; index <= 10; index += 1) group(session, [reused({ name: 'bash', args: { command: `echo ${index}` }, text: `${index}\n`.repeat(1_500) })])
    // A recent "unchanged" reload of beta keeps beta's body in use; alpha was last requested 12 groups ago.
    group(session, [reused({ name: 'skill', args: { name: 'beta' }, text: 'Skill "beta" is unchanged.' })])
    const result = ioAgentPruner().pruneSession(session)
    const texts = resultTexts(session, 'call_1')
    expect(texts[0]).toBe(renderSkillRemovedMarker('alpha'))
    expect(texts[1]).toBe(body('beta'))
    expect(texts[2]).toContain('[Pruned older bash result to save context. Call: command="echo 1". ')
    expect(result.pruned.filter(entry => entry.kind === 'skill')).toHaveLength(1)
  })
})
