/**
 * Tool calls as the model writes them: the arguments streamed so far, read as far as they go, so a client can show a
 * file edit taking shape before the call runs. Live only and best effort; the call's own events stay authoritative.
 */
import type { StreamChunk } from '../model/llm/index.ts'

type Delta = Extract<StreamChunk, { type: 'tool-call-delta' }>

/** Least stream time between two previews of one call. */
export const PREVIEW_INTERVAL_MS = 100

/**
 * The value a truncated JSON text holds so far: an open string is closed where it stops, open containers are closed,
 * and a key still waiting for its value is dropped. Undefined when nothing readable is there yet.
 * @param text - a prefix of a JSON document.
 * @returns the parsed prefix, or undefined.
 */
export function partialJson(text: string): unknown {
  const complete = (prefix: string): string => {
    const closers: string[] = []
    let inString = false, escaped = false
    for (const char of prefix) {
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
      } else if (char === '"') inString = true
      else if (char === '{') closers.push('}')
      else if (char === '[') closers.push(']')
      else if (char === '}' || char === ']') closers.pop()
    }
    // an escape cut in half is dropped; the rest of the string stands as written so far
    const body = inString ? prefix.replace(escaped ? /\\$/ : /\\u[0-9a-fA-F]{0,3}$/, '') + '"' : prefix
    return body + closers.reverse().join('')
  }
  const attempt = (prefix: string): unknown => { try { return JSON.parse(complete(prefix)) } catch { return undefined } }
  const whole = attempt(text)
  if (whole !== undefined) return whole
  // a key without its value yet, or a literal cut short: read up to the last member before it
  let inString = false, escaped = false, cut = -1
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === ',') cut = i
  }
  return cut < 0 ? undefined : attempt(text.slice(0, cut))
}

/** Arguments of the tool calls one model response is streaming, by block, with when each was last previewed. */
export class ToolPreviews {
  private readonly calls = new Map<string, { id: string; name: string; args: string; at: number; shown: string }>()

  /** A new response attempt: nothing streamed before it is still being written. */
  reset(): void { this.calls.clear() }

  /**
   * Take one arguments delta.
   * @param attempt - the response attempt it belongs to.
   * @param chunk - the delta.
   * @param time - its stream time, which paces previews.
   * @returns the call and its arguments read so far, when a new preview is due; otherwise undefined.
   */
  push(attempt: string, chunk: Delta, time: number): { id: string; name: string; args: Record<string, unknown> } | undefined {
    const key = `${attempt}:${chunk.index}`
    const call = this.calls.get(key) ?? { id: '', name: '', args: '', at: Number.NEGATIVE_INFINITY, shown: '' }
    this.calls.set(key, call)
    if (chunk.id) call.id = chunk.id
    if (chunk.name) call.name = chunk.name
    call.args += chunk.argumentsDelta
    if (!call.id || !call.name || time - call.at < PREVIEW_INTERVAL_MS) return undefined
    const args = partialJson(call.args)
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
    const shown = JSON.stringify(args)
    if (shown === call.shown) return undefined
    call.at = time
    call.shown = shown
    return { id: call.id, name: call.name, args: args as Record<string, unknown> }
  }
}
