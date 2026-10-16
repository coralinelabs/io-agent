/**
 * The model-facing `workflow` tool: run a JavaScript orchestration script that fans out
 * subagents, and return the script's final value. It owns the model-facing schema and run lifecycle; script
 * parsing, execution, caps, and cancellation live behind `ctx.workflowEngine`
 * (`io-agent/workflow`), so a hardened engine swaps in without touching what the model
 * sees. Execution awaits `run.result` and always disposes the run; non-completed reasons become tool
 * errors, and background runs use the existing owned job service. Presentation is an args-only generic card
 * titled from `meta.name`. Task-shaped usage guidance is registered as the tool's own prompt
 * section rather than deployment persona prose.
 * @module io-agent/tool-workflow
 */

import { startBackgroundWorkflow } from './background.ts'
import { modelText } from "../../context/text/index.ts"
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import z from "../../runtime/vendor/schemastery/index.ts"
import { defineTool } from "../../tools/index.ts"
import type { ToolCallView, ToolResultView } from "../../tools/index.ts"
import type { ContentBlock } from "../../model/llm/index.ts"
import type { Session, SessionEventMap } from "../../session/journal/index.ts"
import type { JsonValue } from "../../util/values/index.ts"
import type {
  WorkflowResult, WorkflowRun, WorkflowRunId, WorkflowStopReason,
} from "../workflow/index.ts"
import type {
  ToolWorkflowAgentEndData, ToolWorkflowAgentStartData,
  ToolWorkflowRunEndData, ToolWorkflowRunStartData,
} from './types.ts'

export const name = 'tool-workflow'
export const inject = ['tools', 'workflowEngine', 'systemPrompt']

/** Config: the model-facing tool name. Output budgets belong to the shared spill policy. */
export interface Config {
  /** The model-facing tool name to register (default `workflow`). */
  toolName?: string
}

export const Config: z<Config> = z.object({
  toolName: z.string().default('workflow'),
})

type ResolvedConfig = Required<Config>

interface WorkflowRecorder {
  start(session: Session, run: WorkflowRun, jobId?: string): void
  finish(runId: WorkflowRunId, stopReason: WorkflowStopReason): void
  abandon(runId: WorkflowRunId): void
}

interface ToolWorkflowRecordEventMap {
  'tool-workflow/run-start': ToolWorkflowRunStartData
  'tool-workflow/agent-start': ToolWorkflowAgentStartData
  'tool-workflow/agent-end': ToolWorkflowAgentEndData
  'tool-workflow/run-end': ToolWorkflowRunEndData
}

/** Render a contained recording failure without trusting the thrown value. */
function renderRecordingError(error: unknown): string {
  try {
    return String(error)
  } catch {
    return modelText('foundation/tool-workflow-index/text-01')
  }
}

/**
 * Project active top-level workflow runs into their parent Sessions without
 * letting recording failure affect tool execution.
 */
function createWorkflowRecorder(ctx: Context): WorkflowRecorder {
  const active = new Map<WorkflowRunId, Session>()
  const append = <Type extends keyof ToolWorkflowRecordEventMap>(
    session: Session,
    type: Type,
    data: SessionEventMap[Type],
  ): boolean => {
    // These four package-owned events are all log-only. Narrowing the generic
    // append face here discharges Session.append's conditional options tuple.
    const appendRecord = session.append.bind(session) as <Event extends keyof ToolWorkflowRecordEventMap>(
      event: Event,
      value: SessionEventMap[Event],
    ) => void
    try {
      appendRecord(type, data)
      return true
    } catch (error: unknown) {
      ctx.logger.warn(modelText('runtime/tool-workflow-index/text-01', { value_1: String(type), value_2: String(renderRecordingError(error)) }))
      return false
    }
  }

  ctx.on('workflow/agent-start', (info, agent) => {
    const session = active.get(info.id)
    if (session === undefined) return
    const data: ToolWorkflowAgentStartData = {
      runId: info.id,
      seq: agent.seq,
      label: agent.label,
      ...agent.phase === undefined ? {} : { phase: agent.phase },
      childId: agent.childId,
    }
    if (!append(session, 'tool-workflow/agent-start', data)) active.delete(info.id)
  })
  ctx.on('workflow/agent-end', (info, agent) => {
    const session = active.get(info.id)
    if (session === undefined) return
    const data: ToolWorkflowAgentEndData = {
      runId: info.id,
      seq: agent.seq,
      outcome: agent.outcome,
    }
    if (!append(session, 'tool-workflow/agent-end', data)) active.delete(info.id)
  })

  return {
    start(session, run, jobId) {
      if (append(session, 'tool-workflow/run-start', { runId: run.id, name: run.meta.name, ...(jobId === undefined ? {} : { jobId }) })) {
        active.set(run.id, session)
      }
    },
    finish(runId, stopReason) {
      const session = active.get(runId)
      if (session !== undefined) append(session, 'tool-workflow/run-end', { runId, stopReason })
      active.delete(runId)
    },
    abandon: (runId) => { active.delete(runId) },
  }
}

