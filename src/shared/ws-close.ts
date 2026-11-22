import type { FastifyInstance } from 'fastify'
import type { WebSocket, WebSocketServer } from 'ws'

/**
 * How long a stopping service waits for its WebSocket clients to answer the close of their connections. Past it, the
 * connections still open are cut. Without it `ws` waits 30 seconds for each, and one client that never answers (far
 * away, or gone without a word) holds the whole stop up past its deadline.
 */
export const WS_CLOSE_GRACE_MS = 1_000

/**
 * Closes the server, so that an upgrade still on its way is refused (503) rather than let in, and every connection of
 * it; waits up to `graceMs` for the clients to answer; then cuts the connections still open. The `preClose` of
 * `@fastify/websocket`, in place of its own, which waits for the answers as long as `ws` does.
 */
export async function closeWebSockets(wss: WebSocketServer, graceMs = WS_CLOSE_GRACE_MS): Promise<void> {
  // Closing the server leaves the connections open, and no new one comes in after it: the list below is complete.
  const serverClosed = new Promise<void>((resolve) => wss.close(() => resolve()))
  const open = [...wss.clients]
  const closed = Promise.all(open.map(untilClosed))
  // A connection the service has closed already is left to finish; `close` does nothing on it.
  for (const client of open) client.close()
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs)
  })
  await Promise.race([closed, late])
  clearTimeout(timer)
  for (const client of open) {
    if (client.readyState !== client.CLOSED) client.terminate()
  }
  await Promise.all([closed, serverClosed])
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
