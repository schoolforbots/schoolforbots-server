import type { FastifyInstance } from 'fastify'
import type { WebSocket, WebSocketServer } from 'ws'

/**
 * How long a stopping service waits for its WebSocket clients to answer the close of their connections. Past it, the
 * connections still open are cut. Without it `ws` waits 30 seconds for each, and one client that never answers (far
 * away, or gone without a word) holds the whole stop up past its deadline.
 */
export const WS_CLOSE_GRACE_MS = 1_000

/**
 * Closes every connection of `wss`, waits up to `graceMs` for the clients to answer, cuts the ones still open, then
 * closes the server. The `preClose` of `@fastify/websocket`, in place of its own, which waits for the answers as long
 * as `ws` does.
 */
export async function closeWebSockets(wss: WebSocketServer, graceMs = WS_CLOSE_GRACE_MS): Promise<void> {
  const open = [...wss.clients]
  const closed = open.map((client) => untilClosed(client))
  // A connection the service has closed already is left to finish; `close` does nothing on it.
  for (const client of open) client.close()
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs)
  })
  await Promise.race([Promise.all(closed), late])
  clearTimeout(timer)
  for (const client of open) {
    if (client.readyState !== client.CLOSED) client.terminate()
  }
  await Promise.all(closed)
  await new Promise<void>((resolve) => wss.close(() => resolve()))
}

function untilClosed(client: WebSocket): Promise<void> {
  if (client.readyState === client.CLOSED) return Promise.resolve()
  return new Promise((resolve) => client.once('close', () => resolve()))
}

/** The `preClose` option of `@fastify/websocket` that stops with `closeWebSockets`. */
export function preCloseWebSockets(graceMs = WS_CLOSE_GRACE_MS) {
  return async function preClose(this: FastifyInstance): Promise<void> {
    await closeWebSockets(this.websocketServer, graceMs)
  }
}
