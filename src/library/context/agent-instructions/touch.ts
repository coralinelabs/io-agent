/**
 * Pure extraction of the workspace locations one successful tool call touched,
 * used to disclose nested instruction files for the directories the call reached.
 *
 * `read`/`write`/`edit` keep their raw `file_path` exactly as before. `bash` (its
 * `workdir`, `cd`/`pushd`/`popd` navigation and path-like words), `grep` (`path`)
 * and `glob` (`path` plus the static prefix of `pattern`) contribute resolved
 * directories that stay inside the session cwd and outside dependency, cache, build
 * and VCS trees, which hold copies of instruction files rather than authoritative
 * ones. The shell scan is lexical and bounded: it never runs, expands or evaluates
 * anything, and a word only counts when it looks like a path (it contains `/`) or is
 * a navigation operand, following Hermes `agent/subdirectory_hints.py`.
 *
 * Shell and search candidates are guesses (a base64 blob, a regex or inline code
 * also contains `/`), so each one is bounded before any probe: words longer than
 * {@link MAX_TOUCH_WORD_CHARS} are skipped and a location keeps at most
 * {@link MAX_TOUCH_DEPTH} directory levels below cwd (Hermes `_MAX_ANCESTOR_WALK`).
 * The plugin then probes such a directory only where it exists.
 *
 * @module io-agent/agent-instructions/touch
 */

import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The execution fields a touch is derived from. */
export interface InstructionTouchSource {
  readonly name: string
  readonly arguments: unknown
}

/** What one call touched, split by how much the call proved about each location. */
export interface InstructionTouches {
  /** `read`/`write`/`edit` `file_path`, raw: the call used it, so its whole parent chain is probed. */
  files: string[]
  /**
   * Resolved `bash`/`grep`/`glob` directories (a touched file counts through its
   * parent): lexical guesses, so probing stops at the first level that is not an
   * existing directory.
   */
  directories: string[]
}

/** Directory names whose subtrees never disclose instructions through shell or search touches. */
export const DEFAULT_TOUCH_EXCLUDED_DIRECTORIES: readonly string[] = [
  '.git', '.hg', '.svn',
  'node_modules', 'vendor', 'third_party', '.venv', 'venv', 'site-packages', 'dist-packages',
  '__pycache__', '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.cache',
  '.npm', '.yarn', '.pnpm-store', '.gradle', '.m2', '.nuget',
  'dist', 'build', 'target', 'out', 'coverage', '.next', '.turbo', '.parcel-cache', '.nuxt', '.svelte-kit',
]

/** Only this prefix of a shell command is scanned. */
export const MAX_SCANNED_COMMAND_CHARS = 16 * 1024
/** At most this many distinct locations are reported for one call. */
export const MAX_TOUCHES_PER_CALL = 16
/** Longer shell words (encoded blobs, inline code) are never path candidates. */
export const MAX_TOUCH_WORD_CHARS = 256
/** A shell or search location keeps at most this many directory levels below cwd. */
export const MAX_TOUCH_DEPTH = 5

