/** Direct model-language ownership guard. Operational data and dynamic context are not rewritten. */
import ts from 'typescript'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This deliberately checks static sinks, not whether arbitrary program execution can produce text. */
export function inlineModelLanguage(text, file = 'source.ts') {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), findings = []
  function fragments(n) {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
    if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map(s => s.literal.text).join(' ')
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return fragments(n.left) + fragments(n.right)
    return ''
  }
  function visit(n) {
    const parent = n.parent
    const direct = parent && ts.isPropertyAssignment(parent) && parent.initializer === n
      && ['text', 'description'].includes(parent.name.getText(sf).replace(/^['"]|['"]$/g, ''))
    const named = parent && ts.isVariableDeclaration(parent) && parent.initializer === n
      && /(?:PROMPT|INSTRUCTIONS?|PREAMBLE|REMINDER|DESCRIPTION|GUIDANCE|INTRO)(?:_|$)/i.test(parent.name.getText(sf))
    const schema = parent && ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === 'describe'
    if ((direct || named || schema) && /[a-z]{3}/i.test(fragments(n))) findings.push({
      file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, expression: n.getText(sf),
      kind: direct ? 'text-or-description' : named ? 'named-instruction' : 'schema-description',
    })
    ts.forEachChild(n, visit)
  }
  visit(sf); return findings
}
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => {
    const path = resolve(dir, item.name)
    // Vendored Cordis is upstream code; generated modules are the catalog itself.
    return item.isDirectory() ? item.name === 'vendor' ? [] : sourceFiles(path)
      : item.name.endsWith('.ts') && !item.name.endsWith('.d.ts') && !item.name.endsWith('.generated.ts') ? [path] : []
  })
}
/** Asset ids no source names: a literal id, or the static head of a template id (`compaction/checkpoint-anchor-${kind}`). */
export function unusedAssets(ids, texts) {
  const literals = new Set(), prefixes = []
  for (const text of texts) {
    const visit = n => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) literals.add(n.text)
      else if (ts.isTemplateExpression(n) && n.head.text.includes('/')) prefixes.push(n.head.text)
      ts.forEachChild(n, visit)
    }
    visit(ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true))
  }
  return ids.filter(id => !literals.has(id) && !prefixes.some(prefix => id.startsWith(prefix)))
}
export function auditTree(root) {
  const files = sourceFiles(resolve(root, 'src'))
  const texts = files.map(p => readFileSync(p, 'utf8'))
  const findings = files.flatMap((p, i) => inlineModelLanguage(texts[i], relative(root, p)))
  const exceptions = JSON.parse(readFileSync(resolve(root, 'scripts/prompts/structural-exceptions.json'), 'utf8'))
  const matches = (f, e) => f.file === e.file && f.expression === e.expression
  const remaining = findings.filter(f => !exceptions.some(e => matches(f, e)))
  const staleExceptions = exceptions.filter(e => !findings.some(f => matches(f, e)))
  const manifest = JSON.parse(readFileSync(resolve(root, 'src/prompts/manifest.json'), 'utf8'))
  // Test fixtures that exercise a library contract (an @-reference fixture, say) count as users.
  const fixtures = sourceFiles(resolve(root, 'tests/support')).map(p => readFileSync(p, 'utf8'))
  const unused = unusedAssets(manifest.entries.map(entry => entry.id), [...texts, ...fixtures])
  return { scope: 'Direct text/description/schema sinks and named instruction expressions in src/, and assets no source or test fixture names', sourceFiles: files.length, structuralExceptions: exceptions, staleExceptions, findings: remaining, unusedAssets: unused }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const report = auditTree(resolve(import.meta.dirname, '../..'))
  const failed = report.findings.length > 0 || report.staleExceptions.length > 0 || report.unusedAssets.length > 0
  if (failed || process.argv.includes('--report')) console.log(JSON.stringify(report, null, 2))
  else console.log(`model-context: audited ${report.sourceFiles} source files`)
  if (failed && !process.argv.includes('--report')) process.exitCode = 1
}
