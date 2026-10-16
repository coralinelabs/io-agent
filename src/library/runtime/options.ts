import type { LanguageServerOptions } from '../integrations/code-intelligence.ts'
import type { ExternalAgentOptions } from '../integrations/external-agents.ts'
/** Library configuration has no implicit process-global model selection or application profile. */
import type { Context } from "./vendor/cordis/index.ts"
// Public configure() services must carry their declaration augmentations into an isolated consumer.
import "../filesystem/fs/index.ts"
import "../skills/skill/index.ts"
import "../execution/shell/shell-env/index.ts"
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SandboxMode } from "../execution/sandbox/sandbox/index.ts"
import type { ApprovalOutcome, ApprovalRequest, ApprovalPolicy } from "../interaction/user-approval/index.ts"
import type { AskUserQuestionRequest, AskUserQuestionAnswer } from "../interaction/user-questions/index.ts"
import { nonempty, resolveConnection } from "../model/connection.ts"
import type { ModelConnection, ResolvedConnection } from "../model/connection.ts"
import type { ModelRequestObserver } from "../model/inspection.ts"
import type { ConfigInput as McpServerOptions } from "../mcp/mcp-client/index.ts"
export type { ConfigInput as McpServerOptions } from "../mcp/mcp-client/index.ts"
import type { MemoryOptions } from "../context/memory.ts"

/** Bounded, explicitly rooted skill discovery. No ambient home or bundled-root variables are read. */
export interface IoAgentSkillOptions {
  /** Governed userspace skill-package mutation. Default ask; no write tool without an answerer. */
  writePolicy?: 'ask' | 'allow' | 'deny' 
  /** Additional roots, relative to the workspace when not absolute. */
  directories?: readonly string[]
  watch?: boolean
  discoveryMaxDepth?: number
  discoveryMaxDirectories?: number
  /** Session catalog preview entries; default 100. skill_list still searches every skill. */
  catalogMaxEntries?: number
  /** Session catalog description length in characters; default 120, 3 through 1000. */
  catalogDescriptionMaxLength?: number
  catalogMaxBytes?: number
  maxSkillBytes?: number
  metadataMaxBytes?: number
  maxSourceBytes?: number
}

/** History recall over the session journal (the model-facing `recall` tool). */
export interface IoAgentRecallOptions {
  /**
   * Answer `query` searches from the optional SQLite FTS5 index (stateDirectory/session-index.sqlite,
   * opened on first search) instead of scanning literally. node:sqlite is experimental, so this is opt-in.
   */
  fullText?: boolean
  /**
   * Also offer `search_memory`: a literal search over every conversation (root session) of this
   * workspace, the model's reasoning included, and a reader for one entry of any of them.
   */
  memory?: boolean
}

/**
 * On-demand MCP tool schemas. Above either threshold the MCP schemas leave the tool list and the model
 * reaches them through fixed `tool_search` / `tool_describe` / `tool_call` tools plus a runtime-context
 * catalog; at or below both, the tool list is exactly as without this option.
 */
export interface IoAgentMcpToolSearchOptions {
  /** Most MCP tools presented eagerly (default 20); 0 always defers them. */
  maxEagerTools?: number
  /** Most MCP wire-schema bytes presented eagerly (default 16384, about 4K tokens). */
  maxEagerSchemaBytes?: number
}

/** A structured file mutation about to be applied (see {@link IoAgentOptions.onFileChange}). */
/**
 * Tuning for background work that outlives a turn: durable commands and watchers (POSIX only).
 * Every watcher has a deadline; these bound and default it.
 */
export interface IoAgentBackgroundOptions {
  /** Most armed watchers one session may hold. Default 32. */
  maxWatchersPerSession?: number
  /** Deadline of a watcher whose call names none, in ms. Default 60 minutes. */
  defaultWatchMs?: number
  /** Longest deadline a watcher may have, in ms. Default 7 days. */
  maxWatchMs?: number
  /** Longest wait between two checks of an armed watcher, which bounds how late a clock jump is noticed, in ms. Default 15 s. */
  recheckMs?: number
  /** How long ended jobs and settled watchers are listed after the agent took them in, in ms. Default 7 days. */
  retainMs?: number
}

