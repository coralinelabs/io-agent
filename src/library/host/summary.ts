/** Session summaries for a chat list: an incremental fold over the journal and its persisted, revision-keyed cache. */
import { z } from 'zod'
import type { SessionEvent } from "../session/journal/index.ts"
import { defineDomain, domainTable } from "../storage/domain/index.ts"
import type { SessionSummary } from './types.ts'

const PREVIEW_MAX = 160

/** A summary without the live status and background flag, which only the running host knows. */
export type StoredSummary = Omit<SessionSummary, 'status' | 'background'>

/** Fold over one session's journal in order; the same result whether fed live or from a stored log. */
export class SummaryFold {
  private title: string | null = null
  private updated: number
  private preview = ''

  constructor(private readonly id: string, private readonly createdAt: number) {
    this.updated = createdAt
  }

  /**
   * Fold one journal event.
   * @param event - the next event of this session.
   */
  add(event: SessionEvent): void {
    if (event.type === 'session/title') this.title = event.data.title
    else if (event.type === 'turn/end') this.updated = event.time
    else if ((event.type === 'user/message' && event.data.source.kind === 'user') || event.type === 'assistant/message') {
      if (event.surfaceOp !== 'append') return
      this.updated = event.time
      const text = (event.type === 'user/message' ? event.data.content : event.data.message.content)
        .flatMap(block => block.type === 'text' ? [block.text] : []).join(' ').replace(/\s+/g, ' ').trim()
      if (text !== '') this.preview = text.length <= PREVIEW_MAX ? text : `${text.slice(0, PREVIEW_MAX - 1)}…`
    }
  }

  /** @returns the summary of every event folded so far. */
  value(): StoredSummary {
    return { id: this.id, title: this.title, created_at: this.createdAt, updated_at: this.updated, preview: this.preview }
  }
}

const storedSummary = z.object({
  /** Persistence revision of the log the summary was folded from. */
  revision: z.string(),
  summary: z.object({
    id: z.string(),
    title: z.string().nullable(),
    created_at: z.number(),
    updated_at: z.number(),
    preview: z.string(),
  }),
})

/** One cached summary and the log revision it describes. */
export type SummaryRecord = z.infer<typeof storedSummary>

/**
 * The host's summary cache: one document per session, so listing unchanged closed sessions after a
 * restart reads no journal. Derived data: an unreadable record is set aside and folded again.
 */
export const hostSummaryDomainSpec = defineDomain({
  name: 'host_summaries',
  version: 1,
  invalidRecords: 'backup-and-skip',
  layout: 'per-record',
  tables: { sessions: domainTable<string, SummaryRecord>(storedSummary) },
})
