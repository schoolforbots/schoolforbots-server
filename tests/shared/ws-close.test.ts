import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { closeWebSockets } from '../../src/shared/ws-close.js'

// Closing the connections of a stopping service: the clients that answer are let go at once, the ones that do not are
// cut after the grace.

describe('closeWebSockets', () => {
  let wss: WebSocketServer | undefined
  const clients: WebSocket[] = []

  afterEach(async () => {
    for (const c of clients.splice(0)) c.terminate()
    if (wss !== undefined) await new Promise<void>((resolve) => wss!.close(() => resolve()))
    wss = undefined
  })

  async function serverWith(n: number): Promise<WebSocketServer> {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await once(wss, 'listening')
    const { port } = wss.address() as AddressInfo
    for (let i = 0; i < n; i++) {
      const c = new WebSocket(`ws://127.0.0.1:${port}`)
      clients.push(c)
      await once(c, 'open')
    }
    while (wss.clients.size < n) await new Promise((resolve) => setTimeout(resolve, 5))
    return wss
  }

  /** The client stops reading, as one far away or gone without a word: the close is never answered. */
  const deaf = (c: WebSocket) => (c as unknown as { _socket: { pause(): void } })._socket.pause()

  test('does not wait out the grace when every client answers', async () => {
    const server = await serverWith(3)
    const started = performance.now()
    await closeWebSockets(server, 5_000)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect([...server.clients]).toEqual([])
  })

  test('cuts the clients that do not answer once the grace is over, and lets the others close', async () => {
    const server = await serverWith(3)
    deaf(clients[1]!)
    const closes = clients.map((c) => once(c, 'close').then(([code]) => code as number))
    const started = performance.now()
    await closeWebSockets(server, 300)
    const took = performance.now() - started
    expect(took).toBeGreaterThanOrEqual(250)
    expect(took).toBeLessThan(2_000)
    expect([...server.clients]).toEqual([])
    // The two that answered closed normally.
    expect(await closes[0]).toBe(1005)
    expect(await closes[2]).toBe(1005)
  })

  test('refuses an upgrade that comes in during the grace, and is not held up by it', async () => {
    // As under Fastify: the server has no port of its own, upgrades are handed to it.
    const http = createHttpServer()
    const server = new WebSocketServer({ noServer: true })
    wss = server
    http.on('upgrade', (req, socket, head) => server.handleUpgrade(req, socket, head, (ws) => server.emit('connection', ws, req)))
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`
    try {
      const first = new WebSocket(url)
      clients.push(first)
      await once(first, 'open')
      deaf(first)

      const started = performance.now()
      const closing = closeWebSockets(server, 300)
      const late = new WebSocket(url)
      clients.push(late)
      // Refused: the error that follows is expected.
      late.on('error', () => {})
      const [, response] = (await once(late, 'unexpected-response')) as [unknown, { statusCode: number }]
      expect(response.statusCode).toBe(503)
      await closing
      expect(performance.now() - started).toBeLessThan(2_000)
      expect(server.clients.size).toBe(0)
    } finally {
      wss = undefined
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  })

  test('closes the server with no clients at all', async () => {
    const server = await serverWith(0)
    await closeWebSockets(server, 5_000)
    expect(server.clients.size).toBe(0)
  })
})
