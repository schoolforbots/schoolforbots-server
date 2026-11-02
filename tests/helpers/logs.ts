/** A pino destination that keeps the lines in memory, for asserting on what the service logged. */
export function captureLogs() {
  const lines: string[] = []
  const entries = () =>
    lines
      .flatMap((l) => l.split('\n'))
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Record<string, any>)
  return { stream: { write: (line: string) => void lines.push(line) }, entries }
}
