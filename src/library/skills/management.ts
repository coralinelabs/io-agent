/** Governed skill packages: one parser, one filesystem, one approval, conditional rollback. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '../runtime/vendor/cordis/index.ts'
import type { FileSystem, FsTarget, FsVersion, FsTextMutation } from '../filesystem/fs/index.ts'
import { FsSandboxController } from '../filesystem/tool-fs/sandbox.ts'
import type { ResolvedIoAgentOptions } from '../runtime/options.ts'
import { approvalAnswerable } from '../runtime/options.ts'
import { defineTool } from '../tools/index.ts'
import { parseSkillSource } from './filesystem/index.ts'
import { isSkillName } from './skill/index.ts'
import { modelText } from '../context/text/index.ts'

const MAX_FILES = 64, MAX_BYTES = 4 * 1024 * 1024, MAX_DIRECTORIES = 128
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
interface PackageFile { target: FsTarget; version: FsVersion; bytes: Uint8Array; hash: string }
export interface SkillPackageSnapshot { readonly revision: string | null; readonly files: ReadonlyMap<string, PackageFile> }
export interface SkillPackageOperation { readonly path: string; readonly content: string | null }
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
function invalid(code: string): never { throw new Error(modelText('skills/manage-invalid', { code })) }
function relativePath(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.includes('\\') && !value.includes('\0')
    && value.split('/').every(segment => segment.length > 0 && !segment.startsWith('.') && !segment.includes(':'))
}
export function validateBundleName(name: string): void {
  if (!relativePath(name) || name.split('/').length > 8 || !name.split('/').every(isSkillName)) invalid('BUNDLE_PATH')
}

/** Metadata plus content digests. Reads are bounded; links and special files are never followed. */
export async function inspectSkillPackage(fs: FileSystem, root: string, name: string, signal?: AbortSignal): Promise<SkillPackageSnapshot> {
  validateBundleName(name)
  const base = await fs.resolve(root, signal === undefined ? {} : { signal })
  const folder = join(root, ...name.split('/'))
  let ancestor = root
  for (const part of name.split('/')) {
    ancestor = join(ancestor, part)
    const info = await fs.lstat(ancestor, {}, signal)
    if (info !== undefined && info.type !== 'directory') invalid('BUNDLE_NOT_DIRECTORY')
  }
  const target = await fs.resolve(folder, signal === undefined ? {} : { signal })
  if (!fs.contains(base, target) || target.targetKey === base.targetKey) invalid('PATH_OUTSIDE_ROOT')
  if (await fs.stat(target, signal) === undefined) return { revision: null, files: new Map() }
  const files = new Map<string, PackageFile>()
  let bytes = 0, directories = 0
  const walk = async (directory: FsTarget, prefix: string): Promise<void> => {
    if (++directories > MAX_DIRECTORIES || prefix.split('/').length > 16) invalid('DIRECTORY_LIMIT')
    for (const entry of await fs.listDir(directory, signal)) {
      signal?.throwIfAborted()
      const path = prefix + entry.name
      if (!relativePath(path)) invalid('RESOURCE_PATH')
      const absolute = join(folder, ...path.split('/'))
      const info = await fs.lstat(absolute, {}, signal)
      if (info === undefined || !fs.contains(target, entry.target)) invalid('RESOURCE_CHANGED')
      if (info.type === 'directory') { await walk(entry.target, path + '/'); continue }
      if (info.type !== 'file') invalid('RESOURCE_NOT_REGULAR')
      if (files.size >= MAX_FILES) invalid('FILE_LIMIT')
      const value = await fs.readBytes(entry.target, signal, MAX_BYTES - bytes)
      const after = await fs.stat(entry.target, signal)
      if (after?.version !== info.version) invalid('RESOURCE_CHANGED')
      bytes += value.length
      files.set(path, { target: entry.target, version: info.version, bytes: value, hash: hash(value) })
    }
  }
  await walk(target, '')
  const pairs = [...files].map(([path, file]) => [path, file.hash]).sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0)
  return { revision: pairs.length ? hash(JSON.stringify(pairs)) : null, files }
}

/** Validate the complete proposed package before permission prompts or the first mutation. */
export function planSkillPackage(snapshot: SkillPackageSnapshot, operations: readonly SkillPackageOperation[], revision: string | null): Map<string, string | null> {
  if (revision !== snapshot.revision) invalid('REVISION_CONFLICT')
  if (!operations.length || operations.length > MAX_FILES) invalid('OPERATIONS_LIMIT')
  const changes = new Map<string, string | null>()
  const next = new Map([...snapshot.files].map(([path, file]) => [path, file.bytes]))
  for (const operation of operations) {
    if (!relativePath(operation.path) || changes.has(operation.path)) invalid('RESOURCE_PATH')
    if (operation.content !== null && (typeof operation.content !== 'string' || !operation.content.isWellFormed())) invalid('CONTENT_UTF8')
    if (operation.content === null) {
      if (!next.has(operation.path)) invalid('DELETE_MISSING')
      next.delete(operation.path)
    } else next.set(operation.path, new TextEncoder().encode(operation.content))
    changes.set(operation.path, operation.content)
  }
  if (next.size > MAX_FILES || [...next.values()].reduce((sum, value) => sum + value.length, 0) > MAX_BYTES) invalid('PACKAGE_LIMIT')
  if (next.size > 0) {
    const source = next.get('SKILL.md')
    if (source === undefined) invalid('SKILL_REQUIRED')
    const parsed = parseSkillSource(utf8.decode(source), 'SKILL.md')
    if (parsed === undefined || parsed.content.length === 0) invalid('SKILL_INVALID')
  }
  const names = [...next.keys()]
  if (names.some(a => names.some(b => a !== b && b.startsWith(a + '/')))) invalid('PATH_OVERLAP')
  // Mutations are text-only, so rollback can restore exact original UTF-8 bytes.
  for (const path of changes.keys()) {
    const file = snapshot.files.get(path)
    if (file !== undefined) utf8.decode(file.bytes)
  }
  return changes
}

