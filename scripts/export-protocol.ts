import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportProtocol } from '../src/protocol/export.js'

// Writes the plugin-facing protocol to protocol/http.schema.json (run it after changing src/protocol/http.ts).
const file = fileURLToPath(new URL('../protocol/http.schema.json', import.meta.url))
mkdirSync(dirname(file), { recursive: true })
writeFileSync(file, `${JSON.stringify(exportProtocol(), null, 2)}\n`)
console.log(`Wrote ${file}`)
