/** Snapshot a bounded, non-secret routing annotation for an OpenAI-compatible request. */
export function snapshotRequestMetadata(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('requestMetadata must be a string map')
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length > 16) throw new TypeError('requestMetadata takes at most 16 entries')
  const entries: [string, string][] = []
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key)!
    if (typeof key !== 'string' || !key.length || key.length > 64 || !property.enumerable
      || !('value' in property) || typeof property.value !== 'string' || property.value.length > 512) {
      throw new TypeError('requestMetadata needs own string keys of 1-64 characters and string values of at most 512 characters')
    }
    entries.push([key, property.value])
  }
  return Object.freeze(Object.fromEntries(entries))
}

/** Preserve transport-owned metadata while letting the connection's explicit annotations win. */
export function applyRequestMetadata(payload: unknown, metadata: Readonly<Record<string, string>>): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('request metadata requires an object payload')
  }
  const body = payload as Record<string, unknown>
  const previous = body['metadata']
  if (previous !== undefined && (previous === null || typeof previous !== 'object' || Array.isArray(previous))) {
    throw new TypeError('request metadata requires an object metadata field')
  }
  return { ...body, metadata: { ...previous as Record<string, unknown> | undefined, ...metadata } }
}
