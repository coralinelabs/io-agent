/**
 * Model-facing, read-only `recall` tool over the calling agent's own session
 * journal. It is what makes pruned-result pointers and
 * compaction checkpoints recoverable: the originals stay in the log, and this
 * tool reads them back by seq, by range, or by text search.
 *
 * One `sessionQuery.observeSession` lease per call supplies an immutable cut;
 * the pure helpers in `render.ts` do the rest. Literal search reuses the
 * session-query filters; `search: 'full-text'` delegates to the optional
 * `sessionQuery.searchEvents` backend (the SQLite FTS5 engine). No second
 * index, no journal writes beyond the normal tool call and result.
 *
 * @module io-agent/tool-recall
 */

import { modelText } from "../../context/text/index.ts"
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import z from "../../runtime/vendor/schemastery/index.ts"
import { defineTool } from "../../tools/index.ts"
import type {} from "../query/query/index.ts"
import {
  parseRecallRequest,
  RECALL_TOOL_NAME,
  RecallError,
  renderRecallEvent,
  renderRecallHits,
  renderRecallRange,
  searchRecallLiteral,
} from './render.ts'

export {
  parseRecallRequest,
  RECALL_LIMITS,
  RECALL_TOOL_NAME,
  RecallError,
  recallDocuments,
  renderRecallEvent,
  renderRecallHits,
  renderRecallRange,
  searchRecallLiteral,
  splitRecallQuery,
} from './render.ts'
export type { RecallArguments, RecallErrorCode, RecallOutputLimits, RecallRequest } from './render.ts'

export const name = 'tool-recall'
export const inject = ['tools', 'sessionQuery']

/** How `query` searches are answered, and how large one result may be. */
export interface Config {
  /**
   * `literal` (default) scans this session's semantic documents with the
   * session-query text filters. `full-text` asks `sessionQuery.searchEvents`,
   * which needs a full-text engine such as the SQLite FTS5 one.
   */
  search?: 'literal' | 'full-text'
  /**
   * UTF-8 bytes one result may occupy: event pages, range listings and search
   * listings stop there (offsets stay in code points). A composition with a
   * spill policy passes its per-result threshold, so a page of multi-byte text
   * is not spilled back to a preview. Omitted, a page is 16,000 code points.
   */
  maxOutputBytes?: number
}

export const Config: z<Config> = z.object({
  search: z.union(['literal', 'full-text'] as const).default('literal'),
  maxOutputBytes: z.number().step(1).min(1),
})

export function apply(ctx: Context, config: Config = {}): void {
  const search = config.search ?? 'literal'
  const limits = config.maxOutputBytes === undefined ? {} : { maxOutputBytes: config.maxOutputBytes }
  ctx.tools.register(defineTool({
    name: RECALL_TOOL_NAME,
    description: modelText('tools/recall/description'),
    parameters: {
      seq: { type: 'integer', description: modelText('tools/recall/seq') },
      offset: { type: 'integer', description: modelText('tools/recall/offset') },
      from: { type: 'integer', description: modelText('tools/recall/from') },
      to: { type: 'integer', description: modelText('tools/recall/to') },
      query: { type: 'string', description: modelText('tools/recall/query') },
      limit: { type: 'integer', description: modelText('tools/recall/limit') },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // A read of an immutable cut: it never mutates parent-owned state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new RecallError(modelText('tools/recall/no-session'), 'RECALL_NO_SESSION')
      const request = parseRecallRequest(args)
      // Scoped to the calling agent's own session: a fork child sees its inherited prefix, nothing else.
      const sessionId = agent.session.id
      using observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none', signal: exec.signal })
      const events = observation.events
      switch (request.mode) {
        case 'event':
          return renderRecallEvent(sessionId, events, request.seq, request.offset, limits)
        case 'range':
          return renderRecallRange(sessionId, events, request.from, request.to, limits)
        case 'search': {
          if (search === 'literal') return searchRecallLiteral(sessionId, events, request.query, request.limit, limits)
          // Over-fetch a little: hits on recall's own calls are dropped after ranking.
          const page = await ctx.sessionQuery.searchEvents(
            { sessionId, query: request.query, limit: Math.min(100, request.limit * 2 + 5) },
            { signal: exec.signal },
          )
          return renderRecallHits(sessionId, events, page.items, request.query, request.limit, limits)
        }
      }
    },
  }))
}
