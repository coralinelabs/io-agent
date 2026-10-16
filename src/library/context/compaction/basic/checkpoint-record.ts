/**
 * Deterministic checkpoint sections appended after the summarizer's output:
 * the user's own messages quoted verbatim, the current todo list, skills whose
 * loaded instructions left the context, and an index of exact identifiers.
 *
 * Everything here is derived from the visible surface, from the results their
 * calls recorded (for a result a pruner rewrote in place), and from the
 * structured record earlier checkpoints carry, never from model output, so the
 * same surface always yields the same bytes. User text is the source of truth
 * and cannot be reconstructed from the work that followed it; it is carried
 * forward by record, not re-summarized. Skill loads and todo lists are
 * recognized by readers their owning capabilities export; this module knows
 * no tool names or wire formats. Each result is matched to the call its own
 * step issued (turn, step and call id): the journal requires call ids to be
 * unique within a step only, and providers reuse them across steps.
 *
 * @module io-agent/compaction-basic/checkpoint-record
 */

import { modelText } from "../../text/index.ts"
import type { ContentBlock, Message, TextBlock } from "../../../model/llm/index.ts"
import type { SessionEvent, SessionSeq } from "../../../session/journal/index.ts"
import type { VisibleMessage } from "../../visibility.ts"
import { CHECKPOINT_ANCHOR_KINDS, isCompactCheckpointSource, readCheckpointRecord } from "../compaction/checkpoint.ts"
import type {
  CheckpointAnchor,
  CheckpointAnchorKind,
  CheckpointAnchors,
  CheckpointRecord,
  CheckpointTodo,
  CheckpointUserEntry,
} from "../compaction/checkpoint.ts"
import type { CheckpointReaders, CheckpointToolResult, ResolvedCheckpointConfig } from './types.ts'

/** Smallest remaining user budget still worth a cut message. */
const MIN_USER_SLICE_BYTES = 256
/** Newest condensed text scanned for anchors. */
const MAX_ANCHOR_SCAN_CHARS = 4_000_000
/** Per-item byte cap for carried and shown todo content. */
const TODO_CONTENT_MAX_BYTES = 500
/** Items a record carries, completed ones included. */
const TODO_RECORD_MAX_ITEMS = 100

/** Checkpoint sections plus the record the next compaction carries forward. */
export interface CheckpointAppendix {
  /** Structured carry-forward facts; `undefined` when there is nothing to show or carry. */
  readonly record?: CheckpointRecord
  /** Rendered sections, each starting with a blank-line separator, in fixed order. */
  readonly blocks: readonly TextBlock[]
}

/** Inputs besides the surface itself. */
export interface CheckpointAppendixOptions {
  readonly config: ResolvedCheckpointConfig
  /** Capability-owned recognizers for skill loads and todo lists; a missing one leaves its section empty. */
  readonly readers?: CheckpointReaders
  /** Whether the condensed span begins at the first non-system surface node. */
  readonly fromSurfaceStart: boolean
  /** Session working directory; absolute paths under it are shown relative. */
  readonly cwd?: string
  /**
   * The quoted user words were scaled to nothing (an overflow recovery's last resort), not turned off: every
   * message is counted as omitted, so the section still says how many and the record carries the count.
   */
  readonly usersScaledOut?: boolean
  /**
   * The message a rewritten `tool/result` node's call recorded, read back
   * through its replacement chain (`recordedToolResult`); `undefined` when the
   * chain cannot be read. Readers classify, and anchors are harvested from,
   * that recorded text rather than a stub or marker. Omitted, a rewritten
   * result is read as it is shown now.
   */
  readonly recordedResult?: (event: SessionEvent<'tool/result'>) => Message | undefined
}

/** An empty appendix: no sections and no record. */
export const EMPTY_CHECKPOINT_APPENDIX: CheckpointAppendix = Object.freeze({ blocks: Object.freeze([]) })

/**
 * Append the host's pointer to the full condensed history as the last
 * section. It is rendered, never carried: the record stays as built.
 * @param appendix - the deterministic sections and record.
 * @param pointer - the rendered pointer section; `undefined` or empty leaves the appendix unchanged.
 * @returns the appendix with the pointer section last.
 */
export function withLogPointer(appendix: CheckpointAppendix, pointer: string | undefined): CheckpointAppendix {
  if (pointer === undefined || pointer.length === 0) return appendix
  return { ...appendix, blocks: [...appendix.blocks, section(pointer)] }
}

