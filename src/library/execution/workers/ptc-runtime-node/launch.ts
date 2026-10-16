/** Select source or built bootstrap assets in the mounted execution world. */
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FileSystem } from "../../../filesystem/fs/index.ts"

/** Deployment-owned Node executable and optional preinstalled built bootstrap. */
export interface LaunchConfig {
  /** Executable in the subprocess world; defaults to the current Node executable. */
  nodeExecutable?: string
  /** Absolute preinstalled built bootstrap in the execution world. */
  bootstrapPath?: string
}

/**
 * Select explicit arguments without inheriting host loader or inspector flags.
 * @param fs - Filesystem mapping host bootstrap assets into the process world.
 * @param config - Optional preinstalled built bootstrap.
 * @param maxMessageBytes - Validated frame and queued-write limit.
 * @returns Arguments following the resolved Node executable.
 */
export function bootstrapArgs(fs: FileSystem, config: LaunchConfig, maxMessageBytes: number): string[] {
  if (config.bootstrapPath !== undefined) return [config.bootstrapPath, String(maxMessageBytes)]
  if ('pkg' in process) return [String(maxMessageBytes)]
  const mapped = (path: string): string => {
    const result = fs.processPathFromHostPath(path)
    if (result === undefined) throw new Error(`PTC runtime bootstrap is unavailable in the subprocess execution world: ${path}`)
    return result
  }
  // Built: process.js only defines runNodeMain; process-entry.js is the sibling that starts it.
  /* v8 ignore next 3 -- scripts/smoke.mjs runs a workflow through the built package under plain Node. */
  if (!new URL(import.meta.url).pathname.endsWith('.ts')) {
    return [mapped(fileURLToPath(new URL('./process-entry.js', import.meta.url))), String(maxMessageBytes)]
  }
  const entry = mapped(fileURLToPath(new URL('./process.ts', import.meta.url)))
  const helper = mapped(fileURLToPath(new URL('../../process/subprocess/control.ts', import.meta.url)))
  const source = `const {openInheritedControlChannel}=await import(${JSON.stringify(pathToFileURL(helper).href)});const {runNodeMain}=await import(${JSON.stringify(pathToFileURL(entry).href)});await runNodeMain(openInheritedControlChannel(),${maxMessageBytes},process);`
  return ['--input-type=module', '--eval', source]
}
