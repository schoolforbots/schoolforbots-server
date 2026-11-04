export class JsonNotFound extends Error {}

function tryParseObject(s: string): unknown {
  try {
    const v: unknown = JSON.parse(s)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** End index (inclusive) of the balanced `{…}` starting at `start`, ignoring braces inside strings; -1 if unbalanced. */
function balancedEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

/** Pulls the JSON object out of a model reply: a ```json block first, then the first balanced `{…}` that parses. */
export function extractJson(text: string): unknown {
  for (const m of text.matchAll(/```json\s*([\s\S]*?)```/gi)) {
    const v = tryParseObject((m[1] ?? '').trim())
    if (v !== undefined) return v
  }
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    const end = balancedEnd(text, i)
    if (end === -1) continue
    const v = tryParseObject(text.slice(i, end + 1))
    if (v !== undefined) return v
  }
  throw new JsonNotFound('回复里没有找到 JSON 对象')
}
