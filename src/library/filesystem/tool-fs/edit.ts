/**
 * Model-facing literal edit, unique-match by default. It obtains an optional guard from the
 * single intent slot, calls `ctx.fs.editText` without a separate stat, then records the observed
 * version; no policy means an unconditional atomic edit.
 * @module io-agent/tool-fs/src/edit
 */

import { modelText } from "../../context/text/index.ts"
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import { defineTool } from "../../tools/index.ts"
import type { DiffCallView, DiffResultView, ToolResult } from "../../tools/index.ts"
import type {} from "../fs/index.ts"
import { computeHunkDiffs, diffsFromMeta } from './diff.ts'
import { remediateFsError } from './error.ts'
import { sessionResolveOptions } from './session-cwd.ts'
import type { FsSandboxController } from './sandbox.ts'

import type { FsEditRequest, FsReplacement } from '../fs/types.ts'
import { MAX_EDITS } from '../edit.ts'

interface ReplacementArgs {
  old_string: string
  new_string: string
  replace_all?: boolean
  match_mode?: 'exact' | 'trailing-whitespace'
}
interface EditToolArgs extends Partial<ReplacementArgs> {
  file_path: string
  edits?: ReplacementArgs[]
  sandbox_permissions?: string
  justification?: string
}
type EditInput = { filePath: string } & FsEditRequest

function replacement(args: ReplacementArgs): FsReplacement {
  if (args.old_string.length === 0) throw new Error(modelText('tools/edit/old-string-required'))
  if (args.old_string === args.new_string) throw new Error(modelText('tools/edit/strings-must-differ'))
  return { oldString: args.old_string, newString: args.new_string, replaceAll: args.replace_all ?? false,
    ...args.match_mode === undefined ? {} : { matchMode: args.match_mode } }
}

/** Validate mutually exclusive forms before resolving paths or acquiring write permission. */
export function parseEditArgs(args: EditToolArgs): EditInput {
  if (args.file_path.trim().length === 0) throw new Error(modelText('tools/edit/path-required'))
  if (args.edits !== undefined) {
    if (args.old_string !== undefined || args.new_string !== undefined || args.replace_all !== undefined || args.match_mode !== undefined) {
      throw new Error(modelText('tools/edit/batch-exclusive'))
    }
    if (args.edits.length === 0 || args.edits.length > MAX_EDITS) throw new Error(modelText('tools/edit/batch-limit', { limit: MAX_EDITS }))
    return { filePath: args.file_path, edits: args.edits.map(replacement) }
  }
  if (args.old_string === undefined || args.new_string === undefined) throw new Error(modelText('tools/edit/batch-exclusive'))
  return { filePath: args.file_path, ...replacement({ ...args, old_string: args.old_string, new_string: args.new_string }) }
}

/**
 * Format an edit success (single-match or replace-all) as a Claude-style model-facing message.
 * @param displayPath - the backend-resolved path shown to the model.
 * @param replaceAll - selects the all-occurrences wording over the single-replacement one.
 * @returns the confirmation sentence the model sees as the tool result.
 */
export function formatEditOutput(displayPath: string, replaceAll: boolean): string {
  return replaceAll
    ? modelText('tools/edit/replaced-all', { path: displayPath })
    : modelText('tools/edit/replaced-once', { path: displayPath })
}

/**
 * Register the `edit` tool and its scope-aware system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param sandbox - the shared sandbox-escalation API (advertisement, mode stamping, denial mapping).
 */
