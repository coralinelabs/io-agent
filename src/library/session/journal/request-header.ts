/**
 * Request-header reconstruction utilities over full `request/header` session
 * events. Anyone holding a session log reconstructs the {@link EpochHeader}
 * any request was built under by taking the latest canonical snapshot; the
 * loop uses the same equality helper to avoid logging unchanged headers.
 *
 * @module dsh-session/request-header
 */

import { callConfigEquals } from "../../model/llm/index.ts"
import type { ToolSchema } from "../../model/llm/index.ts"
import type { EpochHeader, SessionEvent } from './types.ts'

/**
 * Normalize a header to canonical form: an empty tool list becomes an absent
 * field, matching how requests are built. Logging, folding, and comparison use
 * this one representation.
 * @param header - the header to normalize (not mutated).
 * @returns the canonical header.
 */
export function canonicalHeader(header: EpochHeader): EpochHeader {
  const adapterDefaults = header.adapterDefaults
  return {
    config: header.config,
    ...adapterDefaults?.reasoningEffort === true || adapterDefaults?.maxTokens === true
      ? { adapterDefaults }
      : {},
    ...header.tools !== undefined && header.tools.length > 0 ? { tools: header.tools } : {},
  }
}

/** Canonical JSON equality for tool schemas assembled through the same path. */
function sameSchema(a: ToolSchema, b: ToolSchema): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Field-wise equality over canonical headers. Tool schemas compare in order.
 * @param a - one canonical header.
 * @param b - the other.
 * @returns whether config, adapter defaults, and tools all match.
 */
export function headerEquals(a: EpochHeader, b: EpochHeader): boolean {
  if (
    !callConfigEquals(a.config, b.config)
    || a.adapterDefaults?.reasoningEffort !== b.adapterDefaults?.reasoningEffort
    || a.adapterDefaults?.maxTokens !== b.adapterDefaults?.maxTokens
  ) return false
  const at = a.tools ?? []
  const bt = b.tools ?? []
  return at.length === bt.length && at.every((tool, i) => sameSchema(tool, bt[i] as ToolSchema))
}

/**
 * Keep a session's tool list append-only across mid-session tool changes.
 * Every provider renders the tool list ahead of the
 * conversation, so a tool inserted mid-list loses the cached prefix from the
 * insertion point, while one appended keeps every earlier schema. Tools still
 * present keep their previous position and take their current schema; new
 * names follow, in the current (assembly) order; removed tools drop out, which
 * still changes the list. Without a previous list the current order stands.
 * @param previous - the tool list of the previous request header, if any.
 * @param current - this request's assembled tools, in canonical order.
 * @returns the current tools in append-only order (the same array when nothing moves).
 */
export function appendNewTools<T extends ToolSchema>(previous: readonly ToolSchema[] | undefined, current: T[]): T[] {
  if (previous === undefined || previous.length === 0) return current
  const byName = new Map(current.map(tool => [tool.name, tool]))
  const kept = previous.flatMap(tool => byName.get(tool.name) ?? [])
  const known = new Set(kept.map(tool => tool.name))
  const ordered = [...kept, ...current.filter(tool => !known.has(tool.name))]
  return ordered.every((tool, index) => tool === current[index]) ? current : ordered
}

/**
 * Fold the header events of a log (or any prefix) into the
 * {@link EpochHeader} in force after the last snapshot. Non-header events are
 * skipped. This is the pure offline reconstruction path; the live session
 * tracks the same fold incrementally.
 * @param events - session events in log order.
 * @param from - a previously folded state to continue from.
 * @returns the latest canonical header, or undefined when none exists yet.
 */
export function foldRequestHeader(events: readonly SessionEvent[], from?: EpochHeader): EpochHeader | undefined {
  let state = from
  for (const event of events) {
    if (event.type === 'request/header') state = canonicalHeader(event.data.header)
  }
  return state
}
