import type { Host, JobOutputCursor, JobOutputPage } from '@coralinelabs/io-agent/host'
import { liveConfig, type ExtensionManager } from '@coralinelabs/io-agent/extensions'

declare const host: Host
declare const manager: ExtensionManager
const cursor: JobOutputCursor = { streamId: 'stream-generation', offset: 4 }
const page: JobOutputPage = host.readLiveJobOutput('session', 'bash-1', {cursor,maxBytes:1024})
const next: number = page.cursor.offset
void next
const pages: AsyncIterable<JobOutputPage> = host.followJobOutput('session','bash-1',{cursor},new AbortController().signal)
void pages
void manager.configure('extension', {limit:2}, 1)
const ref = liveConfig({limit:2,nested:{items:['a']}})
const limit: number = ref.get().limit
void limit
// @ts-expect-error cursor offsets are byte positions, not strings
host.readLiveJobOutput('session','bash-1',{cursor:{streamId:'stream',offset:'4'}})
// @ts-expect-error configure uses numeric revision checks
void manager.configure('extension',{},'revision')
// @ts-expect-error nested snapshots are readonly
ref.get().nested.items.push('changed')
// @ts-expect-error plugins cannot publish snapshots through the read interface
ref.set({limit:4})
