/** Build only the native primitives used by the library; no npm platform workspaces. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
const source=fileURLToPath(new URL('../src/library/execution/native/', import.meta.url));
if (!['linux','darwin'].includes(process.platform)) process.exit(0);
const libc=process.platform==='linux' ? (process.report.getReport().header.glibcVersionRuntime ? 'glibc':'musl') : '';
const out=join(source,'prebuilds',`${process.platform}-${process.arch}`,libc);mkdirSync(out,{recursive:true});
const headers=resolve(dirname(process.execPath),'../include/node');
if(!existsSync(join(headers,'node_api.h')))throw Error('Node development headers are required to build flock');
const flags=['-std=c11','-O2','-Wall','-Wextra','-Werror','-fPIC','-shared','-DNAPI_VERSION=8','-I'+headers];
if(process.platform==='darwin')flags.push('-undefined','dynamic_lookup');
const result=spawnSync(process.env.CC??'cc',[...flags,join(source,'flock.c'),'-o',join(out,'system.node')],{stdio:'inherit'});
if(result.status!==0)throw Error('Native flock build failed');
// Confinement is never weakened by missing build tools. A distribution must carry the
// independently qualified static launcher; the sandbox fails closed when it is absent.
if(process.platform==='linux' && spawnSync('musl-gcc',['--version'],{stdio:'ignore'}).status===0){
 const p=spawnSync('musl-gcc',['-std=c11','-Os','-Wall','-Wextra','-Werror','-static','-s',join(source,'main.c'),'-o',join(source,'prebuilds',`${process.platform}-${process.arch}`,'landlock-run')],{stdio:'inherit'});
 if(p.status!==0)throw Error('Static sandbox launcher build failed');
}else if(process.platform==='linux')console.warn('Static sandbox launcher not built: musl-gcc unavailable. Confinement must fail closed.');
