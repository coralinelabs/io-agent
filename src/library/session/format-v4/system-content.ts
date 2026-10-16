/** Native v4 system-message content validation, retained from the released validator. */
import { SessionFormatError } from '../format/index.ts'
import type { SessionFormatJsonValue, SessionFormatJsonObject } from '../format/index.ts'
import { jsonRecord, exactKeys } from './validation-helpers.ts'
import { assertContentBlocks } from '../../model/llm/content-validation.ts'
type JsonRecord = Record<string, SessionFormatJsonValue>
/** Validate the content and plugin source of an admitted system message. */
export function assertSystemContent(message: SessionFormatJsonObject): void {
  try { assertContentBlocks(message['content'], 'system message content') } catch (error) {
    throw new SessionFormatError(String(error instanceof Error ? error.message : error))
  }
  pluginSourceValue(jsonRecord(message['source'], 'system message source'), 'system message source')
}


function exactRecord(
  value: SessionFormatJsonValue | undefined,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonRecord {
  const record = jsonRecord(value, label)
  exactKeys(record, required, optional, label)
  return record
}


function stringValue(value: SessionFormatJsonValue | undefined, label: string): asserts value is string {
  if (typeof value !== 'string') throw new SessionFormatError(`${label} must be a string`)
}


function nonEmptyString(value: SessionFormatJsonValue | undefined, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new SessionFormatError(`${label} must be a non-empty string`)
}


function literalValue(
  value: SessionFormatJsonValue | undefined,
  allowed: readonly SessionFormatJsonValue[],
  label: string,
): void {
  if (!allowed.some(candidate => candidate === value)) {
    throw new SessionFormatError(`${label} must be one of ${allowed.map(String).join(', ')}`)
  }
}


function arrayValue(
  value: SessionFormatJsonValue | undefined,
  label: string,
  validate: (value: SessionFormatJsonValue, label: string) => void,
): readonly SessionFormatJsonValue[] {
  if (!Array.isArray(value)) throw new SessionFormatError(`${label} must be an array`)
  const members = value as readonly SessionFormatJsonValue[]
  members.forEach((member, index) => {
    validate(member, `${label}[${index}]`)
  })
  return members
}


function pluginSourceValue(source: JsonRecord, label: string): void {
  const optional = ['form', 'sections', 'summary']
  if (source['plugin'] === 'compact') optional.push('compactionId', 'sourceCommandId')
  exactKeys(source, ['kind', 'plugin'], optional, label)
  nonEmptyString(source['plugin'], `${label} plugin`)
  if (source['plugin'] === 'compact') {
    nonEmptyString(source['compactionId'], `${label} compactionId`)
    if (source['sourceCommandId'] !== undefined) nonEmptyString(source['sourceCommandId'], `${label} sourceCommandId`)
  }
  const form = source['form']
  if (form === undefined) return
  literalValue(form, ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'], `${label} form`)
  if (form === 'snapshot') {
    arrayValue(source['sections'], `${label} sections`, (member, memberLabel) => {
      const section = exactRecord(member, memberLabel, ['name', 'text'])
      nonEmptyString(section['name'], `${memberLabel} name`)
      stringValue(section['text'], `${memberLabel} text`)
    })
  } else if (source['sections'] !== undefined) {
    throw new SessionFormatError(`${label} sections require snapshot form`)
  }
  if (form === 'notice') stringValue(source['summary'], `${label} summary`)
  else if (source['summary'] !== undefined) throw new SessionFormatError(`${label} summary requires notice form`)
}