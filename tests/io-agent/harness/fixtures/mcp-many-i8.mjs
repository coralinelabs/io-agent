/** Fixture: an MCP server with many tools (echo_00..echo_NN, about 600 schema bytes each). */
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
const [countArg = '30', log] = process.argv.slice(2)
const count = Number(countArg)
const record = entry => { if (log) appendFileSync(log, JSON.stringify(entry) + '\n') }
const tools = Array.from({ length: count }, (_, i) => {
  const name = `echo_${String(i).padStart(2, '0')}`
  return { name, description: `Echo the given text back unchanged (fixture tool number ${i}). Useful only for testing on-demand tool schemas.`,
    inputSchema: { type: 'object', required: ['text'], properties: {
      text: { type: 'string', description: 'The text to echo back verbatim. Any UTF-8 string is accepted and returned without modification.' },
      repeat: { type: 'integer', description: 'How many times to repeat the text in the reply. Defaults to one; values above ten are clamped to ten.' },
      prefix: { type: 'string', description: 'Optional prefix placed before the echoed text, separated by a single space character.' },
    } } }
})
process.stdin.once('end', () => process.exit(0))
createInterface({ input: process.stdin }).on('line', line => {
  const q = JSON.parse(line)
  if (q.id === undefined) return
  const result = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: value }) + '\n')
  const error = (code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { code, message } }) + '\n')
  if (q.method === 'server/discover') return error(-32601, 'Legacy test fixture')
  if (q.method === 'initialize') return result({ protocolVersion: q.params.protocolVersion, capabilities: { tools: {} },
    serverInfo: { name: 'io-agent-many-fixture', version: '1' } })
  if (q.method === 'tools/list') return result({ tools })
  if (q.method === 'tools/call') {
    record({ method: 'tools/call', name: q.params.name, arguments: q.params.arguments })
    return result({ content: [{ type: 'text', text: `${q.params.name}: ${q.params.arguments.text}` }] })
  }
  if (q.method === 'ping') return result({})
  return error(-32601, 'Unknown method')
})
