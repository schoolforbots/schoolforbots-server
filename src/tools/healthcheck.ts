import { isEntryPoint } from './entry-point.js'

const TIMEOUT_MS = 3000

/**
 * Asks the service on `127.0.0.1:<port>` whether it is healthy: 0 when `/healthz` answers 200 within the timeout, 1
 * otherwise. For the Docker health check; the image has no curl.
 */
export async function runHealthcheck(args: string[], timeoutMs = TIMEOUT_MS): Promise<number> {
  const port = Number(args[0])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 1
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) })
    await res.body?.cancel()
    return res.status === 200 ? 0 : 1
  } catch {
    return 1
  }
}

if (isEntryPoint(import.meta.url)) {
  runHealthcheck(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => process.exit(1),
  )
}
