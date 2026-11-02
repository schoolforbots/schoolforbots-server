import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { exportProtocol, exportWsProtocol } from '../src/protocol/export.js'

// Writes the plugin-facing protocol to protocol/http.schema.json and protocol/ws.schema.json
// (run it after changing src/protocol/http.ts or src/protocol/ws.ts).
mkdirSync(fileURLToPath(new URL('../protocol/', import.meta.url)), { recursive: true })
for (const [name, protocol] of [
  ['http', exportProtocol()],
  ['ws', exportWsProtocol()],
] as const) {
  const file = fileURLToPath(new URL(`../protocol/${name}.schema.json`, import.meta.url))
  writeFileSync(file, `${JSON.stringify(protocol, null, 2)}\n`)
  console.log(`Wrote ${file}`)
}
