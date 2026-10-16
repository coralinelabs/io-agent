/** Stack-safe ordered tree evaluation. The visitor owns semantics, not traversal.
 * Values (including undefined) are explicit leaves; a branch reduces only after
 * its children settle. Siblings are visited left-to-right and never spread onto
 * the JavaScript call stack. No memoization: the same node may mean different
 * things at different paths, and caller-owned mutable trees stay observable.
 */
export type TreeStep<Input, Output> =
  | { readonly value: Output }
  | { readonly children: readonly Input[]; readonly reduce: (children: readonly Output[]) => Output }

export function foldTree<Input, Output>(root: Input,
  visit: (input: Input) => TreeStep<Input, Output>): Output {
  type Frame = { step: Extract<TreeStep<Input, Output>, { children: readonly Input[] }>;
    next: number; values: Output[] }
  const frames: Frame[] = []
  let input = root
  for (;;) {
    const step = visit(input)
    if ('children' in step && step.children.length > 0) {
      frames.push({ step, next: 1, values: [] })
      input = step.children[0]!
      continue
    }
    let value = 'value' in step ? step.value : step.reduce([])
    for (;;) {
      const parent = frames.at(-1)
      if (parent === undefined) return value
      parent.values.push(value)
      if (parent.next < parent.step.children.length) {
        input = parent.step.children[parent.next++]!
        break
      }
      frames.pop()
      value = parent.step.reduce(parent.values)
    }
  }
}
