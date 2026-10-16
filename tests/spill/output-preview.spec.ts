import { describe, expect, it } from 'vitest'
import { boundedOutputPreview, unavailableOutputPreview } from '../../src/library/output/preview.ts'
import { TextRetainer } from '../../src/library/util/output-retention/index.ts'

const gap = '\n[... output omitted ...]\n'

describe('shared output preview', () => {
  it('exposes the actual UTF-16 splice offset after Unicode boundary trimming', () => {
    const retainer = new TextRetainer({ kind: 'headTail', headBytes: 6, tailBytes: 6 })
    retainer.push('😀a€'.repeat(10) + '€b😀')
    const result = retainer.finish()
    expect(result.text).toBe('😀ab😀')
    expect(result.gapOffset).toBe(3)
    expect(result.omittedBytes).toEqual({ kind: 'exact', count: 78 })
  })

  it('does not mark an artificial split in a fully retained Unicode stream', () => {
    const retainer = new TextRetainer({ kind: 'headTail', headBytes: 1, tailBytes: 3 })
    retainer.push('😀')
    expect(retainer.finish()).toEqual({ text: '😀', truncated: false, omittedBytes: { kind: 'none' } })
  })

  it('does not invent a middle gap when only one span survives', () => {
    const retainer = new TextRetainer({ kind: 'headTail', headBytes: 1, tailBytes: 2 })
    retainer.push('😀----ok')
    expect(retainer.finish()).toEqual({ text: 'ok', truncated: true, omittedBytes: { kind: 'exact', count: 8 } })
  })

  it('accounts for source bytes separately from gap prose at every small byte budget', () => {
    for (const body of ['ABC'.repeat(1000), '😀€あ'.repeat(1000), '😀'.repeat(1000)]) {
      for (let cap = 0; cap <= 256; cap++) {
        const result = boundedOutputPreview(body, cap)
        expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(cap)
        expect(result.text.isWellFormed()).toBe(true)
        const spans = result.text.split(gap)
        expect(spans.length).toBeLessThanOrEqual(2)
        expect(body.startsWith(spans[0]!)).toBe(true)
        if (spans.length === 2) expect(body.endsWith(spans[1]!)).toBe(true)
        expect(result.omittedBytes).toEqual({ kind: 'exact', count: Buffer.byteLength(body) - Buffer.byteLength(spans.join('')) })
      }
    }
  })

  it('leaves complete small results byte-for-byte unchanged', () => {
    for (const body of ['', 'abc', '😀€あ', 'a\n\nb']) {
      expect(boundedOutputPreview(body, Buffer.byteLength(body))).toEqual({ text: body, omittedBytes: { kind: 'none' } })
    }
  })

  it('marks storage-failure previews without claiming a full artifact or changing the byte cap', () => {
    const result = unavailableOutputPreview('HEAD'.repeat(500) + 'TAIL'.repeat(500), 400)!
    expect(result).toContain(gap)
    expect(result).toContain('The full output could not be retained.')
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(400)
    expect(result).not.toContain('saved to')
  })

  it('rejects invalid budgets rather than silently violating a cap', () => {
    for (const cap of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => boundedOutputPreview('text', cap)).toThrow('invalid preview budget')
    }
  })
})
