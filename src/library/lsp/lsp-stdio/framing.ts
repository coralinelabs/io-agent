/**
 * Bounded, linear-work JSON-RPC framing. Each body byte is copied once; a fragmented
 * response never repeatedly concatenates or scans its growing prefix.
 * @module io-agent/lsp-stdio/framing
 */
import { modelText } from '../../context/text/index.ts'

const MAX_HEADER_BYTES = 1 << 16
const TERMINATOR = 0x0d0a0d0a
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

/** A decoder is unusable after any framing failure: do not guess a resynchronization point. */
export class MessageDecoder {
  private header: Buffer = Buffer.allocUnsafe(256)
  private headerBytes = 0
  private suffix = 0
  private body: Buffer | undefined
  private bodyBytes = 0
  private failure: Error | undefined

  constructor(private readonly maxMessageBytes: number) {
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1 || maxMessageBytes > 0x7fffffff) {
      throw new RangeError(modelText('lsp/protocol/invalid-bound'))
    }
  }

  push(chunk: Buffer): unknown[] {
    if (this.failure) throw this.failure
    const messages: unknown[] = []
    try {
      let offset = 0
      while (offset < chunk.length) {
        if (this.body === undefined) {
          offset = this.readHeader(chunk, offset)
          if (this.body === undefined) break
        }
        const take = Math.min(this.body.length - this.bodyBytes, chunk.length - offset)
        chunk.copy(this.body, this.bodyBytes, offset, offset + take)
        this.bodyBytes += take
        offset += take
        if (this.bodyBytes === this.body.length) {
          messages.push(decodeBody(this.body))
          this.body = undefined
          this.bodyBytes = 0
        }
      }
      return messages
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error))
      this.body = undefined
      this.header = Buffer.alloc(0)
      throw this.failure
    }
  }

  private readHeader(chunk: Buffer, start: number): number {
    for (let offset = start; offset < chunk.length; offset++) {
      const byte = chunk[offset]!
      if (byte > 0x7f) throw new Error(modelText('lsp/protocol/non-ascii-header'))
      if (this.headerBytes === this.header.length) {
        const larger = Buffer.allocUnsafe(Math.min(this.header.length * 2, MAX_HEADER_BYTES + 4))
        this.header.copy(larger, 0, 0, this.headerBytes)
        this.header = larger
      }
      this.header[this.headerBytes++] = byte
      this.suffix = ((this.suffix << 8) | byte) >>> 0
      if (this.suffix === TERMINATOR) {
        const headerText = this.header.toString('ascii', 0, this.headerBytes - 4)
        const length = parseContentLength(headerText)
        if (length > this.maxMessageBytes) {
          throw new Error(modelText('lsp/lsp-stdio-framing/text-03', {
            value_1: String(length), value_2: String(this.maxMessageBytes),
          }))
        }
        this.headerBytes = 0
        this.suffix = 0
        this.body = Buffer.allocUnsafe(length)
        return offset + 1
      }
      const pendingDelimiter = (this.suffix & 0xffffff) === 0x0d0a0d ? 3
        : (this.suffix & 0xffff) === 0x0d0a ? 2 : byte === 0x0d ? 1 : 0
      if (this.headerBytes - pendingDelimiter > MAX_HEADER_BYTES) {
        throw new Error(modelText('lsp/lsp-stdio-framing/text-01', { value_1: String(MAX_HEADER_BYTES) }))
      }
    }
    return chunk.length
  }
}

function decodeBody(body: Buffer): unknown {
  let text: string
  try { text = utf8.decode(body) }
  catch { throw new Error(modelText('lsp/protocol/invalid-utf8')) }
  try { return JSON.parse(text) }
  catch (error) {
    throw new Error(modelText('lsp/lsp-stdio-framing/text-04', {
      value_1: error instanceof Error ? error.message : String(error),
    }))
  }
}

/** Exactly one decimal length. Duplicate equal lengths are also ambiguous framing. */
function parseContentLength(headerText: string): number {
  let length: number | undefined
  for (const line of headerText.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon < 0 || line.slice(0, colon).trim().toLowerCase() !== 'content-length') continue
    const raw = line.slice(colon + 1).trim()
    if (length !== undefined || !/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new Error(modelText('lsp/lsp-stdio-framing/text-05', { value_1: JSON.stringify(line) }))
    }
    length = Number(raw)
  }
  if (length === undefined) {
    throw new Error(modelText('lsp/lsp-stdio-framing/text-06', { value_1: JSON.stringify(headerText) }))
  }
  return length
}
