import { describe, expect, it } from 'vitest'
import { changeMemory, memoryBudget, memoryWritable } from "../../../src/library/context/memory.ts"
import { parseVerification } from "../../../src/library/context/verification.ts"
import { snapshotRequest } from "../../../src/library/model/inspection.ts"
import { isPayloadLimit, reduceSummaryPayload } from "../../../src/library/context/compaction/policy.ts"
import { createUserMessage, createAssistantMessage, createToolResultMessage, LlmError, ToolCallId } from "../../../src/library/model/llm/index.ts"
import type { Message } from "../../../src/library/model/llm/index.ts"

const empty = { revision: 0, entries: {} }
describe('curated memory pure contract', () => {
  it('does not mutate prior snapshots and uses compare-and-swap', () => {
    const next = changeMemory(empty, 'put', 'build', ' pnpm test ', 0, 512, 5)
    expect(next).toEqual({ revision: 1, entries: { build: 'pnpm test' } })
    expect(empty).toEqual({ revision: 0, entries: {} })
    expect(() => changeMemory(next, 'put', 'build', 'wrong', 0, 512, 5)).toThrow(/revision|conflict/i)
    expect(changeMemory(next, 'delete', 'build', undefined, 1, 512, 5)).toEqual({ revision: 2, entries: {} })
  })
  it.each([undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects unsafe revision %s', (revision) => {
    expect(() => changeMemory(empty, 'put', 'k', 'value', revision, 512, 5)).toThrow()
  })
  it.each(['../escape', '__proto__', '', 'with space', 'a'.repeat(81)])('rejects invalid key %s', (key) => {
    expect(() => changeMemory(empty, 'put', key, 'v', 0, 512, 5)).toThrow()
  })
  it('counts UTF-8 serialized bytes and logical lines, including escapes', () => {
    const state = { revision: 0, entries: { k: '日本語\n"\\' } }
    expect(memoryBudget(state)).toEqual({ bytes: Buffer.byteLength(JSON.stringify(state.entries)), lines: 2 })
    expect(() => changeMemory(empty, 'put', 'k', '日'.repeat(200), 0, 512, 5)).toThrow(/limit|budget/i)
    expect(() => changeMemory(empty, 'put', 'k', 'a\nb\nc', 0, 512, 2)).toThrow(/limit|budget/i)
  })
  it('handles property names without prototype mutation', () => {
    const next = changeMemory(empty, 'put', 'constructor', 'data', 0, 512, 5)
    expect(Object.hasOwn(next.entries, 'constructor')).toBe(true)
    expect(Object.getPrototypeOf(next.entries)).toBe(Object.prototype)
  })
  it('advertises writes only where one can be granted', () => {
    expect(memoryWritable('allow', 'never')).toBe(true)
    expect(memoryWritable('allow', 'ask')).toBe(true)
    expect(memoryWritable('ask', 'ask')).toBe(true)
    expect(memoryWritable('ask', 'never')).toBe(false)
    expect(memoryWritable('deny', 'ask')).toBe(false)
    expect(memoryWritable('deny', 'never')).toBe(false)
  })
  it('rejects empty writes, absent deletes, and unknown actions', () => {
    expect(() => changeMemory(empty, 'put', 'k', '  ', 0, 512, 5)).toThrow()
    expect(() => changeMemory(empty, 'delete', 'k', undefined, 0, 512, 5)).toThrow()
    expect(() => changeMemory(empty, 'surprise', 'k', undefined, 0, 512, 5)).toThrow()
  })
})

