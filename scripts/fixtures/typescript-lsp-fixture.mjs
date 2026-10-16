/**
 * Qualification fixture only: expose TypeScript's real language-service answers over minimal LSP.
 * This is not a substitute for a supported external language-server distribution.
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
const ts = createRequire(import.meta.url)(process.env.IO_TEST_TYPESCRIPT)
const opened = new Map()
let generation = 0 // Compiler cache revisions span LSP close/open epochs.
const service = ts.createLanguageService({
  getCompilationSettings: () => ({ target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, noLib: true }),
  getScriptFileNames: () => [...opened.keys()],
  getScriptVersion: name => String(opened.get(name)?.version ?? 0),
  getScriptSnapshot: name => {
    const text = opened.get(name)?.text ?? ts.sys.readFile(name)
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
  },
  getCurrentDirectory: () => process.cwd(),
  getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
  fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
})
const write = message => {
  const body = Buffer.from(JSON.stringify(message))
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}
function location(item) {
  const file = service.getProgram().getSourceFile(item.fileName)
  return { uri: pathToFileURL(item.fileName).href, range: {
    start: file.getLineAndCharacterOfPosition(item.textSpan.start),
    end: file.getLineAndCharacterOfPosition(item.textSpan.start + item.textSpan.length),
  } }
}
function receive(message) {
  const { method, params = {}, id } = message
  if (method === 'exit') { service.dispose(); process.exit(0) }
  if (method === 'textDocument/didOpen') {
    const doc = params.textDocument
    // LSP may reopen at version 1; compiler versions must still change across epochs.
    opened.set(fileURLToPath(doc.uri), { text: doc.text, version: ++generation })
    return
  }
  if (method === 'textDocument/didClose') { opened.delete(fileURLToPath(params.textDocument.uri)); return }
  if (id === undefined) return
  let result = null
  try {
    if (method === 'initialize') result = { capabilities: {
      textDocumentSync: { openClose: true, change: 1 }, positionEncoding: 'utf-16',
      hoverProvider: true, definitionProvider: true, referencesProvider: true, implementationProvider: true,
    } }
    else if (method !== 'shutdown') {
      const name = fileURLToPath(params.textDocument.uri)
      const file = service.getProgram().getSourceFile(name)
      const position = file.getPositionOfLineAndCharacter(params.position.line, params.position.character)
      if (method === 'textDocument/hover') {
        const info = service.getQuickInfoAtPosition(name, position)
        result = info ? { contents: ts.displayPartsToString(info.displayParts) } : null
      } else {
        const items = method === 'textDocument/definition' ? service.getDefinitionAtPosition(name, position)
          : method === 'textDocument/references' ? service.getReferencesAtPosition(name, position)
          : service.getImplementationAtPosition(name, position)
        result = (items ?? []).map(location)
      }
    }
    write({ jsonrpc: '2.0', id, result })
  } catch (error) { write({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error) } }) }
}
let buffer = Buffer.alloc(0)
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const boundary = buffer.indexOf('\r\n\r\n')
    if (boundary < 0) break
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.toString('ascii', 0, boundary))?.[1])
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('bad fixture frame')
    const end = boundary + 4 + length
    if (buffer.length < end) break
    const message = JSON.parse(buffer.subarray(boundary + 4, end))
    buffer = buffer.subarray(end)
    receive(message)
  }
})
