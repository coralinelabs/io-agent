import { createIoAgent, type IoAgentOptions } from '@coralinelabs/io-agent'
import { mountLanguageServers, type LanguageServerOptions, type LspQueryRequest } from '@coralinelabs/io-agent/integrations'
declare const context: Parameters<typeof mountLanguageServers>[0]
const servers: LanguageServerOptions = { executionPolicy:'native', servers:{
  ts:{command:'/host/lsp',args:['--stdio'],extensionToLanguage:{'.ts':'typescript'},maxMessageBytes:16000000},
} }
const options: IoAgentOptions = { workspace:'/w',stateDirectory:'/state',
  model:{baseURL:'http://router/v1',model:'test',contextWindow:32000,maxTokens:4000},languageServers:servers }
void createIoAgent(options)
void mountLanguageServers(context, servers)
// @ts-expect-error policy acknowledgement required
const unsafe: LanguageServerOptions = {servers:{}}
// @ts-expect-error no invented tool operation
const operation: LspQueryRequest['operation'] = 'executeCommand'
// @ts-expect-error extension map is not an array
const map: LanguageServerOptions = {executionPolicy:'native', servers:{ts:{command:'x',extensionToLanguage:['.ts']}}}
// @ts-expect-error no fake protocol command on mount handle
void mountLanguageServers(context,servers).then(m => m.executeCommand('rm'))
