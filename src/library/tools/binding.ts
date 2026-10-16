/** A call binds one registration and output contract before any asynchronous policy.
 * Registration changes revoke future dispatch, but cannot reinterpret a completed result.
 * ZCode separates registry identity from execution; io-agent additionally snapshots the
 * accepted implementation so an approval cannot accidentally authorize a replacement.
 */
import { deepFreeze, snapshotJsonValue } from '../util/values/index.ts'
import type { ToolDefinition, ToolExecution } from './contracts.ts'
import { assertSupportedJsonSchema } from './json-schema.ts'
import { HarnessError } from '../model/llm/index.ts'
import { modelText } from '../context/text/index.ts'

export interface ToolRegistration { readonly token: symbol; readonly definition: ToolDefinition }
export interface ToolBinding { readonly token: symbol; readonly definition: ToolDefinition }

export function bindTool(registration: ToolRegistration): ToolBinding {
  const tool = registration.definition
  const output = tool.output
  const parameters = snapshotJsonValue(tool.parameters)
  const schema = snapshotJsonValue(output.schema)
  if (parameters === undefined || schema === undefined) throw new TypeError('tool contracts must be lossless JSON')
  // Registration validation is not a lifetime guarantee for borrowed mutable
  // definitions. Validate the exact detached contract this call will use.
  assertSupportedJsonSchema(schema)
  // Never freeze a plugin's live object; detach values and bind methods to their owner.
  const definition: ToolDefinition = {
    name: tool.name, description: tool.description, parameters: deepFreeze(parameters),
    execute: tool.execute.bind(tool),
    output: Object.freeze({ schema: deepFreeze(schema), render: output.render.bind(output),
      ...(output.presentationMeta === undefined ? {} : { presentationMeta: output.presentationMeta.bind(output) }) }),
    ...(tool.finalizeContent === undefined ? {} : { finalizeContent: tool.finalizeContent.bind(tool) }),
  }
  return Object.freeze({ token: registration.token, definition: Object.freeze(definition) })
}

export function changedTool(exec: Pick<ToolExecution, 'name'>, beforeDispatch = false): HarnessError {
  const text = beforeDispatch ? modelText('tools/changed-before-dispatch', { name: exec.name })
    : modelText('tools/changed-after-execution', { name: exec.name })
  return new HarnessError(text, 'TOOL_CHANGED')
}
