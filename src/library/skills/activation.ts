/** Literal one-pass skill bindings. No shell, environment expansion, or recursive templates.
 * Named positional arguments come from the Claude rewrite; known directory/session tokens
 * follow Hermes's preprocessing split, but never execute inline commands.
 */
export interface SkillBindings {
  readonly argumentNames?: readonly string[]
  readonly skillDirectory?: string
  readonly sessionId?: string
}

/** Quotes group arguments. Only quoting escapes are consumed; Windows paths stay intact. */
export function splitSkillArguments(input: string): string[] {
  const words: string[] = []
  let current = '', quote = '', started = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (c === '\\' && quote !== "'" && i + 1 < input.length
      && (input[i + 1] === '\\' || input[i + 1] === '"' || (!quote && /[\s']/.test(input[i + 1]!)))) {
      current += input[++i]; started = true; continue
    }
    if (quote) {
      if (c === quote) quote = ''
      else current += c
      continue
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue }
    if (/\s/.test(c)) { if (started) words.push(current); current = ''; started = false; continue }
    current += c; started = true
  }
  if (quote) throw new TypeError('unclosed quote in named skill arguments')
  if (started) words.push(current)
  return words
}

const SKILL_TOKEN_PREFIXES = ['IO_AGENT', 'PLUTO', 'HERMES', 'CLAUDE'] as const

export function bindSkillArguments(content: string, argumentsText: string | undefined, bindings: SkillBindings = {}): string {
  const values = new Map<string, string>()
  if (argumentsText !== undefined) {
    values.set('$ARGUMENTS', argumentsText)
    const names = bindings.argumentNames ?? []
    const args = names.length ? splitSkillArguments(argumentsText) : []
    names.forEach((name, index) => values.set('$' + name.toUpperCase(), args[index] ?? ''))
  }
  // the harness's own tokens (IO_AGENT_, and PLUTO_ from before io-agent) and the ones skills written for other
  // harnesses use
  if (bindings.skillDirectory !== undefined) {
    for (const prefix of SKILL_TOKEN_PREFIXES) values.set('${' + prefix + '_SKILL_DIR}', bindings.skillDirectory)
  }
  if (bindings.sessionId !== undefined) {
    for (const prefix of SKILL_TOKEN_PREFIXES) values.set('${' + prefix + '_SESSION_ID}', bindings.sessionId)
  }
  return content.replace(/\$\{(?:IO_AGENT|PLUTO|HERMES|CLAUDE)_(?:SKILL_DIR|SESSION_ID)\}|\$[A-Z][A-Z0-9_]*\b/g,
    token => values.get(token) ?? token)
}

export function leadingSkillArguments(text: string, name: string): string | undefined {
  const prefix = `/${name}`
  const value = text.trimStart()
  if (!value.startsWith(prefix) || (value.length > prefix.length && !/\s/.test(value[prefix.length]!))) return undefined
  return value.slice(prefix.length).trimStart()
}