/**
 * The earliest original surface event behind a span: a condensed checkpoint
 * stands for the span it replaced (its record's `condensedFrom`, or for a
 * checkpoint written without one the earliest event it cites), every other
 * condensed node for itself.
 * @param visible - the visible surface.
 * @param shadowed - surface seqs the checkpoint would replace.
 * @returns the earliest seq, or `undefined` for an empty span.
 * @throws when a condensed checkpoint carries a malformed record.
 */
export function condensedSpanStart(
  visible: readonly VisibleMessage[],
  shadowed: ReadonlySet<SessionSeq>,
): number | undefined {
  let start: number | undefined
  for (const entry of visible) {
    if (!shadowed.has(entry.seq)) continue
    let from = Number(entry.seq)
    if (isCompactCheckpointSource(entry.message.source)) {
      const carried = readCheckpointRecord(entry.message.source)?.condensedFrom
      const cited = entry.event.sourceEventSeqs ?? []
      from = Math.min(from, carried ?? (cited.length === 0 ? from : Math.min(...cited.map(Number))))
    }
    start = start === undefined ? from : Math.min(start, from)
  }
  for (const seq of shadowed) start = start === undefined ? Number(seq) : Math.min(start, Number(seq))
  return start
}

interface CallInfo {
  readonly name: string
  readonly arguments: string
}

/** Condensed text scanned for anchors, or the index a prior checkpoint carried. */
type AnchorSource = { readonly text: string } | { readonly carried: CheckpointAnchors }

/**
 * Build the deterministic checkpoint sections for one condensed span.
 * @param visible - the current visible surface in model order.
 * @param shadowed - surface seqs the checkpoint replaces.
 * @param options - budgets, capability-owned readers, span position and working directory.
 * @returns rendered sections and the carry-forward record.
 * @throws when a condensed checkpoint carries a malformed record.
 */
