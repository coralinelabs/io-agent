/**
 * Product-neutral host API (`@coralinelabs/io-agent/host`): one embedded engine behind sessions, fenced
 * activities, typed interactions, durable history, session management and a versioned HostEvent
 * vocabulary. Importing it starts no server or agent.
 */
export { Host, createHost } from './host.ts'
export { HostError } from './validation.ts'
export { HOST_EVENT_VERSION } from './types.ts'
export { SEQ_BLOCK, journalCursor } from './events.ts'
export { mountMcpServer } from './mcp.ts'
export { pendingBackgroundWork } from './background.ts'
// an embedder keeps a person's secrets out of every session: redactors apply as each event is appended
export { redactJournal, redactText } from '../session/journal/index.ts'
export type { Redactor } from '../session/journal/index.ts'
export type { ShellEnvSource } from '../execution/shell/shell-env/index.ts'
export type { McpServerMount } from './mcp.ts'
export type { McpServerOptions } from '../runtime/options.ts'
export type { ModelConnection, ReasoningEffort, ReasoningReplay } from '../model/connection.ts'
export type { ToolDefinition, ToolRunContext, ToolExecutionResult, ToolCallView, ToolResultView } from '../tools/index.ts'
export type { JsonSchemaNode } from '../tools/json-schema.ts'
export type { JsonValue } from '../util/values/index.ts'
export { defineTool } from '../tools/index.ts'
export type { ActivityView, ApprovalDecision, BackgroundChange, BackgroundView, DeleteAllResult, HostBackgroundJob, HostWakeup, HostWatcher, HostDiff, HostEndReason, HostErrorCode, HostEvent, HostEventBody, HostFailure,
  HostEngineOptions, HostFileChange, HostFileView, HostImage, HostInput, HostLocation, HostOptions, LegacyHostOptions, HostPromptBlock, HostToolKind, InteractionCloseReason,
  InteractionReply, InteractionRequest, QuestionAnswer, QuestionRequest, SearchHit, SessionHistory, SessionStatus,
  SessionSummary, SessionView, SteerSubmission, SteerReceipt, SteerLookup, TurnReceipt, TurnLookup, TurnSubmission, TurnOptions } from './types.ts'

export type { JobOutputCursor, JobOutputOptions, JobOutputPage } from '../execution/jobs/jobs/index.ts'