describe('verdicts are evidence, not unconditional success', () => {
  it.each(['passed', 'needs-work', 'unknown'])('accepts valid %s result and freezes it', (status) => {
    const value = parseVerification(JSON.stringify({ status, summary: 'Evidence reviewed.', findings: [] }), 73)
    expect(value.status).toBe(status); expect(value.throughSeq).toBe(73)
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.findings)).toBe(true)
  })
  it.each(['', 'done', 'null', '[]', '{}', '{"status":"passed","summary":"OK","findings":["tests failed"]}',
    '{"status":"passed","summary":"","findings":[]}', '{"status":"passed","summary":"OK","findings":[],"extra":true}',
    '```json\n{"status":"passed","summary":"OK","findings":[]}\n```'])('rejects malformed or contradictory verdict %s', (text) => {
    expect(() => parseVerification(text, 0)).toThrow()
  })
  it.each([
    ['null', null], ['number', 1], ['boolean', true], ['object', {}],
    ['object with enum text', { status: 'passed' }],
    ['passed array', ['passed']], ['needs-work array', ['needs-work']], ['unknown array', ['unknown']],
    ['nested passed array', [['passed']]], ['nested needs-work array', [['needs-work']]], ['empty array', []],
    ['whitespace', ' passed '], ['case variation', 'Passed'], ['unrecognized string', 'done'],
  ])('rejects a non-enum-string status: %s', (_name, status) => {
    expect(() => parseVerification(JSON.stringify({ status, summary: 'Done', findings: [] }), 73)).toThrow()
  })
  it.each([
    ['array', ['passed']], ['nested array', [['passed']]],
  ])('rejects %s status with unresolved findings', (_name, status) => {
    expect(() => parseVerification(JSON.stringify({ status, summary: 'Done', findings: ['Unresolved failure'] }), 73)).toThrow()
  })
})

describe('request observation snapshots', () => {
  it('hashes context, keeps identity, strips transport secrets, and freezes only its copy', () => {
    const message = createUserMessage({ content: [{ type: 'text', text: 'input' }], source: { kind: 'user' } })
    const messages: Message[] = [message]
    const a = snapshotRequest({ provider: 'private-route', model: 'alias', messages, maxTokens: 100 })
    const b = snapshotRequest({ provider: 'different-private-route', model: 'alias', messages, maxTokens: 100 })
    expect(a.contextSha256).toBe(b.contextSha256); expect(a.id).not.toBe(b.id)
    expect(a.messages[0]!.id).toBe(message.id); expect(a.messages).not.toBe(messages)
    expect(Object.isFrozen(a.messages[0]!.content)).toBe(true)
    expect(a).not.toHaveProperty('provider'); expect(Object.isFrozen(messages)).toBe(false)
  })
})

const assistant = (id: string): Message => createAssistantMessage({ content: [{ type: 'tool-call', id: ToolCallId(id), name: 'read', arguments: '{}' }], source: { provider: 'p', model: 'm' } })
const result = (id: string, text: string, isError = false): Message => createToolResultMessage({
  callId: ToolCallId(id), content: [{ type: 'text', text }], isError,
})
describe('summary-only payload recovery', () => {
  it('recognizes explicit provider payload failures, including chained errors', () => {
    expect(isPayloadLimit(new LlmError('payload', 'HTTP', { status: 413 }))).toBe(true)
    expect(isPayloadLimit(new Error('outer', { cause: new LlmError('request entity too large', 'API_ERROR') }))).toBe(true)
    expect(isPayloadLimit(new LlmError('bad credentials', 'AUTH', { status: 401 }))).toBe(false)
    expect(isPayloadLimit(new Error('request entity too large'))).toBe(false)
    expect(isPayloadLimit(new LlmError('maximum context length', 'CONTEXT_WINDOW_EXCEEDED'))).toBe(false)
  })
  it('preserves message ids, tool pairing, user restrictions, recent results and failures without mutating history', () => {
    const messages = [createUserMessage({ content: [{ type: 'text', text: 'Do not deploy.' }], source: { kind: 'user' } }),
      assistant('old'), result('old', 'old'.repeat(10000)), assistant('err'), result('err', 'FAIL'.repeat(10000), true),
      assistant('recent'), result('recent', 'RECENT'.repeat(5000))]
    const original = JSON.stringify(messages)
    const reduced = reduceSummaryPayload(messages, 1024)!
    expect(reduced).not.toBeNull(); expect(JSON.stringify(messages)).toBe(original)
    expect(reduced.map(m => m.id)).toEqual(messages.map(m => m.id))
    expect(reduced[0]).toBe(messages[0]); expect(reduced[1]).toBe(messages[1])
    expect(reduced[4]).toEqual(messages[4]); expect(reduced[6]).toEqual(messages[6])
    expect(JSON.stringify(reduced[2]).length).toBeLessThan(JSON.stringify(messages[2]).length)
    expect(JSON.stringify(reduced[2])).toContain('shortened')
  })
  it('does not retry when no useful reduction is possible', () => {
    expect(reduceSummaryPayload([assistant('one'), result('one', 'x'.repeat(20000))], 1024)).toBeNull()
    expect(reduceSummaryPayload([assistant('old'), result('old', 'small'), assistant('new'), result('new', 'small')], 1024)).toBeNull()
  })
})
