import { readdirSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';import { relative, join, dirname } from 'node:path';
const root=fileURLToPath(new URL('../src/',import.meta.url)),dist=fileURLToPath(new URL('../dist/',import.meta.url));
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())walk(p);else if(!/\.(?:ts|tsx)$/.test(p)){const dest=join(dist,relative(root,p));mkdirSync(dirname(dest),{recursive:true});copyFileSync(p,dest);}}}walk(root);
