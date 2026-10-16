/** Pure validation of declared content shapes. Extension blocks stay opaque. */

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}
function keys(row: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new TypeError(`${label} has missing or unexpected fields`)
  }
}
function text(value: unknown, label: string, nonempty = false): void {
  if (typeof value !== 'string' || nonempty && value.length === 0) throw new TypeError(`${label} must be ${nonempty ? 'a nonempty' : 'a'} string`)
}
function count(value: unknown, label: string, minimum = 0): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${label} must be an integer >= ${minimum}`)
}

/** Validate owned fields only; an unknown block's nested JSON is never mistaken for core content. */
export function assertContentBlock(value: unknown, label = 'content block'): void {
  const row = object(value, label)
  text(row['type'], `${label}.type`, true)
  switch (row['type']) {
    case 'text': case 'reasoning':
      keys(row, ['type', 'text'], [], label)
      text(row['text'], `${label}.text`)
      return
    case 'tool-call':
      keys(row, ['type', 'id', 'name', 'arguments'], [], label)
      text(row['id'], `${label}.id`, true)
      text(row['name'], `${label}.name`, true)
      text(row['arguments'], `${label}.arguments`)
      return
    case 'tool-result':
      throw new TypeError(`${label} contains a retired nested tool-result; use a native tool message`)
    case 'image': case 'file': {
      const image = row['type'] === 'image'
      keys(row, ['type', 'attachment'], image ? ['offloaded'] : [], label)
      if (Object.hasOwn(row, 'offloaded') && row['offloaded'] !== true) throw new TypeError(`${label}.offloaded must be true when present`)
      const attachment = object(row['attachment'], `${label}.attachment`)
      keys(attachment, image ? ['attachmentId', 'mediaType', 'bytes', 'width', 'height'] : ['attachmentId', 'name', 'bytes'],
        image ? ['name', 'originalDimensions'] : [], `${label}.attachment`)
      text(attachment['attachmentId'], `${label}.attachment.attachmentId`, true)
      count(attachment['bytes'], `${label}.attachment.bytes`)
      if (!image || Object.hasOwn(attachment, 'name')) text(attachment['name'], `${label}.attachment.name`)
      if (!image) return
      if (typeof attachment['mediaType'] !== 'string' || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment['mediaType'])) {
        throw new TypeError(`${label}.attachment.mediaType is not a supported image type`)
      }
      count(attachment['width'], `${label}.attachment.width`, 1)
      count(attachment['height'], `${label}.attachment.height`, 1)
      if (Object.hasOwn(attachment, 'originalDimensions')) {
        const dimensions = object(attachment['originalDimensions'], `${label}.attachment.originalDimensions`)
        keys(dimensions, ['width', 'height'], [], `${label}.attachment.originalDimensions`)
        count(dimensions['width'], `${label}.attachment.originalDimensions.width`, 1)
        count(dimensions['height'], `${label}.attachment.originalDimensions.height`, 1)
      }
    }
  }
}

/** Validate the native flat content list without recursively scanning unknown extension fields. */
export function assertContentBlocks(value: unknown, label = 'content'): void {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  value.forEach((block, index) => assertContentBlock(block, `${label}[${index}]`))
}

const CONTENT_EVENTS = new Set(['user/message', 'system/message', 'tool/result', 'team/message/queued',
  'agent/inbox/spliced', 'session/title-llm-request', 'compaction/summary', 'tool/ptc-dispatch',
  'assistant/message', 'assistant/attempt'])

/** Content carried by core events uses the same rules on append and persisted replay. */
export function assertRecordedContent(type: string, value: unknown, label: string): void {
  if (!CONTENT_EVENTS.has(type)) return
  const row = object(value, label)
  const contentOf = (message: unknown, path: string) => assertContentBlocks(object(message, path)['content'], `${path}.content`)
  switch (type) {
    case 'user/message': contentOf(row, label); break
    case 'system/message': case 'tool/result': case 'team/message/queued': contentOf(row['message'], `${label}.message`); break
    case 'agent/inbox/spliced': case 'session/title-llm-request': {
      const key = type === 'agent/inbox/spliced' ? 'inserted' : 'messages'
      if (!Array.isArray(row[key])) throw new TypeError(`${label}.${key} must be an array`)
      row[key].forEach((message, index) => contentOf(message, `${label}.${key}[${index}]`))
      break
    }
    case 'compaction/summary':
      assertContentBlocks(row['summary'], `${label}.summary`)
      if (row['rawOutput'] !== undefined) assertContentBlocks(row['rawOutput'], `${label}.rawOutput`)
      break
    case 'tool/ptc-dispatch': assertContentBlocks(row['content'], `${label}.content`); break
    case 'assistant/message': case 'assistant/attempt':
      if (type === 'assistant/message') contentOf(row['message'], `${label}.message`)
      if (!Array.isArray(row['stream'])) throw new TypeError(`${label}.stream must be an array`)
      row['stream'].forEach((frame, index) => {
        const event = object(frame, `${label}.stream[${index}]`)
        if (event['type'] !== 'chunk') return
        const chunkLabel = `${label}.stream[${index}].chunk`
        const chunk = object(event['chunk'], chunkLabel)
        if (chunk['type'] === 'block-end') assertContentBlock(chunk['block'], `${chunkLabel}.block`)
        if (chunk['type'] === 'block-start') {
          text(chunk['blockType'], `${chunkLabel}.blockType`, true)
          if (chunk['blockType'] === 'tool-result') throw new TypeError(`${chunkLabel} has retired blockType tool-result`)
        }
      })
  }
}
