import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createFakeLlm } from '../../src/llm/fake.js'
import { createOpenAiCompatible } from '../../src/llm/openai-compatible.js'
import { LlmContentRefused, LlmTruncated, LlmUnavailable, type LlmRequest } from '../../src/llm/provider.js'

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void
let server: Server
let handler: Handler
let seen: { url?: string; auth?: string; body: any }[]
let baseUrl: string

const req: LlmRequest = { system: '系统段', user: '用户段', json: true, maxOutputTokens: 100, timeoutMs: 2000 }

beforeEach(async () => {
  seen = []
  handler = (_r, _b, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }))
  }
  server = createServer((r, res) => {
    let body = ''
    r.on('data', (c) => (body += c))
    r.on('end', () => {
      seen.push({ url: r.url, auth: r.headers.authorization, body: body ? JSON.parse(body) : undefined })
      handler(r, body, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

const provider = () => createOpenAiCompatible({ baseUrl, apiKey: 'sk-test', refusalMarkers: ['content refused'] })

test('a normal reply yields text and token counts, with the right request shape', async () => {
  const out = await provider().complete('m1', req)
  expect(out).toEqual({ text: '{"ok":true}', inputTokens: 7, outputTokens: 3 })
  expect(seen[0]?.url).toBe('/v1/chat/completions')
  expect(seen[0]?.auth).toBe('Bearer sk-test')
  expect(seen[0]?.body).toMatchObject({
    model: 'm1',
    max_tokens: 100,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: '系统段' },
      { role: 'user', content: '用户段' },
    ],
  })
})

test('no response_format when json is false; a trailing slash on baseUrl is fine', async () => {
  const p = createOpenAiCompatible({ baseUrl: `${baseUrl}/`, apiKey: 'k', refusalMarkers: [] })
  await p.complete('m', { ...req, json: false })
  expect(seen[0]?.url).toBe('/v1/chat/completions')
  expect(seen[0]?.body.response_format).toBeUndefined()
})

test('requestExtras are merged into the body, and cannot override the fields the provider sets', async () => {
  const extras = { thinking: { type: 'disabled' }, model: 'other', max_tokens: 1, messages: [], response_format: { type: 'text' }, temperature: 0.2 }
  const p = createOpenAiCompatible({ baseUrl, apiKey: 'k', refusalMarkers: [], requestExtras: extras })
  await p.complete('m1', req)
  expect(seen[0]?.body).toEqual({
    thinking: { type: 'disabled' },
    temperature: 0.2,
    model: 'm1',
    max_tokens: 100,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: '系统段' },
      { role: 'user', content: '用户段' },
    ],
  })
})

test('a reply cut off at the token cap is LlmTruncated, carrying the tokens that were billed', async () => {
  handler = (_r, _b, res) => {
    res.end(JSON.stringify({ choices: [{ message: { content: '{"a":{"b":1}' }, finish_reason: 'length' }], usage: { prompt_tokens: 40, completion_tokens: 100 } }))
  }
  const err = await provider().complete('m', req).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(LlmTruncated)
  expect(err).toBeInstanceOf(LlmUnavailable)
  expect(err).toMatchObject({ inputTokens: 40, outputTokens: 100 })
  expect(String((err as Error).message)).not.toContain('"b"')
})

test('a cut-off reply without usage numbers is still LlmTruncated, with no tokens known', async () => {
  handler = (_r, _b, res) => res.end(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }))
  await expect(provider().complete('m', req)).rejects.toMatchObject({ inputTokens: 0, outputTokens: 0 })
  await expect(provider().complete('m', req)).rejects.toBeInstanceOf(LlmTruncated)
})

test('other finish reasons are a normal reply', async () => {
  handler = (_r, _b, res) =>
    res.end(JSON.stringify({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }))
  await expect(provider().complete('m', req)).resolves.toEqual({ text: 'x', inputTokens: 1, outputTokens: 2 })
})

test('a 400 whose body holds a refusal marker is LlmContentRefused', async () => {
  handler = (_r, _b, res) => {
    res.statusCode = 400
    res.end(JSON.stringify({ error: { message: 'content refused' } }))
  }
  await expect(provider().complete('m', req)).rejects.toBeInstanceOf(LlmContentRefused)
})

test('500, 429 and a non-refusal 400 are LlmUnavailable', async () => {
  for (const status of [500, 429, 400]) {
    handler = (_r, _b, res) => {
      res.statusCode = status
      res.end('出错了')
    }
    await expect(provider().complete('m', req)).rejects.toBeInstanceOf(LlmUnavailable)
  }
})

const replyWith = (status: number, headers: Record<string, string> = {}) => {
  handler = (_r, _b, res) => {
    res.statusCode = status
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
    res.end('出错了')
  }
}
const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as LlmUnavailable)