export function buildCheckpointAppendix(
  visible: readonly VisibleMessage[],
  shadowed: ReadonlySet<SessionSeq>,
  options: CheckpointAppendixOptions,
): CheckpointAppendix {
  const { config } = options
  const readers = options.readers ?? {}
  const calls = toolCalls(visible)
  const successfulResult = (entry: VisibleMessage): CheckpointToolResult | undefined =>
    successfulToolResult(entry, calls, options.recordedResult)
  const lastCondensed = visible.findLastIndex(entry => shadowed.has(entry.seq))

  const timeline: CheckpointUserEntry[] = []
  let priorOmitted = 0
  let sawCheckpoint = false
  const skillLoads: string[] = []
  let todos: readonly CheckpointTodo[] | undefined
  const evidence: AnchorSource[] = []

  for (const entry of visible) {
    if (!shadowed.has(entry.seq)) continue
    const { message } = entry
    if (message.role === 'system') continue
    if (message.role === 'assistant') {
      evidence.push(...assistantSegments(message).map(text => ({ text })))
      continue
    }
    if (isCompactCheckpointSource(message.source)) {
      // A checkpoint replaced everything before it. Its record carries what
      // its sections say; its summary is model output and is never indexed.
      sawCheckpoint = true
      const record = readCheckpointRecord(message.source)
      todos = record?.todos
      if (record !== undefined) {
        timeline.push(...record.users)
        priorOmitted += record.omittedUsers
        skillLoads.push(...[...record.skills].reverse())
        if (record.anchors !== undefined) evidence.push({ carried: record.anchors })
      }
      continue
    }
    const result = successfulResult(entry)
    if (result !== undefined) {
      const loaded = readers.skillLoad?.(result)
      const written = loaded === undefined ? readers.todoList?.(result) : undefined
      if (loaded !== undefined) skillLoads.push(loaded)
      else if (written !== undefined) todos = carriedTodos(written)
      // Loaded instructions and the plan itself are not task evidence. A
      // pruned result is indexed as its call recorded it, not as its stub.
      else evidence.push({ text: result.recordedText ?? result.text })
      continue
    }
    if (message.source.kind === 'tool') {
      evidence.push({ text: resultText(message.content) })
      continue
    }
    const injected = readers.skillInjection?.(message)
    if (injected !== undefined) {
      skillLoads.push(injected)
      continue
    }
    const authored = authoredText(message)
    if (authored !== undefined) {
      const first = options.fromSurfaceStart && !sawCheckpoint && timeline.length === 0
      timeline.push({ seq: Number(entry.seq), text: authored, ...first ? { first: true as const } : {} })
      evidence.push({ text: authored })
      // A user message after the latest write may have redirected the work;
      // like the `todos` projection at the next turn, the list stops being current.
      todos = undefined
      continue
    }
    if (isEvidence(message)) evidence.push(...textBlocks(message.content).map(text => ({ text })))
  }

  const visibleSkills = new Set<string>()
  let retainedTodoWrite = false
  for (const [index, entry] of visible.entries()) {
    if (shadowed.has(entry.seq) || (entry.message.role !== 'user' && entry.message.role !== 'tool')) continue
    const appended = entry.event.surfaceOp === 'append'
    const result = successfulResult(entry)
    if (result !== undefined) {
      // Only an appended body is still in the context; a pruned reload is not.
      const name = appended ? readers.skillLoad?.(result) : undefined
      if (name !== undefined) visibleSkills.add(name)
      else if (readers.todoList?.(result) !== undefined) retainedTodoWrite = true
      continue
    }
    const injected = appended ? readers.skillInjection?.(entry.message) : undefined
    if (injected !== undefined) visibleSkills.add(injected)
    else if (index > lastCondensed && authoredText(entry.message) !== undefined) todos = undefined
  }

  const usersOff = config.userMessageBytes === 0 && options.usersScaledOut !== true
  const users = config.userMessageBytes === 0
    ? { kept: [], omitted: usersOff ? 0 : timeline.length }
    : budgetUsers(timeline, config)
  const omittedUsers = usersOff ? 0 : priorOmitted + users.omitted
  const skills = config.maxSkills === 0 ? [] : [...new Set([...skillLoads].reverse())]
    .filter(name => !visibleSkills.has(name))
    .slice(0, config.maxSkills)
  const currentTodos = config.maxTodoItems === 0 ? undefined : todos
  const anchors = config.anchorBytes === 0 ? { lines: [] } : harvestAnchors(evidence, config.anchorBytes, options.cwd)

  const blocks: TextBlock[] = []
  const usersSection = renderUsers(users.kept, omittedUsers)
  if (usersSection !== undefined) blocks.push(section(usersSection))
  const todoSection = currentTodos === undefined || retainedTodoWrite
    ? undefined
    : renderTodos(currentTodos, config.maxTodoItems)
  if (todoSection !== undefined) blocks.push(section(todoSection))
  if (skills.length > 0) {
    blocks.push(section(modelText('compaction/checkpoint-skills', {
      skills: skills.map(name => `\`${name}\``).join(', '),
    })))
  }
  if (anchors.lines.length > 0) {
    blocks.push(section(modelText('compaction/checkpoint-anchors', { lines: anchors.lines.join('\n') })))
  }

  const condensedFrom = condensedSpanStart(visible, shadowed)
  // Every rendered section comes from a record member, so an empty record means no sections.
  if (users.kept.length === 0 && omittedUsers === 0 && skills.length === 0
    && currentTodos === undefined && anchors.record === undefined) return EMPTY_CHECKPOINT_APPENDIX
  return {
    record: {
      version: 1,
      users: users.kept,
      omittedUsers,
      skills,
      ...currentTodos === undefined ? {} : { todos: currentTodos },
      ...anchors.record === undefined ? {} : { anchors: anchors.record },
      ...condensedFrom === undefined ? {} : { condensedFrom },
    },
    blocks,
  }
}

/**
 * Cut text to at most `cap` UTF-8 bytes, keeping about three quarters from the
 * head and the rest from the tail around an omission marker. Text within the
 * cap is returned unchanged, so carrying a cut text forward is stable.
 * @param text - text to fit.
 * @param cap - maximum UTF-8 bytes of the result.
 * @returns the text itself, or its head and tail joined by the marker.
 */
export function cutText(text: string, cap: number): string {
  const total = byteLength(text)
  if (total <= cap) return text
  const marker = (omitted: number): string =>
    `\n${modelText('compaction/checkpoint-user-truncated', { bytes: omitted })}\n`
  const reserve = byteLength(marker(total))
  if (cap < reserve + 16) return headBytes(text, cap)
  const available = cap - reserve
  const head = headBytes(text, Math.floor(available * 3 / 4))
  const tail = tailBytes(text, available - byteLength(head))
  return head + marker(total - byteLength(head) - byteLength(tail)) + tail
}