/**
 * The script-authoring contract, embedded in the tool description. This IS the
 * model-facing spec: the meta block, the hooks and their exact semantics, and
 * the supported schema subset.
 */
const DESCRIPTION = modelText('runtime/tool-workflow-index/text-02')

type WorkflowCallArgs = {
  script: string
  meta: {
    name: string
    description: string
    whenToUse?: string
    phases?: { title: string; detail?: string; provider?: string; model?: string }[]
  }
  run_in_background?: boolean
  args?: Record<string, unknown>
}

/** The pending-state card: a generic card titled by the workflow's meta name. */
function presentWorkflowCall(args: WorkflowCallArgs): ToolCallView {
  return {
    card: 'generic',
    title: `workflow: ${args.meta.name}`,
    rawInput: args.script,
  }
}

/** The completed-state card: keep the pending title; render the result content as-is. */
function presentWorkflowResult(args: WorkflowCallArgs, result: { content: ContentBlock[]; isError: boolean }): ToolResultView {
  void args
  void result
  return { card: 'generic' }
}

/** A non-`completed` stop reason means the script did not finish cleanly. */
function stopReasonError(result: WorkflowResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'cancelled':
      return modelText('foundation/tool-workflow-index/text-02', { value_1: String(result.error !== undefined ? ` (${result.error})` : '') })
    case 'error':
      return modelText('foundation/tool-workflow-index/text-03', { value_1: String(result.error ?? 'unknown error') })
    /* v8 ignore start -- defensive: WorkflowStopReason is a closed union, exhaustive by construction; a future variant fails here loudly */
    default:
      return modelText('foundation/tool-workflow-index/text-04', { value_1: String(String(result.stopReason satisfies never)) })
    /* v8 ignore stop */
  }
}

/** Render the complete product. The shared output policy owns storage and bounded model views. */
function renderResult(name: string, agentsStarted: number, value: JsonValue): string {
  return modelText('runtime/tool-workflow-index/text-03', {
    value_1: name, value_2: String(agentsStarted), value_3: agentsStarted === 1 ? '' : 's',
    value_4: JSON.stringify(value, null, 2),
  })
}

