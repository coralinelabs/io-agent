/**
 * The todo list's canonical form, shared by the `todo_write` tool and by
 * consumers that read a written list back from durable history (compaction
 * checkpoints), so the list format has one owner. Cordis-free.
 *
 * @module io-agent/tool-todo/list
 */

import { modelText } from "../../context/text/index.ts"
import type { TodoItem } from './types.ts'

/** Model-facing name of the todo tool. */
export const TODO_TOOL_NAME = 'todo_write'

/** The valid {@link TodoItem} statuses, as a runtime set for input narrowing. */
export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const

/**
 * Validate the value constraints the ParameterSchemaSpec can't express and build the canonical {@link
 * TodoItem}[]: trimmed non-empty unique content, and at most one `in_progress` item unless the
 * deployment allows parallel work. The registry has already enforced the status enum and rejected
 * unknown item keys (`additionalProperties: false` — the logged snapshot must equal what the model
 * believes it wrote, so a nested/extended item shape fails loud at the schema boundary instead of
 * silently flattening); the cast below records that guarantee.
 * @param raw - the model-supplied list, already schema-checked.
 * @param allowParallel - whether several items may be `in_progress` at once.
 * @returns the canonical list.
 */
export function toTodoList(raw: { content: string; status: string }[], allowParallel: boolean): TodoItem[] {
  const todos: TodoItem[] = []
  const seen = new Set<string>()
  let active = 0
  for (const item of raw) {
    const content = item.content.trim()
    if (content.length === 0) {
      throw new Error(modelText('foundation/tool-todo-index/text-01'))
    }
    if (seen.has(content)) {
      throw new Error(modelText('foundation/tool-todo-index/text-02', { value_1: String(JSON.stringify(content)) }))
    }
    seen.add(content)
    if (item.status === 'in_progress') active++
    todos.push({ content, status: item.status as TodoItem['status'] })
  }
  if (!allowParallel && active > 1) {
    throw new Error(modelText('runtime/tool-todo-index/text-05', { value_1: String(active) }))
  }
  return todos
}

/**
 * Read back the canonical list a successful `todo_write` call wrote, the same
 * list its `todo/write` snapshot logged.
 * @param result - a successful tool result's call, as durable history records it.
 * @returns the written list, or `undefined` when the call is not a well-formed `todo_write`.
 */
export function writtenTodoList(result: { readonly call?: { readonly name: string; readonly arguments: string } }): TodoItem[] | undefined {
  if (result.call?.name !== TODO_TOOL_NAME) return undefined
  let args: unknown
  try {
    args = JSON.parse(result.call.arguments) as unknown
  } catch {
    return undefined
  }
  const items = typeof args === 'object' && args !== null && 'todos' in args ? args.todos : undefined
  if (!Array.isArray(items) || !items.every((item: unknown) => typeof item === 'object' && item !== null
    && typeof (item as { content?: unknown }).content === 'string'
    && (TODO_STATUSES as readonly unknown[]).includes((item as { status?: unknown }).status))) return undefined
  try {
    // A successful call already passed the deployment's parallel rule.
    return toTodoList(items as { content: string; status: string }[], true)
  } catch {
    return undefined
  }
}