/** Keep the first message, then the newest others contiguously within the byte budget. */
function budgetUsers(
  timeline: readonly CheckpointUserEntry[],
  config: ResolvedCheckpointConfig,
): { kept: CheckpointUserEntry[]; omitted: number } {
  const firstIndex = config.firstUserMessageMaxBytes === 0 ? -1 : timeline.findIndex(entry => entry.first === true)
  let remaining = config.userMessageBytes
  let first: CheckpointUserEntry | undefined
  if (firstIndex !== -1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the index was just found
    const entry = timeline[firstIndex]!
    const text = cutText(entry.text, Math.min(config.firstUserMessageMaxBytes, remaining))
    first = { seq: entry.seq, text, first: true }
    remaining -= byteLength(text)
  }
  const others = timeline.filter((_entry, index) => index !== firstIndex)
  const newest: CheckpointUserEntry[] = []
  let omitted = 0
  for (let index = others.length - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop
    const entry = others[index]!
    const cap = Math.min(config.userMessageMaxBytes, remaining)
    // A straddler is cut while a useful slice remains; after that, every older
    // message is dropped so the kept messages stay one contiguous newest run.
    if (byteLength(entry.text) > remaining && remaining < MIN_USER_SLICE_BYTES) {
      omitted = index + 1
      break
    }
    const text = cutText(entry.text, cap)
    newest.push({ seq: entry.seq, text })
    remaining -= byteLength(text)
  }
  return { kept: [...first === undefined ? [] : [first], ...newest.reverse()], omitted }
}

function renderUsers(kept: readonly CheckpointUserEntry[], omitted: number): string | undefined {
  if (kept.length === 0 && omitted === 0) return undefined
  const first = kept[0]?.first === true ? kept[0] : undefined
  const others = (first === undefined ? kept : kept.slice(1)).toReversed()
  const parts = others.map(entry => quote(entry.text))
  if (omitted > 0) parts.push(modelText('compaction/checkpoint-users-omitted', { count: omitted }))
  if (first !== undefined) parts.push(`${modelText('compaction/checkpoint-users-first')}\n${quote(first.text)}`)
  return modelText('compaction/checkpoint-users', { messages: parts.join('\n\n') })
}

function renderTodos(todos: readonly CheckpointTodo[], maxItems: number): string | undefined {
  const active = todos.filter(todo => todo.status !== 'completed')
  if (active.length === 0) return undefined
  return modelText('compaction/checkpoint-todos', {
    completed: todos.length - active.length,
    todos: active.slice(0, maxItems).map(todo => `- [${todo.status}] ${todo.content}`).join('\n'),
  })
}

function section(text: string): TextBlock {
  return { type: 'text', text: `\n\n${text}` }
}

function quote(text: string): string {
  return text.split('\n').map(line => line.length === 0 ? '>' : `> ${line}`).join('\n')
}

/** Host and child prompts only: goal rounds, relays and injected context are not the user's words. */
function authoredText(message: Message): string | undefined {
  if (message.role !== 'user' || message.source.kind !== 'user') return undefined
  const text = message.content.map((block) => {
    switch (block.type) {
      case 'text': return block.text
      case 'image': return modelText('compaction/checkpoint-user-image', {
        digest: String(block.attachment.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8),
      })
      case 'file': return modelText('compaction/checkpoint-user-file', { name: block.attachment.name })
      default: return ''
    }
  }).join('').trim()
  return text.length === 0 ? undefined : text
}

/**
 * Task evidence for anchors. Plugin context and every message whose producer
 * declared it instructions, a catalog or a snapshot is background, not work.
 */
function isEvidence(message: Message): boolean {
  const source = message.source as Message['source'] & { form?: string }
  if (source.kind === 'plugin') return false
  return source.form !== 'instructions' && source.form !== 'catalog' && source.form !== 'snapshot'
}

/** A call's identity: its id within the turn and step that issued it (a replacement result keeps both). */
function callKey(data: { readonly turn: number; readonly step: number }, id: string): string {
  return `${data.turn}:${data.step}:${id}`
}

