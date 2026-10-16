import { createIoAgent, type IoAgentOptions } from '@coralinelabs/io-agent'
import { createHost } from '@coralinelabs/io-agent/host'
import { createExtensionManager, loadFileExtension, type ExtensionSpec, type Context, type Plugin } from '@coralinelabs/io-agent/extensions'
import { mountExternalAgent, type ExternalAgentOptions } from '@coralinelabs/io-agent/integrations'
declare const ctx: Context
const native: ExternalAgentOptions = {kind:'codex',executionPolicy:'native',permissionMode:'never'}
const claude: ExternalAgentOptions = {kind:'claude-code',executionPolicy:'native',permissionMode:'dontAsk'}
void mountExternalAgent(ctx, native); void mountExternalAgent(ctx, claude)
const manager = createExtensionManager(ctx)
const plugin: Plugin<{value:string}> = {apply(_ctx: Context, config: {value:string}) { config.value.toUpperCase() }}
const spec: ExtensionSpec<{value:string}> = {id:'test',config:{value:'x'},load:()=>plugin}
void manager.install(spec); void manager.replace(spec, 1); void manager.remove('test',1)
void loadFileExtension(manager, {id:'test',file:'./test.mjs',config:{value:'x'},watch:true})
const options: IoAgentOptions = {workspace:'.',stateDirectory:'./state',model:{baseURL:'http://localhost:8000/v1',model:'served',contextWindow:32768,maxTokens:4096},externalAgents:[native,claude]}
void createIoAgent(options); void createHost
// @ts-expect-error Independent native authority must be explicitly acknowledged.
const missing: ExternalAgentOptions = {kind:'codex'}
// @ts-expect-error Not a native Codex permission mode.
const unsafe: ExternalAgentOptions = {kind:'codex',executionPolicy:'native',permissionMode:'whatever'}
// @ts-expect-error Revision is mandatory to reject stale replacement commands.
void manager.replace(spec)
// @ts-expect-error Plugin loader cannot return arbitrary data.
void manager.install({id:'bad', config:{}, load:()=>42})
// @ts-expect-error The implementation exposes no arbitrary shell launcher override.
const exec: ExternalAgentOptions = {kind:'claude-code',executionPolicy:'native',executable:'/tmp/bad'}
void [missing,unsafe,exec]