export function applyEditTool(ctx: Context, sandbox: FsSandboxController): void {
  ctx.systemPrompt.section({
    name: 'tool:edit',
    order: ctx.systemPrompt.getSectionOrder('TOOL_EDIT'),
    text: ({ scope }) => ctx.tools.get('edit', scope) === undefined
      ? ''
      : modelText('tools/edit/guidance') + '\n\n' + modelText('tools/edit/behavior'),
  })

  ctx.tools.register(defineTool({
    name: 'edit',
    description: modelText('tools/edit/description-01'),
    parameters: {
      file_path: { type: 'string', required: true, description: modelText('tools/edit/description-02') },
      old_string: { type: 'string', description: modelText('tools/edit/description-03') },
      new_string: { type: 'string', description: modelText('tools/edit/description-04') },
      replace_all: { type: 'boolean', description: modelText('tools/edit/description-05') },
      match_mode: { type: 'string', enum: ['exact', 'trailing-whitespace'], description: modelText('tools/edit/match-mode-description') },
      edits: {
        type: 'array', description: modelText('tools/edit/batch-description'),
        items: { type: 'object', additionalProperties: false, properties: {
          old_string: { type: 'string', required: true, description: modelText('tools/edit/description-03') },
          new_string: { type: 'string', required: true, description: modelText('tools/edit/description-04') },
          replace_all: { type: 'boolean', description: modelText('tools/edit/description-05') },
          match_mode: { type: 'string', enum: ['exact', 'trailing-whitespace'], description: modelText('tools/edit/match-mode-description') },
        } },
      },
      ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: args.edits === undefined ? formatEditOutput(value.path, args.replace_all ?? false)
          : modelText('tools/edit/batch-applied', { count: args.edits.length, path: value.path }),
      }],
      presentationMeta: (args, value) => ({
        diffs: computeHunkDiffs(args.file_path, value.before, value.after)
          .map(({ path, oldText, newText }) => ({ path, oldText, newText })),
      }),
    },
    async execute(args: EditToolArgs, exec) {
      const { filePath, ...request } = parseEditArgs(args)
      // Resolve the per-call sandbox policy (approved mode > session override
      // > backend default, plus the session cwd root) BEFORE anything executes.
      const sandboxPolicy = await sandbox.resolvePolicy('edit', args, exec)
      const target = await ctx.fs.resolve(filePath, sessionResolveOptions(exec, sandboxPolicy?.workspaceRoot))
      // Single-slot decision: the policy plugin returns { version: vObserved } or
      // throws FS_NOT_OBSERVED; the bare default is undefined (unconditional edit).
      // No stat — the bare default never manufactures a version basis. The intent
      // slot itself can throw FS_NOT_OBSERVED for an unread target, so it sits
      // inside the try: both that refusal and the provider's guarded-mutation
      // failure get the model-facing remedy below.
      let outcome
      try {
        const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
        await ctx.serial('fs/before-change', target, exec)
        outcome = await ctx.fs.editText(
          target,
          request,
          intent,
          exec.signal,
          sandboxPolicy,
        )
      } catch (error: unknown) {
        // A sandbox denial becomes the shared [sandbox: …] marker (the model
        // recognizes it from bash); guarded mutation failures receive their
        // stable model-facing diagnostic; anything else passes through.
        throw remediateFsError(sandbox.mapError(error, sandboxPolicy), target.displayPath)
      }
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return {
        path: target.displayPath,
        before: outcome.before,
        after: outcome.after,
      }
    },
    // Pure display: a diff card of the literal replacement (old_string → new_string), derived
    // from the call args. `oldText: old_string || null` matches claude-agent-acp's Edit arm;
    // new_string is a required arg here, so it maps straight to newText.
    presentCall(args): DiffCallView {
      return {
        card: 'diff',
        title: `Edit ${args.file_path}`,
        diffs: (args.edits ?? [{ old_string: args.old_string ?? '', new_string: args.new_string ?? '' }])
          .map(edit => ({ path: args.file_path, oldText: edit.old_string || null, newText: edit.new_string })),
        locations: [{ path: args.file_path }],
      }
    },
    // Applied metadata replaces the call-time snippet; errors or malformed replay metadata use
    // the generic result rendering.
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
      if (diffs === undefined) return undefined
      return { card: 'diff', title: `Edit ${args.file_path}`, diffs }
    },
  }))
}