/** Visible tool calls keyed by the step that issued them. */
function toolCalls(visible: readonly VisibleMessage[]): ReadonlyMap<string, CallInfo> {
  const calls = new Map<string, CallInfo>()
  for (const { event, message } of visible) {
    if (event.type !== 'assistant/message' || message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'tool-call') calls.set(callKey(event.data, block.id), { name: block.name, arguments: block.arguments })
    }
  }
  return calls
}

/** A successful tool result as readers see it, with the call its own step issued; `undefined` for errors and every other message. */
function successfulToolResult(
  entry: VisibleMessage,
  calls: ReadonlyMap<string, CallInfo>,
  recordedResult: CheckpointAppendixOptions['recordedResult'],
): CheckpointToolResult | undefined {
  const { event, message } = entry
  if (message.role !== 'tool' || message.isError) return undefined
  const result = message
  const call = event.type === 'tool/result' ? calls.get(callKey(event.data, result.toolCallId)) : undefined
  const text = resultText(result.content)
  const rewritten = event.surfaceOp !== 'append'
  const recorded = !rewritten ? text
    : event.type === 'tool/result' ? recordedText(recordedResult?.(event)) : undefined
  return {
    ...call === undefined ? {} : { call },
    text,
    rewritten,
    ...recorded === undefined ? {} : { recordedText: recorded },
  }
}

/** Text of a recorded tool-result message, blocks joined. */
function recordedText(message: Message | undefined): string | undefined {
  return message === undefined ? undefined : resultText(message.content)
}

/** A written list normalized for carrying: one line per item, bounded items and bytes. */
function carriedTodos(list: readonly CheckpointTodo[]): readonly CheckpointTodo[] {
  return list.slice(0, TODO_RECORD_MAX_ITEMS).map(todo => ({
    content: headBytes(todo.content.replace(/\s*\n\s*/g, ' ').trim(), TODO_CONTENT_MAX_BYTES),
    status: todo.status,
  }))
}

function resultText(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => block.type === 'text' ? block.text : '').join('')
}

function textBlocks(blocks: readonly ContentBlock[]): string[] {
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : [])
}

function assistantSegments(message: Message): string[] {
  return message.content.flatMap((block) => {
    if (block.type === 'text') return [block.text]
    if (block.type !== 'tool-call') return []
    try {
      return stringLeaves(JSON.parse(block.arguments) as unknown)
    } catch {
      return [block.arguments]
    }
  })
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringLeaves)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringLeaves)
  return []
}

const FILE_PATTERN = /(?<![\w./-])[\w./-]*[\w-]\.(?:ts|tsx|js|mjs|cjs|jsx|json|md|py|rs|go|java|kt|c|h|cc|cpp|hpp|cs|rb|php|swift|sh|ya?ml|toml|sql|html|css|txt|lock|cfg|ini|xml|proto)(?![\w/-])(?!\.\w)/g
// A message stops at a line end, a backtick (summaries and Markdown quote
// errors in code spans), or a comma, period or semicolon followed by a space,
// where prose or a list continues.
const ERROR_MESSAGE = String.raw`(?:(?![,.;] )[^\n\x60]){1,100}`
const ERROR_PATTERN = new RegExp([
  String.raw`\b[A-Z][A-Za-z0-9]*(?:Error|Exception)\b(?::${ERROR_MESSAGE})?`,
  String.raw`\bE(?:NOENT|ACCES|EXIST|ISDIR|NOTDIR|PERM|CONNREFUSED|CONNRESET|TIMEDOUT|ADDRINUSE|PIPE|MFILE|NOTEMPTY|NOSPC|ROFS|AGAIN|BUSY|INVAL|NOMEM|XDEV|LOOP|NAMETOOLONG|NOTFOUND)\b`,
  String.raw`\berror TS\d{4}\b(?::${ERROR_MESSAGE})?`,
  String.raw`\berror\[E\d{4}\]`,
  String.raw`\bpanic: ${ERROR_MESSAGE}`,
].join('|'), 'g')
/**
 * A test-file path. Like an error message, a title stops at a backtick or at
 * prose punctuation, and never runs into the next test file.
 */
