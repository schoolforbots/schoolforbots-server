import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * Whether the module at `moduleUrl` (its `import.meta.url`) is the program that was started, and not a test or
 * another module importing it.
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}
