import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { vi } from 'vitest'

/** Renders `ui` as the real pages do. */
export function show(ui: ReactElement) {
  return render(ui)
}

/** A request the page sent, as the fake server saw it. */
export interface Call {
  method: string
  path: string
  headers: Record<string, string>
  credentials: RequestCredentials | undefined
  body: unknown
}

export type Reply = { status: number; body?: unknown; raw?: string } | { networkError: true } | { pending: true }
export type Route = Reply | ((call: Call) => Reply)

export const ok = (body: unknown): Reply => ({ status: 200, body })
export const fail = (status: number, code: string, message: string): Reply => ({
  status,
  body: { error: { code, message } },
})

/**
 * Replaces `fetch` with a server that answers from `routes`, keyed `METHOD path` (the path as the page wrote it,
 * query included). A route not listed answers 404. Every call is recorded in `calls`.
 */
export function fakeServer(routes: Record<string, Route>) {
  const calls: Call[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? 'GET',
      path: String(input),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      credentials: init.credentials,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const route = routes[`${call.method} ${call.path}`]
    const found = route ?? fail(404, 'not_found', '没有找到对应的记录。')
    const reply = typeof found === 'function' ? found(call) : found
    if ('networkError' in reply) throw new TypeError('Failed to fetch')
    if ('pending' in reply) return new Promise<Response>(() => {})
    const text = reply.raw ?? (reply.body === undefined ? null : JSON.stringify(reply.body))
    return new Response(text, {
      status: reply.status,
      headers: { 'content-type': reply.raw === undefined ? 'application/json' : 'text/html' },
    })
  })
  vi.stubGlobal('fetch', fetch)
  return { calls, routes }
}

/** `rgb(...)` / `rgba(...)` / `#rrggbb` as red, green, blue (0..255) and alpha (0..1). */
function parseColor(color: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
  if (hex !== null) return [parseInt(hex[1] ?? '', 16), parseInt(hex[2] ?? '', 16), parseInt(hex[3] ?? '', 16), 1]
  const parts = /rgba?\(([^)]+)\)/.exec(color)?.[1]?.split(',').map((part) => Number(part.trim()))
  if (parts === undefined || parts.length < 3) throw new Error(`not a colour: ${color}`)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1]
}

function luminance([r, g, b]: [number, number, number]): number {
  const linear = (c: number) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** The WCAG contrast of two opaque colours, `#rrggbb`. */
export function contrast(a: string, b: string): number {
  const x = parseColor(a)
  const y = parseColor(b)
  const [light, dark] = [luminance([x[0], x[1], x[2]]), luminance([y[0], y[1], y[2]])].sort((m, n) => n - m)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

export * from './fixtures.js'
