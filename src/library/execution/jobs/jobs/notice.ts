/**
 * Stable message identity for notices about work that outlives the process.
 * A notice re-sent after a restart carries the same id as the one sent
 * before it, so a reader of the session journal can tell it already arrived.
 * @module io-agent/jobs/notice
 */

import { createHash } from 'node:crypto'
import { MessageId } from '../../../model/llm/index.ts'

/**
 * The message id of the notice about one keyed item.
 * @param key - the item's durable key (a job token, `watch:<token>`).
 * @returns a UUID-shaped id derived from the key.
 */
export function noticeMessageId(key: string): MessageId {
  // The salt keeps its name from before io-agent: a notice queued before an upgrade must keep its id.
  const hex = createHash('sha256').update(`pluto-background-notice\0${key}`).digest('hex')
  return MessageId(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`)
}
