/** Curated project memory, using dsh's atomic domain and kernel lease, not another storage engine. */
import type { Context } from "../runtime/vendor/cordis/index.ts"
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { defineDomain, domainTable } from "../storage/domain/index.ts"
import { SessionWriteLease } from "../session/persistence-jsonl/index.ts"
import { SessionId } from "../session/journal/index.ts"
import { defineTool } from "../tools/index.ts"
import { modelText } from "./text/index.ts"
import { approvalAnswerable } from "../runtime/options.ts"
import type { ResolvedIoAgentOptions } from "../runtime/options.ts"

export interface MemoryOptions { writePolicy?: 'ask' | 'allow' | 'deny'; maxBytes?: number; maxLines?: number }
export interface MemorySnapshot { revision: number; entries: Record<string, string> }
const snapshotSchema = z.object({ revision: z.number().int().nonnegative(), entries: z.record(z.string(), z.string()) }).strict()
const EMPTY: MemorySnapshot = { revision: 0, entries: {} }
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/
const INVALID = (reason: string): Error => new Error(modelText('memory/invalid', { reason }))
export function memoryBudget(snapshot: MemorySnapshot): { bytes: number; lines: number } {
  const text = Object.entries(snapshot.entries).map(([key, value]) => `${key}: ${value}`).join('\n')
  return { bytes: Buffer.byteLength(JSON.stringify(snapshot.entries)), lines: text.length === 0 ? 0 : text.split('\n').length }
}
export function changeMemory(current: MemorySnapshot, action: string, key: string | undefined, value: string | undefined,
  revision: number | undefined, maxBytes: number, maxLines: number): MemorySnapshot {
  if (revision === undefined || !Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) throw INVALID(modelText('memory/revision-invalid'))
  if (revision !== current.revision) throw new Error(modelText('memory/conflict', { expected: revision, actual: current.revision }))
  if (key === undefined || !KEY.test(key)) throw INVALID(modelText('memory/key-invalid'))
  const entries = { ...current.entries }
  if (action === 'put') {
    if (value === undefined || value.trim().length === 0) throw INVALID(modelText('memory/value-invalid'))
    Object.defineProperty(entries, key, { value: value.trim(), enumerable: true, configurable: true, writable: true })
  }
  else if (action === 'delete') {
    if (!Object.hasOwn(entries, key)) throw INVALID(modelText('memory/delete-missing'))
    Reflect.deleteProperty(entries, key)
  } else throw INVALID(action)
  const next = { revision: current.revision + 1, entries }
  const budget = memoryBudget(next)
  if (budget.bytes > maxBytes || budget.lines > maxLines) throw new Error(modelText('memory/budget', { bytes: maxBytes, lines: maxLines }))
  return next
}

/**
 * Whether a runtime can ever commit a memory write: `allow` always, `ask` only
 * when approval can ask. Decided once per runtime from the options, so the
 * advertised surface never changes mid-session.
 * @param writePolicy - the configured memory write policy.
 * @param approval - the runtime's approval policy.
 * @returns true when writes are advertised; false mounts memory read-only.
 */
export function memoryWritable(writePolicy: NonNullable<MemoryOptions['writePolicy']>, approval: ResolvedIoAgentOptions['approval']): boolean {
  return writePolicy === 'allow' || (writePolicy === 'ask' && approval === 'ask')
}

export async function mountMemory(ctx: Context, options: ResolvedIoAgentOptions): Promise<void> {
  if (options.memory === false) return
  const config = options.memory ?? {}
  const maxBytes = config.maxBytes ?? 12000, maxLines = config.maxLines ?? 120
  const writePolicy = config.writePolicy ?? 'ask'
  const writable = memoryWritable(writePolicy, approvalAnswerable(options) ? 'ask' : 'never')
  // Stored names from before io-agent: the namespace holds existing memories, and the section names are recorded
  // on every committed system prompt, which a resumed session keeps pinned.
  const namespace = 'pluto_memory_' + createHash('sha256').update(options.workspace).digest('hex')
  const lease = await SessionWriteLease.acquire(join(options.stateDirectory, 'memory-leases', namespace), SessionId(namespace))
  try {
    const spec = defineDomain({ name: namespace, version: 1,
      tables: { state: domainTable<string, MemorySnapshot>(snapshotSchema),
        snapshots: domainTable<string, MemorySnapshot>(snapshotSchema) } })
    const domain = await ctx.storage.domain.open(spec)
    ctx.effect(() => async () => { try { await domain.close() } finally { await lease.release() } })
    const state = domain.table('state'), snapshots = domain.table('snapshots')
    if (state.get('project') === undefined) await state.put('project', structuredClone(EMPTY))
    const project = (): MemorySnapshot => {
      const value = state.get('project')
      if (value === undefined) throw new Error('project memory state is missing')
      return value
    }
    // Read-only (no write can ever be granted): no tool and no curation guidance, only the entries.
    if (writable) ctx.systemPrompt.section({ name: 'pluto-memory-policy', order: 710, text: modelText('memory/guidance'), interpolate: false })
    ctx.on('agent/created', async ({ agent, signal }) => {
      signal?.throwIfAborted()
      let snapshot = snapshots.get(String(agent.id))
      if (snapshot === undefined) {
        snapshot = structuredClone(project())
        await snapshots.put(String(agent.id), snapshot)
      }
      signal?.throwIfAborted()
      if (!writable && Object.keys(snapshot.entries).length === 0) return
      const text = modelText(writable ? 'memory/snapshot' : 'memory/snapshot-read-only',
        { revision: snapshot.revision, entries: JSON.stringify(snapshot.entries) })
      agent.ctx.systemPrompt.section({ name: 'pluto-memory-snapshot', order: 720, text, interpolate: false })
    })
    // The exclusive lease means nothing else changes project memory while this runtime
    // runs, so without writes a `list` action would only repeat the snapshot.
    if (!writable) return
    ctx.tools.register(defineTool({
      name: 'memory', description: modelText('memory/description'),
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'put', 'delete'], description: modelText('memory/action') },
        key: { type: 'string', description: modelText('memory/key') }, value: { type: 'string', description: modelText('memory/value') },
        revision: { type: 'integer', description: modelText('memory/revision') },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: modelText('memory/result', { result: value }) }] },
      isConcurrencySafe: args => args.action === 'list',
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        if (exec.agent === undefined) throw INVALID(modelText('memory/no-agent'))
        if (args.action === 'list') return JSON.stringify(state.get('project'))
        if (exec.agent.session.header.parentSession !== undefined) throw new Error(modelText('memory/child-denied'))
        if (writePolicy === 'deny') throw new Error(modelText('memory/denied'))
        // Validate before prompting, then validate again atomically at the commit slot.
        const proposed = changeMemory(project(), args.action, args.key, args.value, args.revision, maxBytes, maxLines)
        if (writePolicy === 'ask') {
          const outcome = await ctx.approval.request({ agent: exec.agent, toolName: 'memory', callId: exec.callId,
            reason: modelText('memory/approval', { action: args.action, key: String(args.key),
              revision: proposed.revision - 1, value: args.value ?? '' }), signal: exec.signal })
          if (outcome !== 'allowed-once') throw new Error(modelText('memory/denied'))
        }
        exec.signal.throwIfAborted()
        const next = await state.update('project', (current) => {
          exec.signal.throwIfAborted()
          return changeMemory(current, args.action, args.key, args.value, args.revision, maxBytes, maxLines)
        })
        return JSON.stringify(next)
      },
    }))
  } catch (error) { await lease.release(); throw error }
}