const FILE_TOUCH_TOOL_NAMES = new Set(['read', 'write', 'edit'])
const NAVIGATION_COMMANDS = new Set(['cd', 'pushd'])
/** Reserved words and group braces after which the next word still starts a command. */
const COMMAND_PREFIXES = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'while', 'until', 'do', 'time'])
const GLOB_CHARACTER = /[*?[{]/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function stringArgument(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null || !(key in args)) return undefined
  const value = (args as Record<string, unknown>)[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** A file when the last segment has a non-leading dot; `.`/`..`, dotfiles and bare names are directories. */
function looksLikeFile(path: string): boolean {
  if (/[\\/]$/.test(path)) return false
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  if (name === '.' || name === '..') return false
  return name.lastIndexOf('.') > 0
}

interface Candidate { path: string; directory: boolean }

/**
 * Reduce a literal or glob path to what it certainly names: a glob keeps the
 * directory before its first glob character, a literal keeps its file/directory kind.
 */
function staticPath(text: string): Candidate | undefined {
  const glob = text.search(GLOB_CHARACTER)
  if (glob === -1) return { path: text, directory: !looksLikeFile(text) }
  const prefix = text.slice(0, glob)
  const slash = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'))
  if (slash === -1) return undefined
  return { path: slash === 0 ? prefix.slice(0, 1) : prefix.slice(0, slash), directory: true }
}

class TouchCollector {
  readonly directories: string[] = []
  private readonly seen = new Set<string>()

  constructor(private readonly cwd: string, private readonly excluded: ReadonlySet<string>) {}

  get full(): boolean { return this.directories.length >= MAX_TOUCHES_PER_CALL }

  /**
   * Accept a resolved location inside cwd as a directory (a file through its parent),
   * cut before its first excluded segment and after {@link MAX_TOUCH_DEPTH} levels.
   */
  add(absolute: string, directory: boolean): void {
    if (this.full) return
    const rel = relative(this.cwd, directory ? absolute : dirname(absolute))
    if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return
    const segments = rel.split(sep)
    const excludedAt = segments.findIndex(segment => this.excluded.has(segment))
    const kept = Math.min(excludedAt === -1 ? segments.length : excludedAt, MAX_TOUCH_DEPTH)
    if (kept === 0) return
    const path = join(this.cwd, ...segments.slice(0, kept))
    if (this.seen.has(path)) return
    this.seen.add(path)
    this.directories.push(path)
  }

  addRelative(base: string, text: string, directory: boolean): void {
    this.add(resolve(base, text), directory)
  }
}

/**
 * A word, or a segment boundary; `group` marks a subshell `(` or `)` boundary, and
 * `alternative` a `||`, after which the next segment runs only if the previous failed.
 */
export type ShellToken =
  | { kind: 'word'; text: string; dynamic: boolean }
  | { kind: 'break'; group?: 'open' | 'close'; alternative?: true }

/** Index just past the bracket that closes the one at `open`, or -1 when unbalanced. */
function skipBalanced(input: string, open: number): number {
  const opener = input[open]!
  const closer = opener === '(' ? ')' : '}'
  let depth = 0
  for (let index = open; index < input.length; index++) {
    const char = input[index]
    if (char === '\\') { index++; continue }
    if (char === "'") {
      const end = input.indexOf("'", index + 1)
      if (end === -1) return -1
      index = end
    } else if (char === opener) {
      depth++
    } else if (char === closer) {
      depth--
      if (depth === 0) return index + 1
    }
  }
  return -1
}

/** Index of the line after a heredoc terminator, or -1 when the body never ends. */
function skipHeredoc(input: string, start: number, delimiter: string, stripTabs: boolean): number {
  let lineStart = start
  while (lineStart <= input.length) {
    const newline = input.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? input.length : newline
    const line = input.slice(lineStart, lineEnd)
    if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) return newline === -1 ? input.length : newline + 1
    if (newline === -1) return -1
    lineStart = newline + 1
  }
  return -1
}

/**
 * Split a POSIX shell command into words and segment breaks. Quotes and escapes
 * are removed, expansions mark their word dynamic, redirections split words,
 * comments and heredoc bodies are skipped. An unterminated construct ends the scan.
 */
export function lexShellCommand(command: string): ShellToken[] {
  const input = command.slice(0, MAX_SCANNED_COMMAND_CHARS)
  const tokens: ShellToken[] = []
  const heredocs: { delimiter: string; stripTabs: boolean }[] = []
  let heredocPending: boolean | undefined
  let word = ''
  let inWord = false
  let dynamic = false
  const endWord = (): void => {
    if (!inWord) return
    if (heredocPending !== undefined) {
      heredocs.push({ delimiter: word, stripTabs: heredocPending })
      heredocPending = undefined
    } else {
      tokens.push({ kind: 'word', text: word, dynamic })
    }
    word = ''
    inWord = false
    dynamic = false
  }
  const pushBreak = (group?: 'open' | 'close', alternative = false): void => {
    endWord()
    const last = tokens.at(-1)
    if (group !== undefined) tokens.push({ kind: 'break', group })
    else if (last?.kind !== 'break') tokens.push(alternative ? { kind: 'break', alternative } : { kind: 'break' })
    else if (!alternative) return
    else if (last.group === undefined) last.alternative = true
    else tokens.push({ kind: 'break', alternative })
  }
  let index = 0
  while (index < input.length) {
    const char = input[index]!
    const next = input[index + 1]
    if (char === ' ' || char === '\t' || char === '\r') {
      endWord()
      index++
    } else if (char === '\n') {
      pushBreak()
      index++
      for (const heredoc of heredocs.splice(0)) {
        index = skipHeredoc(input, index, heredoc.delimiter, heredoc.stripTabs)
        if (index === -1) return tokens
      }
    } else if (char === '#' && !inWord) {
      const newline = input.indexOf('\n', index)
      index = newline === -1 ? input.length : newline
    } else if (char === '\\') {
      if (next !== '\n' && next !== undefined) {
        word += next
        inWord = true
      }
      index += 2
    } else if (char === "'") {
      const end = input.indexOf("'", index + 1)
      if (end === -1) return tokens
      word += input.slice(index + 1, end)
      inWord = true
      index = end + 1
    } else if (char === '"') {
      let cursor = index + 1
      let closed = false
      while (cursor < input.length) {
        const quoted = input[cursor]!
        if (quoted === '\\' && cursor + 1 < input.length) {
          word += input[cursor + 1]
          cursor += 2
          continue
        }
        if (quoted === '"') { closed = true; break }
        if (quoted === '$' || quoted === '`') dynamic = true
        word += quoted
        cursor++
      }
      if (!closed) return tokens
      inWord = true
      index = cursor + 1
    } else if (char === '`') {
      const end = input.indexOf('`', index + 1)
      if (end === -1) return tokens
      dynamic = true
      inWord = true
      index = end + 1
    } else if (char === '$') {
      dynamic = true
      inWord = true
      if (next === '(' || next === '{') {
        index = skipBalanced(input, index + 1)
        if (index === -1) return tokens
      } else {
        index++
      }
    } else if (char === '(' || char === ')') {
      pushBreak(char === '(' ? 'open' : 'close')
      index++
    } else if (char === ';' || char === '|') {
      pushBreak(undefined, char === '|' && next === '|')
      index += (char === '|' && (next === '|' || next === '&')) || (char === ';' && next === ';') ? 2 : 1
    } else if (char === '&') {
      if (next === '>') {
        endWord()
        index += input[index + 2] === '>' ? 3 : 2
      } else {
        pushBreak()
        index += next === '&' ? 2 : 1
      }
    } else if (char === '<' || char === '>') {
      endWord()
      if (next === '(') {
        // Process substitution: an opaque, dynamic word.
        index = skipBalanced(input, index + 1)
        if (index === -1) return tokens
        tokens.push({ kind: 'word', text: '', dynamic: true })
      } else if (char === '<' && next === '<' && input[index + 2] !== '<') {
        const stripTabs = input[index + 2] === '-'
        heredocPending = stripTabs
        index += stripTabs ? 3 : 2
      } else {
        index += next === '>' || next === '<' || next === '&' || next === '|' ? 2 : 1
        if (char === '<' && next === '<') index++
      }
    } else {
      word += char
      inWord = true
      index++
    }
  }
  endWord()
  return tokens
}

function collectShellTouches(args: unknown, cwd: string, collector: TouchCollector): void {
  // `undefined` once a navigation target cannot be known; relative words are then skipped.
  let base: string | undefined = cwd
  const workdir = stringArgument(args, 'workdir')
  if (workdir !== undefined) {
    if (workdir.startsWith('~') || workdir.includes('$')) {
      base = undefined
    } else {
      base = resolve(cwd, workdir)
      collector.add(base, true)
    }
  }
  const command = stringArgument(args, 'command')
  if (command === undefined) return
  let segmentStart = true
  // The current segment follows `||`: it runs only when the previous one failed,
  // so a navigation in it leaves the directory unknown (`cd a || cd b`).
  let alternative = false
  let navigating: 'cd' | 'pushd' | undefined
  // `pushd` saves the base that `popd` restores; `undefined` entries are unknown.
  let pushed: (string | undefined)[] = []
  // A subshell's navigation does not outlive its closing parenthesis.
  const subshells: { base: string | undefined; pushed: (string | undefined)[] }[] = []
  const forgetDirectory = (): void => {
    base = undefined
    pushed = []
  }
  for (const token of lexShellCommand(command)) {
    if (collector.full) return
    if (token.kind === 'break') {
      // A bare `cd` goes home, which is not a workspace location; a bare `pushd` swaps
      // the directory with the top of a stack this scan may not know.
      if (navigating === 'cd') base = undefined
      else if (navigating === 'pushd') forgetDirectory()
      navigating = undefined
      segmentStart = true
      alternative = token.alternative === true
      if (token.group === 'open') {
        subshells.push({ base, pushed: [...pushed] })
      } else if (token.group === 'close') {
        const saved = subshells.pop()
        if (saved !== undefined) ({ base, pushed } = saved)
      }
      continue
    }
    const atStart = segmentStart
    segmentStart = false
    if (navigating !== undefined) {
      if (token.text.startsWith('-') && token.text !== '-') continue
      const navigation = navigating
      navigating = undefined
      if (alternative) {
        if (navigation === 'pushd') forgetDirectory()
        else base = undefined
        continue
      }
      if (navigation === 'pushd') pushed.push(base)
      if (token.dynamic || token.text === '-' || token.text.startsWith('~') || token.text.length === 0
        || token.text.length > MAX_TOUCH_WORD_CHARS || GLOB_CHARACTER.test(token.text)
        || (base === undefined && !isAbsolute(token.text))) {
        base = undefined
        continue
      }
      base = resolve(base ?? cwd, token.text)
      collector.add(base, true)
      continue
    }
    if (token.dynamic) continue
    let text = token.text
    if (atStart && ASSIGNMENT.test(text)) {
      // `NAME=value command …`: the command still starts this segment.
      segmentStart = true
      text = text.slice(text.indexOf('=') + 1)
    } else if (atStart && COMMAND_PREFIXES.has(text)) {
      segmentStart = true
      continue
    } else if (atStart && NAVIGATION_COMMANDS.has(text)) {
      navigating = text === 'cd' ? 'cd' : 'pushd'
      continue
    } else if (atStart && text === 'popd') {
      // An empty stack pops a directory this command never pushed: unknown.
      if (alternative) forgetDirectory()
      else base = pushed.pop()
      continue
    }
    if (text.length > MAX_TOUCH_WORD_CHARS || !text.includes('/') || text.startsWith('-') || text.startsWith('~')
      || text.includes('://') || text.startsWith('git@')) continue
    const candidate = staticPath(text)
    if (candidate === undefined) continue
    if (base === undefined && !isAbsolute(candidate.path)) continue
    collector.addRelative(base ?? cwd, candidate.path, candidate.directory)
  }
}

/**
 * Derive the locations one successful tool call touched.
 * @param exec - tool name and parsed arguments.
 * @param cwd - absolute session working directory; shell/search candidates must stay inside it.
 * @param excluded - directory names that end shell/search candidates (dependency, cache, VCS trees).
 * @returns raw file paths for read/write/edit, and bounded resolved directories for bash, grep and glob.
 */
export function instructionTouches(
  exec: InstructionTouchSource,
  cwd: string,
  excluded: ReadonlySet<string>,
): InstructionTouches {
  if (FILE_TOUCH_TOOL_NAMES.has(exec.name)) {
    const filePath = stringArgument(exec.arguments, 'file_path')
    return { files: filePath === undefined ? [] : [filePath], directories: [] }
  }
  const root = resolve(cwd)
  const collector = new TouchCollector(root, excluded)
  switch (exec.name) {
    case 'bash':
      collectShellTouches(exec.arguments, root, collector)
      break
    case 'grep': {
      const path = stringArgument(exec.arguments, 'path')
      if (path !== undefined) collector.addRelative(root, path, !looksLikeFile(path))
      break
    }
    case 'glob': {
      const path = stringArgument(exec.arguments, 'path')
      const searchRoot = path === undefined ? root : resolve(root, path)
      if (path !== undefined) collector.add(searchRoot, true)
      const pattern = stringArgument(exec.arguments, 'pattern')
      const prefix = pattern === undefined ? undefined : staticPath(pattern)
      if (prefix !== undefined) collector.addRelative(searchRoot, prefix.path, prefix.directory)
      break
    }
    default:
      break
  }
  return { files: [], directories: collector.directories }
}