const TEST_FILE = String.raw`[\w./-]+\.(?:spec|test)\.[cm]?[jt]sx?`
const TEST_PATTERN = new RegExp([
  String.raw`(?<![\w./-])[\w./-]+\.py::[\w.:[\]-]+`,
  String.raw`--- FAIL: \w+`,
  String.raw`(?<![\w./-])${TEST_FILE}(?:[ \t]+>[ \t]+(?:(?!${TEST_FILE}|[,.;] )[^\n>\x60]){0,79}(?!${TEST_FILE})[^\s>\x60]){1,3}`,
].join('|'), 'g')
/** Library names spelled like files; not workspace paths. */
const LIBRARY_NAME = /^(?:node|deno|vue|next|nuxt|express|react|preact|three|chart|ember|backbone|angular|moment|d3|p5|alpine|solid|svelte)\.js$/i
/**
 * Git-shaped hashes only: abbreviated (7-12) or full (40) hex with a letter
 * and a digit. Other hex runs, such as 32-character API keys, are not indexed.
 */
const COMMIT_PATTERN = /(?<![\w-])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)(?:[0-9a-f]{40}|[0-9a-f]{7,12})(?![\w-])/g
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]}]+/g
/** A value assigned to a credential-named key, on the same line before the value. */
const SECRET_ASSIGNMENT = /(?:key|token|secret|passw(?:or)?d|pwd|credential|auth\w*)["']?\s*[:=]\s*(?:bearer\s+|basic\s+)?["']?$/i
/** Well-known credential formats, anywhere in a value. */
const SECRET_PREFIXED = /(?:\bsk-[\w-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_\w{20,}|\bglpat-[\w-]{20,}|\bxox[abposr]-[\w-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[\w-]{30,})/
/** Hosts whose URL paths carry the credential (incoming webhooks, bot tokens). */
const CREDENTIAL_PATH_HOSTS = /^(?:hooks\.slack\.com|(?:\w+\.)?discord(?:app)?\.com|api\.telegram\.org|hooks\.zapier\.com|[\w-]+\.webhook\.office\.com|outlook\.office\.com)$/i

const ANCHOR_CAPS: Readonly<Record<CheckpointAnchorKind, number>> = {
  files: 40,
  errors: 16,
  tests: 16,
  commits: 16,
  urls: 12,
}

/**
 * Harvest exact identifiers from condensed text, merge the index a prior
 * checkpoint carried, rank by frequency, then recency, then value, and render
 * category lines within a byte budget.
 * @returns the rendered lines and the anchors they show, carried by value.
 */
function harvestAnchors(
  sources: readonly AnchorSource[],
  budget: number,
  cwd: string | undefined,
): { lines: string[]; record?: CheckpointAnchors } {
  let scanned = 0
  let start = sources.length
  while (start > 0 && scanned < MAX_ANCHOR_SCAN_CHARS) {
    start -= 1
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop
    const source = sources[start]!
    if ('text' in source) scanned += source.text.length
  }
  const tallies = new Map<CheckpointAnchorKind, Map<string, { count: number; last: number }>>(
    CHECKPOINT_ANCHOR_KINDS.map(kind => [kind, new Map()]),
  )
  let position = 0
  const tally = (kind: CheckpointAnchorKind, value: string | undefined, count = 1): void => {
    if (value === undefined || value.length === 0) return
    position += 1
    // oxlint-disable-next-line typescript/no-non-null-assertion -- every kind is initialized
    const counts = tallies.get(kind)!
    const previous = counts.get(value)
    counts.set(value, { count: (previous?.count ?? 0) + count, last: position })
  }
  // Values that look like credentials, or follow a credential-named key on
  // their line, are never copied forward.
  const harvest = (kind: CheckpointAnchorKind, text: string, at: number, value: string | undefined): void => {
    if (value === undefined || SECRET_PREFIXED.test(value)) return
    if (!SECRET_ASSIGNMENT.test(text.slice(text.lastIndexOf('\n', at - 1) + 1, at))) tally(kind, value)
  }
  for (const [index, source] of sources.entries()) {
    if ('carried' in source) {
      // Carried values are already clean; replaying them from last to first
      // keeps their order among equal counts.
      for (const kind of CHECKPOINT_ANCHOR_KINDS) {
        for (const anchor of (source.carried[kind] ?? []).toReversed()) tally(kind, anchor.value, anchor.count)
      }
      continue
    }
    if (index < start) continue
    const text = source.text.replace(URL_PATTERN, (url, at: number, whole: string) => {
      harvest('urls', whole, at, normalizeUrl(url))
      return ' '.repeat(url.length)
    })
    for (const match of text.matchAll(FILE_PATTERN)) {
      if (!LIBRARY_NAME.test(match[0])) harvest('files', text, match.index, relativePath(match[0], cwd))
    }
    for (const match of text.matchAll(ERROR_PATTERN)) harvest('errors', text, match.index, cleanValue(match[0]))
    for (const match of text.matchAll(TEST_PATTERN)) {
      harvest('tests', text, match.index, cleanValue(match[0]).replace(/\s+\d+(?:\.\d+)?m?s$/, ''))
    }
    for (const match of text.matchAll(COMMIT_PATTERN)) harvest('commits', text, match.index, match[0])
  }

  const lines: string[] = []
  const record: { [Kind in CheckpointAnchorKind]?: CheckpointAnchor[] } = {}
  let used = 0
  for (const kind of CHECKPOINT_ANCHOR_KINDS) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- every kind is initialized
    const ranked = [...tallies.get(kind)!.entries()]
      .sort(([a, x], [b, y]) => y.count - x.count || y.last - x.last || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, ANCHOR_CAPS[kind])
    const kept: CheckpointAnchor[] = []
    let exhausted = false
    for (const [value, { count }] of ranked) {
      const cost = byteLength(renderAnchor(value, count)) + 2
      if (used + cost > budget) {
        exhausted = true
        break
      }
      kept.push({ value, count })
      used += cost
    }
    if (kept.length > 0) {
      record[kind] = kept
      lines.push(modelText(`compaction/checkpoint-anchor-${kind}`, {
        values: kept.map(({ value, count }) => renderAnchor(value, count)).join(', '),
      }))
    }
    if (exhausted) break
  }
  return lines.length === 0 ? { lines } : { lines, record }
}

function renderAnchor(value: string, count: number): string {
  return count > 1 ? `${value} (x${count})` : value
}

function cleanValue(value: string): string {
  let cleaned = value.trim().replace(/[\s.,;:]+$/, '')
  const last = cleaned.charCodeAt(cleaned.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cleaned = cleaned.slice(0, -1)
  return cleaned
}

function relativePath(value: string, cwd: string | undefined): string | undefined {
  let path = value
  if (cwd !== undefined && cwd.length > 0) {
    const root = cwd.endsWith('/') ? cwd : `${cwd}/`
    if (path.startsWith(root)) path = path.slice(root.length)
  }
  while (path.startsWith('./')) path = path.slice(2)
  return path.length === 0 ? undefined : path
}

/**
 * Scheme, host and path only: credentials, queries and fragments are never
 * indexed. A path that carries a credential (webhook hosts, token-shaped
 * segments) is reduced to scheme and host.
 */
function normalizeUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.replace(/[.,;:!?]+$/, ''))
    const origin = `${url.protocol}//${url.host}`
    if (CREDENTIAL_PATH_HOSTS.test(url.hostname) || url.pathname.split('/').some(isTokenSegment)) return origin
    return `${origin}${url.pathname}`
  } catch {
    return undefined
  }
}

