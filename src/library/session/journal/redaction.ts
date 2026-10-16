/**
 * Redaction: text an embedder must keep out of every session (a person's secrets) is replaced as each event is
 * appended, so the journal, the model requests derived from it, host events and history never hold it. Embedders
 * register a redactor (`redactJournal`); with none registered nothing is walked or copied.
 * @module io-agent/session/redaction
 */

/** Rewrites text, returning it unchanged when it holds nothing to redact. */
export type Redactor = (text: string) => string

const redactors = new Set<Redactor>()

/**
 * Register a redactor for every session event appended from now on, and for output the host serves directly.
 * @param redact - the rewrite; it must be cheap and must return its input when nothing matches.
 * @returns the disposer that unregisters it.
 */
export function redactJournal(redact: Redactor): () => void {
  redactors.add(redact)
  return () => { redactors.delete(redact) }
}

/** Whether any redactor is registered. */
export const redacting = (): boolean => redactors.size > 0

/** Text with every registered redactor applied. */
export function redactText(text: string): string {
  let out = text
  for (const redact of redactors) out = redact(out)
  return out
}

/**
 * A JSON value with every string redacted: the same value when nothing changed, otherwise a copy of the changed
 * branches. An image's base64 `data` is left alone.
 */
export function redactValue<T>(value: T): T {
  if (redactors.size === 0) return value
  return walk(value) as T
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) {
    let changed: unknown[] | undefined
    for (let index = 0; index < value.length; index++) {
      const next = walk(value[index])
      if (next !== value[index]) (changed ??= [...value])[index] = next
    }
    return changed ?? value
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const image = record.type === 'image'
    let changed: Record<string, unknown> | undefined
    for (const [key, field] of Object.entries(record)) {
      if (image && key === 'data') continue
      const next = walk(field)
      if (next !== field) (changed ??= { ...record })[key] = next
    }
    return changed ?? value
  }
  return value
}