export interface FileChange {
  /** Session of the agent making the change: a delegated child's own session, not its root's. */
  sessionId?: string
  /** The tool call making the change. */
  callId: string
  /** The tool making the structured change (`write`, `edit`, or `skill_manage`). */
  tool: string
  /** Absolute host paths about to change; a path may not exist yet (a create). */
  paths: string[]
}

export interface IoAgentOptions {
  /** Optional installed native Claude/Codex agents; each has a separate, explicitly selected permission policy. */
  externalAgents?: readonly ExternalAgentOptions[]
  /** Optional host-configured language servers for precise read-only code navigation. */
  languageServers?: LanguageServerOptions
  /**
   * Explicit trusted MCP servers, connected before any session exists so the
   * first request already carries their tools. Startup failures are fatal by
   * default and stdio cwd defaults to workspace. Startup has no bound of its
   * own beyond the MCP SDK's per-request timeouts (60 s on `initialize` and on
   * each `tools/list` page); set `startupTimeoutMs` to cap the wait.
   */
  mcp?: readonly McpServerOptions[]
  /** On-demand MCP tool schemas above a count or byte threshold. false keeps every MCP tool schema eager. */
  mcpToolSearch?: false | IoAgentMcpToolSearchOptions
  /** Project .pluto/.agents skill roots, explicit roots, then userDirectory/skills; no other root. false removes the skill surface. */
  skills?: false | IoAgentSkillOptions
  /** Awaited model-boundary audit; receives sensitive context but no transport credentials. */
  onModelRequest?: ModelRequestObserver
  /** Extra input working room reserved by automatic compaction, in tokens. Default 0.
   * The actual model-request output cap is reserved separately; uncapped routes remain uncapped. */
  compactionHeadroomTokens?: number
  /** Curated project memory; default asks for each mutation. false removes tool and context. */
  memory?: false | MemoryOptions
  /** Read-only `recall` tool over this session's journal (by seq, range or text). false removes the tool. */
  recall?: false | IoAgentRecallOptions
  /** Background commands and watchers (see {@link IoAgentBackgroundOptions}). */
  background?: IoAgentBackgroundOptions
  workspace: string
  /** Dedicated persistent state directory. No default ~/.dsh or ambient profile settings. */
  stateDirectory: string
  /** User-managed AGENTS.md and skills/. Defaults to stateDirectory for compatibility. */
  userDirectory?: string
  model: ModelConnection
  sandbox?: SandboxMode
  approval?: ApprovalPolicy
  onApproval?: (request: ApprovalRequest) => Promise<ApprovalOutcome>
  /** Advertised only to root agents with this callback or a matching configure()-registered responder. */
  onQuestion?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>
  /**
   * Awaited before a structured `write`, `edit`, or `skill_manage` mutation changes files, so a host can record their prior content
   * (for an undo it owns). A rejection fails that tool call before anything is written. Shell commands
   * are not covered.
   */
  onFileChange?: (change: FileChange) => void | Promise<void>
  /** Optional registered web-search route. No route means no advertised search tool. */
  webSearchProvider?: string
  /** Trusted extension point after built-ins are ready and before agents exist; question availability follows its creation listeners. */
  configure?: (context: Context) => void | Promise<void>
}

/**
 * Whether this runtime can grant anything that needs approval: its policy asks
 * and a host answers (`onApproval`). With no answerer every ask fails closed,
 * so, as under `'never'`, nothing approval-gated (escalation, approved memory
 * writes) is advertised.
 * @param options - the resolved options.
 * @returns true when an approval can be granted.
 */
export function approvalAnswerable(options: Pick<ResolvedIoAgentOptions, 'approval' | 'onApproval'>): boolean {
  return options.approval === 'ask' && options.onApproval !== undefined
}

export interface ResolvedIoAgentOptions extends Omit<IoAgentOptions, 'model' | 'sandbox' | 'approval' | 'userDirectory'> {
  userDirectory: string
  connection: ResolvedConnection
  sandbox: SandboxMode
  approval: ApprovalPolicy
}