/**
 * A path segment shaped like a credential: a known key format, a long hex run
 * that is not a full commit hash, or a long random-looking mixed-case run
 * (identifiers and slugs have long lowercase words; random tokens do not).
 */
function isTokenSegment(segment: string): boolean {
  if (SECRET_PREFIXED.test(segment)) return true
  if (/^[0-9a-f]{32,}$/i.test(segment)) return segment.length !== 40
  return /^[\w:-]{20,}$/.test(segment) && /[a-z]/.test(segment) && /[A-Z]/.test(segment) && /\d/.test(segment)
    && !/[a-z]{6,}/.test(segment)
}

function pointBytes(point: string): number {
  // oxlint-disable-next-line typescript/no-non-null-assertion -- a code point string is never empty
  const code = point.codePointAt(0)!
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** The longest code-point prefix within `limit` UTF-8 bytes. */
function headBytes(text: string, limit: number): string {
  let used = 0
  let end = 0
  for (const point of text) {
    const size = pointBytes(point)
    if (used + size > limit) break
    used += size
    end += point.length
  }
  return text.slice(0, end)
}

/** The longest code-point suffix within `limit` UTF-8 bytes. */
function tailBytes(text: string, limit: number): string {
  const points = Array.from(text)
  let used = 0
  let start = points.length
  while (start > 0) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop
    const size = pointBytes(points[start - 1]!)
    if (used + size > limit) break
    used += size
    start -= 1
  }
  return points.slice(start).join('')
}