export function apply(ctx: Context, config: Config): void {
  // schemastery (the exported Config schema) has already filled the defaulted
  // fields; the assertion records that resolution, not a hidden fallback.
  const { toolName } = config as ResolvedConfig
  const recorder = createWorkflowRecorder(ctx)
  // Usage policy ships with the tool (the master convention: tool guidance
  // lives in tool plugins as prompt sections, not in the deployment persona).
  ctx.systemPrompt.section({
    name: `tool:${toolName}`,
    order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
    text: modelText('runtime/tool-workflow-index/text-04', { value_1: String(toolName) }),
  })
  ctx.tools.register(defineTool({
    name: toolName,
    description: DESCRIPTION,
    parameters: {
      script: {
        type: 'string',
        required: true,
        description: modelText('runtime/tool-workflow-index/text-05'),
      },
      meta: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: modelText('runtime/tool-workflow-index/text-06'),
        properties: {
          name: { type: 'string', required: true, description: modelText('runtime/tool-workflow-index/text-07') },
          description: { type: 'string', required: true, description: modelText('runtime/tool-workflow-index/text-08') },
          whenToUse: { type: 'string', description: modelText('runtime/tool-workflow-index/text-09') },
          phases: {
            type: 'array',
            description: modelText('runtime/tool-workflow-index/text-10'),
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                title: { type: 'string', required: true, description: modelText('runtime/tool-workflow-index/text-11') },
                detail: { type: 'string', description: modelText('runtime/tool-workflow-index/text-12') },
                provider: { type: 'string', description: modelText('runtime/tool-workflow-index/text-13') },
                model: { type: 'string', description: modelText('runtime/tool-workflow-index/text-14') },
              },
            },
          },
        },
      },
      ...(ctx.get('jobs') === undefined ? {} : { run_in_background: {
        type: 'boolean' as const, description: modelText('workflow/background-option'),
      } }),
      args: {
        type: 'object',
        additionalProperties: true,
        description: modelText('runtime/tool-workflow-index/text-15'),
      },
    },
    output: {
      schema: { oneOf: [
        { type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', required: true, const: 'background' },
          jobId: { type: 'string', required: true }, runId: { type: 'string', required: true },
        } },
        { type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', required: true, const: 'foreground' },
          runId: { type: 'string', required: true }, agentsStarted: { type: 'integer', required: true },
          result: { type: 'json', required: true },
        } },
      ] },
      render: (args, value) => [{ type: 'text', text: value.kind === 'background'
        ? modelText('workflow/background-started', { name: args.meta.name, job_id: value.jobId, run_id: value.runId })
        : renderResult(args.meta.name, value.agentsStarted, value.result) }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        // The loop sets `exec.agent` for every model-driven call; its absence
        // means a non-agent caller invoked the tool directly, which has no
        // parent to attribute the children to. Fail loud rather than guess.
        throw new Error(modelText('runtime/tool-workflow-index/text-16'))
      }

      if (args.run_in_background === true) {
        exec.signal.throwIfAborted()
        const recordsRun = exec.parent === undefined
        return startBackgroundWorkflow(ctx, parent, {
          name: args.meta.name,
          start: () => ctx.workflowEngine.start({ script: args.script, meta: args.meta,
            ...args.args === undefined ? {} : { args: args.args }, parent }),
          record: (run, jobId) => { if (recordsRun) recorder.start(parent.session, run, jobId) },
          finish: (run, result) => { if (recordsRun) recorder.finish(run.id, result.stopReason) },
          render: result => stopReasonError(result) ?? renderResult(args.meta.name, result.agentsStarted, result.value as JsonValue),
        })
      }

      // Meta/body validation failures (META_INVALID/SCRIPT_PARSE) throw
      // synchronously here and become isError results via the registry — the
      // model sees the violation list and can correct the call.
      const run = ctx.workflowEngine.start({
        script: args.script,
        meta: args.meta,
        ...args.args !== undefined ? { args: args.args } : {},
        parent,
        signal: exec.signal,
      })
      const recordsRun = exec.parent === undefined
      // The engine publishes member events after start() returns and this run record is active.
      if (recordsRun) recorder.start(parent.session, run)

      // Bridge the tool's abort signal to the run: if the parent step is aborted while the
      // script is in flight, cancel the whole run. The signal also enters the engine directly, but
      // this local bridge preserves the tool contract even if an implementation ignores it.
      const onAbort = (): void => { run.cancel('parent step aborted') }
      exec.signal.addEventListener('abort', onAbort, { once: true })

      let result: WorkflowResult | undefined
      try {
        result = await run.result
        const error = stopReasonError(result)
        if (error !== undefined) {
          // Map a non-clean finish to an isError result (the registry turns a
          // throw into an isError). Report the reason, not partial output.
          throw new Error(error)
        }
        return {
          kind: 'foreground' as const,
          runId: run.id,
          agentsStarted: result.agentsStarted,
          result: result.value as JsonValue,
        }
      } finally {
        exec.signal.removeEventListener('abort', onAbort)
        try {
          // Keep member listeners alive through disposal: an engine may
          // synthesize cancelled member endings while reaching quiescence.
          await run.dispose()
          if (recordsRun) {
            /* v8 ignore next -- WorkflowRun.result never rejects by contract, so result is assigned before finally. */
            if (result === undefined) throw new Error(modelText('foundation/tool-workflow-index/text-05'))
            recorder.finish(run.id, result.stopReason)
          }
        } finally {
          if (recordsRun) recorder.abandon(run.id)
        }
      }
    },
    presentCall: args => presentWorkflowCall(args),
    presentResult: (args, result) => presentWorkflowResult(args, result),
  }))
}
