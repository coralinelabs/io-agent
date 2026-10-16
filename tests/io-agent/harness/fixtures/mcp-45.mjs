/** Deliberately tiny plain-Node server for consumer and lifecycle qualification. */
import { createInterface } from 'node:readline'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const [mode = 'normal', log] = process.argv.slice(2)
// 'env' records the environment the server was started with, then serves like 'normal'.
if (mode === 'env' && log) writeFileSync(`${log}.env.json`, JSON.stringify(process.env))
const record = event => { if (log) appendFileSync(log, JSON.stringify({ event, pid: process.pid, cwd: process.cwd() }) + '\n') }
/** Serving connections so far, counted from the shared log (this one included). */
const initializations = () => readFileSync(log, 'utf8').trim().split('\n').filter(line => JSON.parse(line).event === 'initialize').length
record('start')
process.once('exit', () => record('exit'))
process.stdin.once('end', () => process.exit(0))
createInterface({ input: process.stdin }).on('line', line => {
  const q = JSON.parse(line)
  if (q.id === undefined) return
  record(q.method)
  const result = (value, then) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: value }) + '\n', then)
  const error = (code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { code, message } }) + '\n')
  if (q.method === 'server/discover') return error(-32601, 'Legacy test fixture')
  // 'hang' never answers initialize: startup can only end by its bound.
  if (q.method === 'initialize' && mode === 'hang') return
  // 'versioned' changes its instructions on every serving connection.
  if (q.method === 'initialize') return result({ protocolVersion: q.params.protocolVersion, capabilities: { tools: {} },
    serverInfo: { name: 'io-agent-fixture', version: '1' },
    instructions: mode === 'versioned' ? `MCP_INSTRUCTION_V${initializations()}`
      : mode === 'no-tools' ? 'MCP_NO_TOOLS_INSTRUCTION' : 'MCP_ATTRIBUTED_INSTRUCTION_45' })
  if (q.method === 'tools/list') {
    if (mode === 'startup-error') return error(-32603, 'fixture startup failure')
    // 'no-tools' publishes instructions only.
    if (mode === 'no-tools') return result({ tools: [] })
    return result({ tools: [{ name: 'echo', description: 'Echo fixture input.', inputSchema: {
      type: 'object', properties: { text: { type: 'string' }, fail: { type: 'boolean' } }, required: ['text'],
    } }, ...(mode === 'versioned' ? [{ name: 'exit', description: 'Reply, then stop this server process.',
      inputSchema: { type: 'object', properties: {} } }] : [])] })
  }
  if (q.method === 'tools/call' && q.params.name === 'exit') {
    return result({ content: [{ type: 'text', text: 'Stopping.' }] }, () => process.exit(0))
  }
  if (q.method === 'tools/call') return result({ content: [{ type: 'text', text: q.params.arguments.text }],
    ...(q.params.arguments.fail ? { isError: true } : {}) })
  if (q.method === 'ping') return result({})
  return error(-32601, 'Unknown method')
})