test('marks timeouts, network errors, 429 and 5xx as retryable', async () => {
  handler = () => {}
  expect(await failure(provider().complete('m', { ...req, timeoutMs: 100 }))).toMatchObject({ retryable: true })
  for (const status of [429, 500, 503]) {
    replyWith(status)
    expect(await failure(provider().complete('m', req))).toMatchObject({ retryable: true })
  }
  await new Promise((resolve) => server.close(resolve))
  expect(await failure(provider().complete('m', req))).toMatchObject({ retryable: true })
})

test('does not retry 400, 401, 402 or a malformed reply', async () => {
  for (const status of [400, 401, 402]) {
    replyWith(status)
    expect(await failure(provider().complete('m', req))).toMatchObject({ retryable: false })
  }
  handler = (_r, _b, res) => res.end('<html>nope</html>')
  expect(await failure(provider().complete('m', req))).toMatchObject({ retryable: false })
  handler = (_r, _b, res) => res.end(JSON.stringify({ choices: [] }))
  expect(await failure(provider().complete('m', req))).toMatchObject({ retryable: false })
})

test('reads Retry-After as seconds or a date', async () => {
  replyWith(429, { 'retry-after': '2' })
  expect(await failure(provider().complete('m', req))).toMatchObject({ retryable: true, retryAfterMs: 2000 })
  replyWith(503, { 'retry-after': new Date(Date.now() + 3000).toUTCString() })
  const ms = ((await failure(provider().complete('m', req))) as LlmUnavailable).retryAfterMs
  expect(ms).toBeGreaterThan(1900)
  expect(ms).toBeLessThanOrEqual(3000)
  for (const bad of ['soon', '-1', new Date(Date.now() - 60_000).toUTCString()]) {
    replyWith(429, { 'retry-after': bad })
    expect(await failure(provider().complete('m', req))).toMatchObject({ retryable: true, retryAfterMs: null })
  }
  replyWith(429)
  expect(await failure(provider().complete('m', req))).toMatchObject({ retryAfterMs: null })
})

test('a refusal marker is also honoured on non-400 errors', async () => {
  handler = (_r, _b, res) => {
    res.statusCode = 403
    res.end('content refused')
  }
  await expect(provider().complete('m', req)).rejects.toBeInstanceOf(LlmContentRefused)
})

test('a hung server hits the timeout as LlmUnavailable', async () => {
  handler = () => {}
  await expect(provider().complete('m', { ...req, timeoutMs: 100 })).rejects.toBeInstanceOf(LlmUnavailable)
})

test('a fractional or spent timeout is rounded up to a whole millisecond instead of throwing', async () => {
  await expect(provider().complete('m', { ...req, timeoutMs: 1999.37 })).resolves.toMatchObject({ text: '{"ok":true}' })
  handler = () => {}
  await expect(provider().complete('m', { ...req, timeoutMs: -5 })).rejects.toBeInstanceOf(LlmUnavailable)
})

test('the caller signal aborts the call as LlmUnavailable', async () => {
  handler = () => {}
  const ac = new AbortController()
  const p = provider().complete('m', req, ac.signal)
  setTimeout(() => ac.abort(), 50)
  await expect(p).rejects.toBeInstanceOf(LlmUnavailable)
})

test('non-JSON, missing fields and a refused connection are LlmUnavailable', async () => {
  handler = (_r, _b, res) => res.end('<html>nope</html>')
  await expect(provider().complete('m', req)).rejects.toBeInstanceOf(LlmUnavailable)
  handler = (_r, _b, res) => res.end(JSON.stringify({ choices: [] }))
  await expect(provider().complete('m', req)).rejects.toBeInstanceOf(LlmUnavailable)
  handler = (_r, _b, res) => res.end(JSON.stringify({ choices: [{ message: { content: 'x' } }] }))
  await expect(provider().complete('m', req)).rejects.toBeInstanceOf(LlmUnavailable)
  await new Promise((resolve) => server.close(resolve))
  await expect(provider().complete('m', req)).rejects.toBeInstanceOf(LlmUnavailable)
})

test('error messages never carry prompt or reply text', async () => {
  handler = (_r, _b, res) => res.end('回复里的秘密内容')
  const err = await provider().complete('m', req).catch((e: Error) => e)
  expect(String((err as Error).message)).not.toMatch(/用户段|系统段|秘密内容/)
})

test('the fake records calls and returns scripted replies or errors', async () => {
  const fake = createFakeLlm((_m, r) => (r.user === 'bad' ? new LlmUnavailable('x') : { text: 'ok', inputTokens: 1, outputTokens: 2 }))
  expect(await fake.complete('m', { ...req, user: 'good' })).toEqual({ text: 'ok', inputTokens: 1, outputTokens: 2 })
  await expect(fake.complete('m', { ...req, user: 'bad' })).rejects.toBeInstanceOf(LlmUnavailable)
  expect(fake.calls.map((c) => c.req.user)).toEqual(['good', 'bad'])
})