export async function resolveOptions(options: IoAgentOptions): Promise<ResolvedIoAgentOptions> {
  if (options.skills !== undefined && options.skills !== false) {
    for (const [key, value] of Object.entries(options.skills)) {
      if (key === 'writePolicy') {
        if ((typeof value !== 'string' || !['ask', 'allow', 'deny'].includes(value))) throw new TypeError('invalid skill write policy')
      } else if (key === 'directories') {
        if (!Array.isArray(value) || value.some(path => typeof path !== 'string' || path.trim() === '')) throw new TypeError('invalid skill directories')
      } else if (key === 'watch') {
        if (typeof value !== 'boolean') throw new TypeError('invalid skill watch option')
      } else {
        const minimum = key === 'catalogMaxEntries' || key === 'discoveryMaxDepth' || key === 'discoveryMaxDirectories' ? 1 : key === 'catalogDescriptionMaxLength' ? 3 : key === 'catalogMaxBytes' ? 2048 : key === 'maxSkillBytes' ? 1024 : 256
        const maximum = key === 'discoveryMaxDepth' ? 32 : key === 'discoveryMaxDirectories' ? 10000 : key === 'catalogDescriptionMaxLength' ? 1000 : 16_777_216
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`invalid skill limit: ${key}`)
      }
    }
  }
  if (options.memory !== undefined && options.memory !== false) {
    const { writePolicy = 'ask', maxBytes = 12000, maxLines = 120 } = options.memory
    if (!['ask', 'allow', 'deny'].includes(writePolicy)) throw new TypeError('invalid memory write policy')
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > 65536 || !Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 1000) throw new TypeError('invalid memory limits')
  }
  if (options.recall !== undefined && options.recall !== false) {
    if (typeof options.recall !== 'object' || options.recall === null) throw new TypeError('invalid recall options')
    for (const [key, value] of Object.entries(options.recall)) {
      if ((key !== 'fullText' && key !== 'memory') || typeof value !== 'boolean') throw new TypeError(`invalid recall option: ${key}`)
    }
  }
  if (options.mcpToolSearch !== undefined && options.mcpToolSearch !== false) {
    if (typeof options.mcpToolSearch !== 'object' || options.mcpToolSearch === null) throw new TypeError('invalid mcpToolSearch options')
    for (const [key, value] of Object.entries(options.mcpToolSearch)) {
      if ((key !== 'maxEagerTools' && key !== 'maxEagerSchemaBytes') || typeof value !== 'number'
        || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid mcpToolSearch option: ${key}`)
    }
  }
  for (const [key, value] of Object.entries(options.background ?? {})) {
    if (!['maxWatchersPerSession', 'defaultWatchMs', 'maxWatchMs', 'recheckMs', 'retainMs'].includes(key)) throw new TypeError(`unknown background option ${key}`)
    if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (key === 'retainMs' ? 0 : 1))) {
      throw new TypeError(`invalid background option ${key}`)
    }
  }
  nonempty('workspace', options.workspace)
  nonempty('stateDirectory', options.stateDirectory)
  if (options.userDirectory !== undefined) nonempty('userDirectory', options.userDirectory)
  const { model, ...host } = options
  const connection = resolveConnection(model)
  if (options.compactionHeadroomTokens !== undefined
    && (!Number.isSafeInteger(options.compactionHeadroomTokens) || options.compactionHeadroomTokens < 0
      || options.compactionHeadroomTokens >= connection.contextWindow - (model.outputCap === false ? 0 : model.maxTokens))) {
    throw new TypeError('compactionHeadroomTokens must be a non-negative integer smaller than available input capacity')
  }
  const workspace = await realpath(resolve(options.workspace))
  if (!(await stat(workspace)).isDirectory()) throw new TypeError('workspace must be a directory')
  const sandbox = options.sandbox ?? 'workspace-write'
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) throw new TypeError('invalid sandbox mode')
  const approval = options.approval ?? 'ask'
  if (!['ask', 'never'].includes(approval)) throw new TypeError('invalid approval policy')
  return { ...host, ...(options.mcp === undefined ? {} : { mcp: structuredClone(options.mcp) }),
    ...(options.recall === undefined || options.recall === false ? {} : { recall: { ...options.recall } }),
    ...(options.background === undefined ? {} : { background: { ...options.background } }),
    ...(options.mcpToolSearch === undefined || options.mcpToolSearch === false ? {} : { mcpToolSearch: { ...options.mcpToolSearch } }),
    ...(options.skills === undefined || options.skills === false ? {} : { skills: { ...options.skills,
      ...(options.skills.directories === undefined ? {} : { directories: [...options.skills.directories] }) } }),
    workspace, stateDirectory: resolve(options.stateDirectory), userDirectory: resolve(options.userDirectory ?? options.stateDirectory),
    connection, sandbox, approval }
}