/** No hidden automatic authoring. A configured host grants writes; children cannot edit their own future instructions. */
export function mountSkillManagement(ctx: Context, options: ResolvedIoAgentOptions): void {
  if (options.skills === false || !ctx.fs.supportsTextBatch) return
  const policy = options.skills?.writePolicy ?? 'ask'
  if (policy === 'deny' || (policy === 'ask' && !approvalAnswerable(options))) return
  const root = ctx.fs.processPathFromHostPath(join(options.userDirectory, 'skills'))
  if (root === undefined) return // This execution world cannot safely access the configured userspace.
  const sandbox = new FsSandboxController(ctx, approvalAnswerable(options))
  const queues = new Map<string, Promise<unknown>>()
  const exclusive = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const pending = (queues.get(key) ?? Promise.resolve()).then(run, run)
    const tail = pending.then(() => undefined, () => undefined); queues.set(key, tail)
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
    return pending
  }
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    agent.ctx.tools.register(defineTool({
      name: 'skill_manage', description: modelText('skills/manage-description'),
      parameters: {
        action: { type: 'string', required: true, enum: ['inspect', 'apply'], description: modelText('skills/manage-action') },
        name: { type: 'string', required: true, description: modelText('skills/manage-name') },
        revision: { oneOf: [{ type: 'string' }, { type: 'null' }], description: modelText('skills/manage-revision') },
        operations: { type: 'array', description: modelText('skills/manage-operations'), items: {
          type: 'object', additionalProperties: false, properties: {
            path: { type: 'string', required: true }, content: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          },
        } },
        ...sandbox.escalationModes.length ? sandbox.schemaFields() : {},
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      isConcurrencySafe: args => args.action === 'inspect',
      async execute(args, exec) {
        if (exec.agent !== agent || exec.agent.session.header.parentSession !== undefined) invalid('ROOT_ONLY')
        if (args.action === 'inspect') {
          if (args.operations !== undefined || args.revision !== undefined) invalid('INSPECT_ARGUMENTS')
          const snapshot = await inspectSkillPackage(ctx.fs, root, args.name, exec.signal)
          return JSON.stringify({ revision: snapshot.revision, files: [...snapshot.files].map(([path, file]) => ({ path, bytes: file.bytes.length, sha256: file.hash })) })
        }
        if (args.operations === undefined || args.revision === undefined) invalid('APPLY_ARGUMENTS')
        const operations = args.operations, revision = args.revision
        const observed = await inspectSkillPackage(ctx.fs, root, args.name, exec.signal)
        planSkillPackage(observed, operations, revision)
        if (policy === 'ask') {
          const grant = await ctx.approval.request({ agent, toolName: exec.name, callId: exec.callId, signal: exec.signal,
            reason: modelText('skills/manage-approval', { name: args.name, paths: JSON.stringify(operations.map(op => op.path)) }) })
          if (grant !== 'allowed-once') invalid('APPROVAL_DENIED')
        }
        const executionPolicy = await sandbox.resolvePolicy('skill_manage', args, exec)
        return exclusive(args.name, async () => {
          exec.signal.throwIfAborted()
          const snapshot = await inspectSkillPackage(ctx.fs, root, args.name, exec.signal)
          const planned = planSkillPackage(snapshot, operations, revision)
          const base = await ctx.fs.resolve(join(root, ...args.name.split('/')), { signal: exec.signal })
          const mutations: FsTextMutation[] = []
          // Publish SKILL.md last on creation; remove it first on deletion. This is not reader isolation or a crash-atomic directory swap.
          const ordered = [...planned].sort(([a, av], [b, bv]) => a === 'SKILL.md' ? (av === null ? -1 : 1) : b === 'SKILL.md' ? (bv === null ? 1 : -1) : a < b ? -1 : 1)
          for (const [path, content] of ordered) {
            const target = await ctx.fs.resolve(join(root, ...args.name.split('/'), ...path.split('/')), { signal: exec.signal })
            if (!ctx.fs.contains(base, target)) invalid('PATH_OUTSIDE_ROOT')
            const previous = snapshot.files.get(path)
            if (previous === undefined && await ctx.fs.stat(target, exec.signal) !== undefined) invalid('RESOURCE_CHANGED')
            mutations.push({ target, content, expected: previous === undefined ? { kind: 'absent' } : { kind: 'present', version: previous.version } })
            await ctx.serial('fs/before-change', target, exec)
          }
          // Host callbacks may await; revalidate package identity after all callbacks, before publication.
          const afterCallbacks = await inspectSkillPackage(ctx.fs, root, args.name, exec.signal)
          if (afterCallbacks.revision !== snapshot.revision) invalid('REVISION_CONFLICT')
          const result = await ctx.fs.applyTextBatch(mutations, exec.signal, executionPolicy)
          for (const change of result.changes) ctx.emit('fs/observed', change.target, change.version === undefined ? { kind: 'absent' } : { kind: 'present', version: change.version }, exec)
          const hashes = new Map([...snapshot.files].map(([path, file]) => [path, file.hash]))
          for (const [path, content] of planned) { if (content === null) hashes.delete(path); else hashes.set(path, hash(content)) }
          const nextRevision = hashes.size ? hash(JSON.stringify([...hashes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))) : null
          return JSON.stringify({ outcome: 'committed', revision: nextRevision, changed: result.changes.map(change => ({ path: change.target.displayPath, operation: change.after === null ? 'delete' : change.before === null ? 'create' : 'update' })) })
        })
      },
    }))
  })
}
