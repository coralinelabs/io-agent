import { describe, expect, it, vi } from 'vitest'
import { MessageDecoder, encodeMessage } from '../../../src/library/lsp/lsp-stdio/index.ts'

describe('framing without repeated copying or ambiguous lengths', () => {
  it('decodes every header/body split, including multi-byte UTF-8 splits', () => {
    const value = { jsonrpc: '2.0', method: 'note', params: { text: 'é🌍\r\n\r\n' } }
    const bytes = encodeMessage(value)
    for (let i = 0; i <= bytes.length; i++) {
      const decoder = new MessageDecoder(1024)
      expect([...decoder.push(bytes.subarray(0, i)), ...decoder.push(bytes.subarray(i))]).toEqual([value])
    }
  })

  it('does not concatenate an increasing prefix when a body arrives one byte at a time', () => {
    const value = { text: 'a'.repeat(16_384) }
    const bytes = encodeMessage(value)
    const decoder = new MessageDecoder(32_768)
    const concatenate = vi.spyOn(Buffer, 'concat')
    let copiedBytes = 0
    // Measure supplied buffer sizes, not wall-clock performance.
    const results: unknown[] = []
    try {
      for (let i = 0; i < bytes.length; i++) results.push(...decoder.push(bytes.subarray(i, i + 1)))
      copiedBytes = concatenate.mock.calls.reduce((sum, [buffers]) =>
        sum + buffers.reduce((length, buffer) => length + buffer.length, 0), 0)
    } finally { concatenate.mockRestore() }
    expect(results).toEqual([value])
    expect(copiedBytes).toBeLessThanOrEqual(bytes.length * 3)
  })

  it.each(['0x2', '2e0', '+2', '2.0', '', '-1', '9007199254740992'])(
    'rejects non-protocol Content-Length %j', (length) => {
      expect(() => new MessageDecoder(1024).push(Buffer.from(`Content-Length: ${length}\r\n\r\n{}`)))
        .toThrow(/Content-Length/)
    })

  it.each(['Content-Length: 2', 'content-length: 2', 'Content-Length: 3'])(
    'rejects repeated length headers even when equal: %s', (second) => {
      expect(() => new MessageDecoder(1024).push(Buffer.from(`Content-Length: 2\r\n${second}\r\n\r\n{}`)))
        .toThrow(/Content-Length/)
    })

  it('rejects invalid UTF-8 instead of silently replacing server text', () => {
    const body = Buffer.from([0x22, 0xff, 0x22])
    const wire = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
    expect(() => new MessageDecoder(1024).push(wire)).toThrow(/UTF-8/)
  })

  it('fails closed after a malformed frame instead of attempting to resynchronize', () => {
    const decoder = new MessageDecoder(1024)
    const wire = Buffer.from('Content-Length: nope\r\n\r\n{}')
    let failure: unknown
    try { decoder.push(wire) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    try { decoder.push(encodeMessage({ result: 'should not dispatch' })); throw new Error('accepted after framing failure') }
    catch (error) { expect(error).toBe(failure) }
  })

  it('retains independent output from complete frames before a later fragmented frame', () => {
    const decoder = new MessageDecoder(1024)
    const next = encodeMessage({ id: 2, result: 'second' })
    expect(decoder.push(Buffer.concat([encodeMessage({ id: 1 }), next.subarray(0, 3)]))).toEqual([{ id: 1 }])
    expect(decoder.push(next.subarray(3))).toEqual([{ id: 2, result: 'second' }])
  })

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER])('rejects invalid decoder bound %j', bound => {
    expect(() => new MessageDecoder(bound)).toThrow()
  })
})
