import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { runHealthcheck } from '../../src/tools/healthcheck.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => (s.closeAllConnections(), s.close(r)))))
})
async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return (server.address() as AddressInfo).port
}

describe('runHealthcheck', () => {
  test('0 when /healthz answers 200', async () => {
    let url = ''
    const port = await serve((req, res) => ((url = req.url ?? ''), res.writeHead(200).end('{"ok":true}')))
    expect(await runHealthcheck([String(port)])).toBe(0)
    expect(url).toBe('/healthz')
  })
  test('1 when it answers 503', async () => {
    const port = await serve((_req, res) => res.writeHead(503).end('{"ok":false}'))
    expect(await runHealthcheck([String(port)])).toBe(1)
  })
  test('1 when nothing listens', async () => {
    const port = await serve((_req, res) => res.end())
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
    expect(await runHealthcheck([String(port)])).toBe(1)
  })
  test('1 when it does not answer within the timeout', async () => {
    const port = await serve(() => {})
    const started = Date.now()
    expect(await runHealthcheck([String(port)], 300)).toBe(1)
    expect(Date.now() - started).toBeLessThan(2000)
  })
  test('1 without a valid port', async () => {
    expect(await runHealthcheck([])).toBe(1)
    expect(await runHealthcheck(['abc'])).toBe(1)
  })
})
