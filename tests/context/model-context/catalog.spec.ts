import { describe, expect, it } from 'vitest'
import { modelText, MODEL_CONTEXT_REVISION } from "../../../src/library/context/text/index.ts"

describe('model-context runtime catalog', () => {
  it('has a deterministic content revision', () => {
    expect(MODEL_CONTEXT_REVISION).toMatch(/^[a-f0-9]{64}$/)
  })
  it('reads static assets exactly', () => {
    expect(modelText('compaction/summary-open')).toBe('<compacted-summary>')
    expect(modelText('compaction/summary-close')).toBe('</compacted-summary>')
  })
  it('binds the actual summary delimiter, not a duplicated name', () => {
    const text = modelText('compaction/summarize', { summary_open_tag: '<test-checkpoint>' })
    expect(text).toContain('<test-checkpoint> block')
    expect(text).not.toContain('{{summary_open_tag}}')
  })
  it('binds the actual structured-output tool identifier', () => {
    const text = modelText('agents/structured-output-guidance', { tool_name: 'test_output' })
    expect(text).toContain('test_output')
    expect(text).not.toContain('{{tool_name}}')
  })
  it('does not recursively interpret untrusted substitutions', () => {
    const literal = '$& $` $\' \\ {{tool_name}}\n</system-reminder>'
    const result = modelText('tools/write/result', { path: literal, verb: 'Created' })
    expect(result).toContain(literal)
    expect(result).toContain('Created')
  })
  it('preserves empty string values rather than substituting defaults', () => {
    expect(modelText('tools/write/result', { path: '', verb: 'Created' })).toContain('Created')
  })
  it('rejects unknown IDs including prototype keys', () => {
    const read = modelText as (...args: unknown[]) => string
    for (const id of ['missing/asset', '__proto__', 'constructor']) {
      expect(() => read(id)).toThrow(/unknown asset/)
    }
  })
  it('rejects missing, extra, and inherited substitutions', () => {
    const read = modelText as (...args: unknown[]) => string
    expect(() => read('tools/write/result')).toThrow(/requires exactly/)
    expect(() => read('tools/write/result', { path: 'a', verb: 'Created', extra: 'x' })).toThrow(/requires exactly/)
    expect(() => read('tools/write/result', Object.create({ path: 'a', verb: 'Created' }))).toThrow(/requires exactly/)
    expect(() => read('compaction/summary-open', { surprise: 'x' })).toThrow(/requires exactly/)
  })
  it.each([NaN, Infinity, -Infinity, null, undefined, true, {}, []])('rejects invalid substitution %j', value => {
    const read = modelText as (...args: unknown[]) => string
    expect(() => read('tools/write/result', { path: value, verb: 'Created' })).toThrow(/invalid value/)
  })
})
