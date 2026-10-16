/** Pure touch extraction for nested instruction disclosure. */
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOUCH_EXCLUDED_DIRECTORIES,
  instructionTouches,
  lexShellCommand,
  MAX_TOUCH_DEPTH,
  MAX_TOUCH_WORD_CHARS,
  MAX_TOUCHES_PER_CALL,
} from "../../../src/library/context/agent-instructions/touch.ts"

const cwd = resolve('/work/repo')
const excluded = new Set(DEFAULT_TOUCH_EXCLUDED_DIRECTORIES)
const at = (...segments: string[]): string => join(cwd, ...segments)
const bash = (command: string, extra: Record<string, unknown> = {}) =>
  instructionTouches({ name: 'bash', arguments: { command, description: 'x', ...extra } }, cwd, excluded)

describe('instruction touches', () => {
  it('keeps read, write and edit file paths raw and unfiltered', () => {
    for (const name of ['read', 'write', 'edit']) {
      expect(instructionTouches({ name, arguments: { file_path: '  node_modules/dep/AGENTS.md ' } }, cwd, excluded))
        .toEqual({ files: ['node_modules/dep/AGENTS.md'], directories: [] })
    }
    expect(instructionTouches({ name: 'read', arguments: { file_path: '   ' } }, cwd, excluded))
      .toEqual({ files: [], directories: [] })
    expect(instructionTouches({ name: 'todo', arguments: { file_path: 'pkg/a.txt' } }, cwd, excluded))
      .toEqual({ files: [], directories: [] })
  })

  it('treats cd and pushd operands at a segment start as directories and rebases later words', () => {
    expect(bash('cd sub && ls')).toEqual({ files: [], directories: [at('sub')] })
    expect(bash('cd -P pkg; cat lib/a.ts; pushd ../tools && make')).toEqual({
      files: [], directories: [at('pkg'), at('pkg', 'lib'), at('tools')],
    })
    // Prose is not navigation, and a bare word is not a path.
    expect(bash('echo cd sub && ls sub')).toEqual({ files: [], directories: [] })
  })

  it('makes the base unknown after cd -, a bare cd, a glob, an expansion or a home path', () => {
    for (const command of ['cd - && cat a/b.txt', 'cd && cat a/b.txt', 'cd $DIR && cat a/b.txt',
      'cd "$(git rev-parse --show-toplevel)" && cat a/b.txt', 'cd ~/x && cat a/b.txt', 'cd su* && cat a/b.txt']) {
      expect(bash(command), command).toEqual({ files: [], directories: [] })
    }
    // Absolute words stay resolvable.
    expect(bash(`cd $DIR && cat ${at('abs', 'x.txt')}`)).toEqual({ files: [], directories: [at('abs')] })
  })

  it('restores the base when a subshell closes', () => {
    expect(bash('(cd sub && make) && cat pkg/x.txt')).toEqual({
      files: [], directories: [at('sub'), at('pkg')],
    })
  })

  it('restores the base pushd saved when popd runs', () => {
    // popd undoes pushd: lib/x.txt is read from the starting directory, not from sub.
    expect(bash('pushd sub >/dev/null && popd >/dev/null && cat lib/x.txt')).toEqual({
      files: [], directories: [at('sub'), at('lib')],
    })
    expect(bash('pushd a && pushd b && popd && cat x/y.txt')).toEqual({
      files: [], directories: [at('a'), at('a', 'b'), at('a', 'x')],
    })
    // A subshell's pushd stack is its own.
    expect(bash('pushd a; (pushd b; popd; popd); popd; cat x/y.txt')).toEqual({
      files: [], directories: [at('a'), at('a', 'b'), at('x')],
    })
    // popd without a pushd in this command, and a bare pushd (a swap), leave the base unknown.
    expect(bash('popd && cat lib/x.txt')).toEqual({ files: [], directories: [] })
    expect(bash('pushd a && pushd && cat x/y.txt; popd; cat x/z.txt')).toEqual({ files: [], directories: [at('a')] })
  })

  it('makes the base unknown after a navigation in a || alternative, but follows brace groups', () => {
    expect(bash('cd a || cd b && cat x/y.txt')).toEqual({ files: [], directories: [at('a')] })
    expect(bash('(cd a) || cd b; cat x/y.txt')).toEqual({ files: [], directories: [at('a')] })
    expect(bash('pushd a || pushd b; popd; cat x/y.txt')).toEqual({ files: [], directories: [at('a')] })
    // `cd a || exit 1`: the alternative does not navigate, so the base stays a.
    expect(bash('cd a || exit 1; cat x/y.txt')).toEqual({ files: [], directories: [at('a'), at('a', 'x')] })
    // A brace group runs in the current shell: its cd is a navigation, and it persists.
    expect(bash('{ cd sub; cat lib/x.txt; }; cat z/w.txt')).toEqual({
      files: [], directories: [at('sub'), at('sub', 'lib'), at('sub', 'z')],
    })
    expect(bash('make || { cd sub; cat lib/x.txt; }')).toEqual({ files: [], directories: [] })
    expect(bash('if cd sub; then cat lib/x.txt; fi')).toEqual({ files: [], directories: [at('sub'), at('sub', 'lib')] })
  })

  it('bounds guessed locations: long words are skipped and depth is capped', () => {
    // An encoded blob or inline code is one long word full of '/': never a candidate.
    const blob = Array.from({ length: 300 }, (_, index) => `Q${String(index % 10)}x`).join('/')
    expect(blob.length).toBeGreaterThan(MAX_TOUCH_WORD_CHARS)
    expect(bash(`echo '${blob}' > /dev/null; cat src/a.ts`)).toEqual({ files: [], directories: [at('src')] })
    expect(bash(`cd ${'d/'.repeat(200)} && cat src/a.ts`)).toEqual({ files: [], directories: [] })
    const deep = Array.from({ length: MAX_TOUCH_DEPTH + 3 }, (_, index) => `l${String(index)}`)
    expect(bash(`cat ${deep.join('/')}/f.txt ${deep.slice(0, 2).join('/')}/g.txt`)).toEqual({
      files: [], directories: [at(...deep.slice(0, MAX_TOUCH_DEPTH)), at(...deep.slice(0, 2))],
    })
    expect(instructionTouches({ name: 'glob', arguments: { pattern: `${deep.join('/')}/*.ts` } }, cwd, excluded))
      .toEqual({ files: [], directories: [at(...deep.slice(0, MAX_TOUCH_DEPTH))] })
    // read/write/edit paths are what the call used, so they are never capped.
    expect(instructionTouches({ name: 'read', arguments: { file_path: `${deep.join('/')}/f.txt` } }, cwd, excluded))
      .toEqual({ files: [`${deep.join('/')}/f.txt`], directories: [] })
  })

  it('counts a file through its parent directory and cuts globs to their static directory', () => {
    expect(bash('cat deep/a/b/c.txt tests/unit src/ .github/workflows lib/**/*.py docs/v*.md "*/x" top.txt')).toEqual({
      files: [],
      directories: [at('deep', 'a', 'b'), at('tests', 'unit'), at('src'), at('.github', 'workflows'), at('lib'), at('docs')],
    })
  })

  it('skips flags, URLs, expansions, home paths, comments and heredoc bodies', () => {
    expect(bash([
      'curl -o=out/x https://example.com/a/b $HOME/c ~/d --path=e/f # see g/h',
      'cat <<-EOF > notes/new.md',
      '\tbody/inside.txt',
      '\tEOF',
      'cat after/heredoc.txt',
    ].join('\n'))).toEqual({
      files: [], directories: [at('notes'), at('after')],
    })
    // An unterminated heredoc or quote ends the scan.
    expect(bash('cat a/one.txt <<EOF\nb/two.txt')).toEqual({ files: [], directories: [at('a')] })
    expect(bash('cat a/one.txt "b/two.txt')).toEqual({ files: [], directories: [at('a')] })
  })

  it('removes quotes and escapes and honours assignment prefixes', () => {
    expect(bash(`PYTHONPATH=src/lib python 'my dir/x.py' "q/y.py" esc\\ aped/z.py 2>/dev/null`)).toEqual({
      files: [], directories: [at('src', 'lib'), at('my dir'), at('q'), at('esc aped')],
    })
    expect(lexShellCommand('a | b && c; d || e & f\ng')).toEqual([
      { kind: 'word', text: 'a', dynamic: false }, { kind: 'break' },
      { kind: 'word', text: 'b', dynamic: false }, { kind: 'break' },
      { kind: 'word', text: 'c', dynamic: false }, { kind: 'break' },
      { kind: 'word', text: 'd', dynamic: false }, { kind: 'break', alternative: true },
      { kind: 'word', text: 'e', dynamic: false }, { kind: 'break' },
      { kind: 'word', text: 'f', dynamic: false }, { kind: 'break' },
      { kind: 'word', text: 'g', dynamic: false },
    ])
  })

  it('truncates at excluded directories and drops paths outside cwd', () => {
    expect(bash('cat node_modules/dep/i.js pkg/node_modules/x/y.js vendor/ ../outside/x.txt /etc/hosts .git/config')).toEqual({
      files: [], directories: [at('pkg')],
    })
    // Navigating into an excluded or outside directory taints later relative words too.
    expect(bash('cd node_modules/dep && cat lib/a.js')).toEqual({ files: [], directories: [] })
    expect(bash('cd /tmp && cat lib/a.js')).toEqual({ files: [], directories: [] })
    // The exclusion list is configurable.
    expect(instructionTouches({ name: 'bash', arguments: { command: 'cat build/x/y.txt' } }, cwd, new Set()))
      .toEqual({ files: [], directories: [at('build', 'x')] })
  })

  it('uses workdir as a touched directory and as the base', () => {
    expect(bash('cat src/a.ts', { workdir: 'pkg' })).toEqual({
      files: [], directories: [at('pkg'), at('pkg', 'src')],
    })
    expect(bash('cat src/a.ts', { workdir: '$HOME' })).toEqual({ files: [], directories: [] })
  })

  it('caps distinct touches per call', () => {
    const words = Array.from({ length: 40 }, (_, index) => `d${String(index)}/f.txt`).join(' ')
    const touches = bash(`cat ${words} d0/f.txt`)
    expect(touches.directories).toHaveLength(MAX_TOUCHES_PER_CALL)
    expect(touches.directories[0]).toBe(at('d0'))
  })

  it('reads grep paths as files or directories', () => {
    expect(instructionTouches({ name: 'grep', arguments: { pattern: 'a/b', path: 'pkg' } }, cwd, excluded))
      .toEqual({ files: [], directories: [at('pkg')] })
    expect(instructionTouches({ name: 'grep', arguments: { pattern: 'x', path: at('src', 'agents', 'run.py') } }, cwd, excluded))
      .toEqual({ files: [], directories: [at('src', 'agents')] })
    expect(instructionTouches({ name: 'grep', arguments: { pattern: 'x', path: 'node_modules' } }, cwd, excluded))
      .toEqual({ files: [], directories: [] })
    expect(instructionTouches({ name: 'grep', arguments: { pattern: 'x' } }, cwd, excluded))
      .toEqual({ files: [], directories: [] })
  })

  it('reads glob paths and the static prefix of the pattern', () => {
    expect(instructionTouches({ name: 'glob', arguments: { pattern: 'lib/**/*.txt' } }, cwd, excluded))
      .toEqual({ files: [], directories: [at('lib')] })
    expect(instructionTouches({ name: 'glob', arguments: { pattern: 'src/*.ts', path: 'pkg' } }, cwd, excluded))
      .toEqual({ files: [], directories: [at('pkg'), at('pkg', 'src')] })
    expect(instructionTouches({ name: 'glob', arguments: { pattern: '**/*.md' } }, cwd, excluded))
      .toEqual({ files: [], directories: [] })
    expect(instructionTouches({ name: 'glob', arguments: { pattern: 'docs/guide.md' } }, cwd, excluded))
      .toEqual({ files: [], directories: [at('docs')] })
  })
})
