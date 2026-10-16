/** Deployment-owned vLLM template values, independent of model reasoning capability. */
export type TemplateValue = string | number | boolean | null | TemplateValue[] | { [key: string]: TemplateValue }
export type RequestTemplateKwargs = Record<string, TemplateValue>

/** Reject values JSON would silently drop/coerce, and detach the request snapshot. */
export function resolveTemplateKwargs(value: RequestTemplateKwargs): RequestTemplateKwargs {
  const ancestors = new Set<object>()
  function validate(input: unknown): void {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return
    if (typeof input === 'number' && Number.isFinite(input)) return
    if (typeof input !== 'object' || input === null) throw new TypeError('requestTemplateKwargs must contain only finite JSON values')
    if (ancestors.has(input)) throw new TypeError('requestTemplateKwargs must not be cyclic')
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
      throw new TypeError('requestTemplateKwargs must contain plain JSON objects')
    }
    ancestors.add(input)
    for (const child of Array.isArray(input) ? input : Object.values(input)) validate(child)
    ancestors.delete(input)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('requestTemplateKwargs must be an object')
  validate(value)
  return structuredClone(value)
}

/** Only the template field is adjustable: never overwrite messages, tools, model, or budgets. */
export function applyTemplateKwargs(payload: unknown, kwargs: RequestTemplateKwargs): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new TypeError('expected a provider request object')
  const request = payload as Record<string, unknown>
  const existing = request.chat_template_kwargs
  return { ...request, chat_template_kwargs: {
    ...(typeof existing === 'object' && existing !== null && !Array.isArray(existing) ? existing : {}),
    ...structuredClone(kwargs),
  } }
}
