import { mountLanguageServers } from '../library/integrations/code-intelligence.ts'
import { mountExternalAgent } from '../library/integrations/external-agents.ts'
import { mountSkillManagement } from '../library/skills/management.ts'
/** Complete headless composition derived from dsh-base; no launcher or UI lifecycle. */
import type { Context } from "../library/runtime/vendor/cordis/index.ts"
import { join, resolve } from 'node:path'
import { modelText } from "../library/context/text/index.ts"
import { approvalAnswerable } from "../library/runtime/options.ts"
import type { ResolvedIoAgentOptions } from "../library/runtime/options.ts"
import { mountMemory } from "../library/context/memory.ts"
import Timer from "../library/runtime/vendor/timer/index.ts"
import Llm from "../library/model/llm/index.ts"
import Session from "../library/session/journal/index.ts"
import SessionTitle from "../library/session/title/index.ts"
import UserQuestions from "../library/interaction/user-questions/index.ts"
import Agent from "../library/runtime/agents/index.ts"
import AgentDefaultModel from "../library/runtime/agent-default-model/index.ts"
import Jobs from "../library/execution/jobs/jobs-local/index.ts"
import Background from "../library/execution/jobs/background/index.ts"
import * as LlmRetry from "../library/model/retry/index.ts"
import * as Router from "./router.ts"
import SessionPersistenceJsonl from "../library/session/persistence-jsonl/index.ts"
import AttachmentLocal from "../library/context/attachments/attachment-local/index.ts"
import SessionQuery from "../library/session/query/query/index.ts"
import SqliteSessionQuery from "../library/session/query/query-sqlite/index.ts"
import * as ToolRecall from "../library/session/tool-recall/index.ts"
import * as ToolSearchMemory from "../library/session/tool-search-memory/index.ts"
import SessionProjection from "../library/session/projection/index.ts"
import Storage from "../library/storage/storage/index.ts"
import * as StorageJson from "../library/storage/json/index.ts"
import * as StorageDomain from "../library/storage/domain/index.ts"
import SessionProjectionCache from "../library/session/projection-cache/index.ts"
import Subprocess from "../library/execution/process/subprocess-local/index.ts"
import Sandbox from "../library/execution/sandbox/sandbox-local/index.ts"
import SandboxPolicy from "../library/execution/sandbox/sandbox-policy/index.ts"
import BashSandbox from "../library/execution/shell/bash-sandbox/index.ts"
import PwshSandbox from "../library/execution/shell/pwsh-sandbox/index.ts"
import Approval from "../library/interaction/user-approval/index.ts"
import Permission from "../library/interaction/permission-presets/index.ts"
import * as ShellEnv from "../library/execution/shell/shell-env/index.ts"
import * as ToolBash from "../library/execution/shell/tool-bash/index.ts"
import * as ToolPwsh from "../library/execution/shell/tool-pwsh/index.ts"
import * as ToolJobs from "../library/execution/jobs/tool-jobs/index.ts"
import * as ToolWatch from "../library/execution/jobs/tool-watch/index.ts"
import * as FsObservationPolicy from "../library/filesystem/fs-observation-policy/index.ts"
import * as ToolFs from "../library/filesystem/tool-fs/index.ts"
import * as ToolFsSearch from "../library/filesystem/tool-fs-search/index.ts"
import * as AgentInstructions from "../library/context/agent-instructions/index.ts"
import Skill from "../library/skills/skill/index.ts"
import * as SkillFilesystem from "../library/skills/filesystem/index.ts"
import * as ToolSkill from "../library/skills/tool-skill/index.ts"
import { injectedSkillName, loadedSkillName } from "../library/skills/tool-skill/history.ts"
import Commands from "../library/interaction/commands/index.ts"
import Goal from "../library/tasks/goal/index.ts"
import * as GoalRoundDriver from "../library/tasks/goal-round-driver/index.ts"
import * as CommandGoal from "../library/tasks/command-goal/index.ts"
import PlanMode from "../library/tasks/plan-mode/index.ts"
import TokenMeter from "../library/model/token-meter/index.ts"
import CompactionBasic from "../library/context/compaction/policy.ts"
import type { CheckpointRange } from "../library/context/compaction/basic/index.ts"
import type { Session as JournalSession } from "../library/session/journal/index.ts"
import * as CommandCompact from "../library/context/compaction/command-compact/index.ts"
import Subagent from "../library/agents/subagent/index.ts"
import * as SubagentSpawnInProcess from "../library/agents/spawn-in-process/index.ts"
import * as SubagentForkInProcess from "../library/agents/fork-in-process/index.ts"
import * as ToolSubagentControl from "../library/agents/tool-subagent-control/index.ts"
import * as ToolSubagentListAgents from "../library/agents/tool-subagent-control/list-agents.ts"
import * as ToolSubagent from "../library/agents/tool-subagent/index.ts"
import PtcRuntime from "../library/execution/workers/ptc-runtime-node/index.ts"
import WorkflowPtc from "../library/workflow/workflow-ptc/index.ts"
import * as ToolWorkflow from "../library/workflow/tool-workflow/index.ts"
import * as TimeoutPolicy from "../library/policy/timeout-policy/index.ts"
import SpillLocal from "../library/output/local/index.ts"
import * as SpillPolicy from "../library/output/policy/index.ts"
import { toolOutputBudget } from "../library/output/policy/budget.ts"
import * as SessionCheckpointPolicy from "../library/session/checkpoint-policy/index.ts"
import ToolResultPruner from "../library/context/compaction/tool-result-pruner/index.ts"
import { recallCheckpointLog, recallLogPointer, toolResultPrunerConfig } from "./tool-results.ts"
import * as ImageOffload from "../library/context/compaction/image-offload/index.ts"
import * as ToolTodo from "../library/tasks/tool-todo/index.ts"
import { writtenTodoList } from "../library/tasks/tool-todo/list.ts"
import * as ToolGoal from "../library/tasks/tool-goal/index.ts"
import Web from "../library/web/web/index.ts"
import * as WebFetchHttp from "../library/web/web-fetch-http/index.ts"
import * as ToolWeb from "../library/web/tool-web/index.ts"
import * as McpClient from "../library/mcp/mcp-client/index.ts"
import McpResources from "../library/mcp/mcp-resources/index.ts"
import Tools from "../library/tools/index.ts"
import SystemPrompt from "../library/context/assembly/index.ts"
import AgentLoop from './runtime.ts'
import FsSandbox from "../library/filesystem/fs-sandbox/index.ts"
import ContinuedQuestions from "../library/interaction/continued/index.ts"
import * as ToolAskUser from "../library/interaction/tool-ask-user/index.ts"
import { mountQuestionAvailability } from "../library/interaction/questions.ts"
import { mountSkillAvailability } from "../library/skills/tool-skill/availability.ts"
import { MAX_TIMER_DELAY_MS } from "../library/util/timeout/index.ts"

/**
 * The deadline of a call that has none: the longest timer Node arms (about 24.8 days). Tool calls,
 * web fetches and MCP calls run as long as they need; a dead server is caught by its transport's
 * own failure (connection errors, undici's 300 s header and body silence), not by a guessed budget.
 */
const NO_DEADLINE = MAX_TIMER_DELAY_MS

/** Register the full dependency graph before awaiting activation (Cordis resolves service order). */
export async function mountRuntime(ctx: Context, options: ResolvedIoAgentOptions): Promise<void> {
  // The summary may use the model's whole output budget: reasoning spends from the same cap, and at 8,192 tokens a
  // summary written at the connection's effort was cut off.
  const summaryBudget = options.connection.maxTokens
  const skills = options.skills === false ? undefined : options.skills ?? {}
  const recall = options.recall === false ? undefined : options.recall ?? {}
  const outputBudget = toolOutputBudget(options.connection.contextWindow)
  // Recall pointers (a pruned stub's, a checkpoint's) are shown only to an agent that can call recall;
  // a subagent whose allowed_tools omit it keeps the generic session-log wording and no checkpoint pointer.
  const recallVisible = (session: JournalSession): boolean => {
    const agent = ctx.agents.get(session.id)
    return agent !== undefined && ctx.tools.get('recall', agent) !== undefined
  }
  // Advertise only what this runtime can use, decided once here (or per session at creation).
  // Escalation needs an approval that can ask and a host that answers; read_image needs a route that takes images.
  // Per runtime: a session switched to an asking preset later (/permission) keeps this surface.
  const escalation = approvalAnswerable(options)
  const readImage = options.connection.profile.models?.[0]?.input?.includes('image') === true
  const fibers = [
    ctx.plugin(Timer),
    ctx.plugin(Llm),
    ctx.plugin(Session),
    ctx.plugin(SessionTitle, { 'fallbackMaxWords': 5, 'fallbackMaxBytes': 40, 'maxTitleBytes': 80 }),
    ctx.plugin(UserQuestions),
    ctx.plugin(ContinuedQuestions),
    ctx.plugin(Agent),
    ctx.plugin(AgentDefaultModel, { provider: options.connection.route, model: options.connection.model }),
    ctx.plugin(Jobs),
    // Background work owned by sessions, recorded on disk: durable bash jobs that outlive this
    // process and watchers that wake an agent once. POSIX only (the durable wrapper is sh).
    ...(process.platform === 'win32' ? [] : [ctx.plugin(Background, { ...options.background, root: join(options.stateDirectory, 'background') })]),
    ctx.plugin(LlmRetry),
    ctx.plugin(Router, options.connection),
    ctx.plugin(SessionPersistenceJsonl, { root: join(options.stateDirectory, 'sessions') }),
    ctx.plugin(AttachmentLocal, { dshHome: options.stateDirectory }),
    // Full-text recall swaps in the optional FTS5 engine (a subclass of the same query service); literal recall needs no index.
    recall?.fullText === true
      ? ctx.plugin(SqliteSessionQuery, { path: join(options.stateDirectory, 'session-index.sqlite'), openAt: 'first-search' })
      : ctx.plugin(SessionQuery),
    ctx.plugin(SessionProjection),
    ctx.plugin(Storage),
    ctx.plugin(StorageJson, { root: join(options.stateDirectory, 'storages') }),
    ctx.plugin(StorageDomain, { 'backend': 'json' }),
    ctx.plugin(SessionProjectionCache, { 'writeEveryEvents': 200, 'writeIntervalMs': 5000 }),
    ctx.plugin(Subprocess),
    ctx.plugin(Sandbox),
    ctx.plugin(SandboxPolicy, { mode: options.sandbox, workspaceRoot: options.workspace }),
    // A command still running after the 60 s default wait continues as a background job; a model's
    // own timeoutMs is a kill deadline it chose, not clamped below the timer limit.
    ...(process.platform === 'win32' ? [] : [ctx.plugin(BashSandbox, { 'timeoutMs': 60000, 'maxTimeoutMs': NO_DEADLINE })]),
    // PowerShell shares bash's default wait/background handoff; explicit timeouts remain kill deadlines.
    ...(process.platform !== 'win32' ? [] : [ctx.plugin(PwshSandbox, { timeoutMs: 60000, maxTimeoutMs: NO_DEADLINE })]),
    ctx.plugin(Approval, { policy: options.approval, escalation }),
    ctx.plugin(Permission, { 'presets': { 'read-only': { 'sandbox': 'read-only', 'approval': 'ask' }, 'workspace-write': { 'sandbox': 'workspace-write', 'approval': 'ask' }, 'danger-full-access': { 'sandbox': 'danger-full-access', 'approval': 'never' } } }),
    ctx.plugin(ShellEnv, { userDirectory: options.userDirectory }),
    ...(process.platform === 'win32' ? [] : [ctx.plugin(ToolBash, { escalation })]),
    ...(process.platform !== 'win32' ? [] : [ctx.plugin(ToolPwsh, { escalation })]),
    // No wake budget: an agent woken by its own background work keeps being woken, however many times in a row. The
    // budget of 3 came from DeepSeek Harness, an attended app guarding a person's API spend; Io's agents run unattended.
    ctx.plugin(ToolJobs, { maxConsecutiveWakes: Number.MAX_SAFE_INTEGER }),
    ...(process.platform === 'win32' ? [] : [ctx.plugin(ToolWatch)]),
    ctx.plugin(FsObservationPolicy),
    // A read without limit is a 16 KB window; an explicit limit still reads up to 50 KB.
    ctx.plugin(ToolFs, { readUnchangedNotice: true, readDefaultMaxBytes: 16384, readImage, escalation }),
    ctx.plugin(ToolFsSearch, { 'sampleOverCapGlobResults': false, timeoutMs: NO_DEADLINE }),
    ctx.plugin(AgentInstructions, { dshHome: options.userDirectory, maxBytes: 65536, requireBeforeWrite: true, localInstructionFileCandidates: ['AGENTS.local.md', 'CLAUDE.local.md', 'AGENTS.override.md'] }),
    ctx.plugin(Skill),
    ...(skills === undefined ? [] : [
      ctx.plugin(SkillFilesystem, {
        // Workspace roots are the project tier; root order alone keeps .pluto > .agents > explicit > user.
        // `.pluto/skills` keeps its name from before io-agent: it is a directory in people's projects.
        projectSkillDirs: [join(options.workspace, '.pluto/skills'), join(options.workspace, '.agents/skills')],
        customSkillDirs: [...skills.directories?.map(path => resolve(options.workspace, path)) ?? [], join(options.userDirectory, 'skills')],
        watch: skills.watch ?? true,
        discoveryMaxDepth: skills.discoveryMaxDepth ?? 4,
        discoveryMaxDirectories: skills.discoveryMaxDirectories ?? 512,
        metadataMaxBytes: skills.metadataMaxBytes ?? 16384,
        maxSourceBytes: skills.maxSourceBytes ?? 262144,
      }),
      ctx.plugin(ToolSkill, { progressive: true, catalogMaxEntries: skills.catalogMaxEntries ?? 100,
        catalogDescriptionMaxLength: skills.catalogDescriptionMaxLength ?? 120,
        catalogMaxBytes: skills.catalogMaxBytes ?? 12288, maxSkillBytes: skills.maxSkillBytes ?? 65536 }),
    ]),
    ctx.plugin(Commands),
    ctx.plugin(Goal),
    ctx.plugin(GoalRoundDriver),
    ctx.plugin(CommandGoal),
    ctx.plugin(PlanMode, { section: modelText('system/plan-mode') }),
    ctx.plugin(TokenMeter),
    // Deterministic checkpoint sections beside the summary: verbatim user messages (the first one always kept),
    // the current todo list, skills whose instructions left the context, and exact identifiers; about 6K tokens
    // at most. The skill and todo owners supply the readers, so compaction never parses their formats.
    // Idle prune: past the presumed cache lifetime the next request misses anyway.
    ctx.plugin(CompactionBasic, { maxTokens: summaryBudget, headroomTokens: options.compactionHeadroomTokens ?? 0, checkpoint: { userMessageBytes: 16384, firstUserMessageMaxBytes: 8192,
      userMessageMaxBytes: 4096, anchorBytes: 4096, maxSkills: 20, maxTodoItems: 50 },
      checkpointReaders: { skillLoad: loadedSkillName, skillInjection: injectedSkillName, todoList: writtenTodoList },
      ...recall === undefined ? {} : {
        checkpointLogPointer: (range: CheckpointRange, session: JournalSession) => recallVisible(session) ? recallCheckpointLog(range) : undefined,
      },
      ...options.connection.promptCacheTtlMs > 0 ? { coldCachePruneAfterMs: options.connection.promptCacheTtlMs } : {} }),
    ctx.plugin(CommandCompact),
    ctx.plugin(Subagent),
    ctx.plugin(SubagentSpawnInProcess, { 'providerName': 'spawn' }),
    ctx.plugin(SubagentForkInProcess, { 'providerName': 'fork' }),
    ctx.plugin(ToolSubagentControl),
    ctx.plugin(ToolSubagentListAgents),
    ctx.plugin(ToolSubagent, { 'provider': 'spawn', 'toolName': 'subagent', 'backgroundMode': 'continuable' }),
    ctx.plugin(ToolSubagent, { 'provider': 'fork', 'toolName': 'subagent_fork', 'backgroundMode': 'one-shot' }),
    ctx.plugin(PtcRuntime),
    ctx.plugin(WorkflowPtc, { 'provider': 'spawn' }),
    ctx.plugin(ToolWorkflow),
    ctx.plugin(TimeoutPolicy),
    ctx.plugin(SpillLocal, { root: join(options.stateDirectory, 'spill') }),
    // Window-scaled threshold, 4 KB preview and per-step budget; `skill` bodies and paged reads stay whole.
    ctx.plugin(SpillPolicy, { ...outputBudget, boundOnSaveFailure: true,
      exemptTools: ['read', 'skill', 'skill_read'] }),
    ctx.plugin(SessionCheckpointPolicy),
    // Newest 5 tool groups verbatim, older ones one-line stubs, skill bodies marked after 10 groups (./tool-results.ts).
    // While `recall` is visible to a session's agent, a stub names the recall call that returns the full result.
    ctx.plugin(ToolResultPruner, toolResultPrunerConfig(recall === undefined ? undefined
      : (seq, session) => recallVisible(session) ? recallLogPointer(seq) : undefined)),
    ctx.plugin(ImageOffload),
    ctx.plugin(ToolTodo, { 'allowParallelInProgress': true }),
    ctx.plugin(ToolGoal),
    // A recall page stops at the spill threshold, so multi-byte history is paged, never spilled to a preview.
    ...(recall === undefined ? [] : [ctx.plugin(ToolRecall, { search: recall.fullText === true ? 'full-text' : 'literal',
      maxOutputBytes: outputBudget.maxInlineBytes })]),
    // Earlier conversations of this workspace, reasoning included: a literal scan, so no index is needed.
    ...(recall?.memory === true ? [ctx.plugin(ToolSearchMemory, { maxOutputBytes: outputBudget.maxInlineBytes })] : []),
    ctx.plugin(Web, { ...(options.webSearchProvider === undefined ? {} : { searchProvider: options.webSearchProvider }), fetchProvider: 'http' }),
    ctx.plugin(WebFetchHttp, { timeoutMs: NO_DEADLINE }),
    ctx.plugin(ToolWeb, { fetch: true, search: options.webSearchProvider !== undefined, fetchTimeoutMs: NO_DEADLINE, searchTimeoutMs: NO_DEADLINE }),
    ctx.plugin(McpResources),
    // MCP schemas above 20 tools or 16 KB are served on demand behind fixed bridges; core tools stay eager.
    ctx.plugin(Tools, { deferral: options.mcpToolSearch === false ? false : {
      maxEagerTools: options.mcpToolSearch?.maxEagerTools ?? 20,
      maxEagerSchemaBytes: options.mcpToolSearch?.maxEagerSchemaBytes ?? 16384,
    } }),
    ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: modelText('system/io-agent-identity') + '\n\n' + modelText('system/coding-persona'), personaSuffix: modelText('system/workspace-persona') }),
    // A response cut off at the output limit continues up to twice at the same budget.
    ctx.plugin(AgentLoop, { agents: [], outputLimitRecoveries: 2 }),
    ctx.plugin(FsSandbox),
  ]
  await Promise.all(fibers.map(fiber => fiber.await()))
  // The question tool captures whether durable continued questions are available.
  // Register it only after that service has completed activation.
  await ctx.plugin(ToolAskUser).await()
  // Section names are recorded on committed system prompts, so this one keeps its name from before io-agent.
  ctx.systemPrompt.section({ name: 'pluto-verification-discipline', order: 730, text: modelText('verification/discipline'), interpolate: false })
  await mountMemory(ctx, options)
  mountSkillManagement(ctx, options)
  await Promise.all((options.mcp ?? []).map(async (server) => {
    // The mount barrier: every server's first connect and tools/list finish
    // before any session exists, so the first request carries the final MCP
    // tool set. No io-agent startup bound; `startupTimeoutMs` is opt-in.
    const config = { ...server, failOnStartupError: server.failOnStartupError ?? true, toolCallTimeoutMs: server.toolCallTimeoutMs ?? NO_DEADLINE,
      ...(server.transport === 'stdio' ? { cwd: server.cwd ?? options.workspace } : {}) }
    await ctx.plugin(McpClient, config).await()
  }))
  // Extensions see a ready runtime, including memory; they never race service activation.
  for (const agent of options.externalAgents ?? []) await mountExternalAgent(ctx, agent)
  if (options.languageServers) await mountLanguageServers(ctx, options.languageServers)
  await options.configure?.(ctx)
  mountQuestionAvailability(ctx)
  // A session that starts without skills is offered no skill tools (decided at its creation, never mid-session).
  if (skills !== undefined) mountSkillAvailability(ctx)
}
