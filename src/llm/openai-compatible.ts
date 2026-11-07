import { LlmContentRefused, LlmTruncated, LlmUnavailable, type LlmProvider } from './provider.js'

/** `Retry-After` is whole seconds or an HTTP date; anything else, a negative number or a past date means no hint. */
function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null
  const v = value.trim()
  if (/^\d+$/.test(v)) return Number(v) * 1000
  if (/^-?\d/.test(v) && !/[a-z]/i.test(v)) return null
  const at = Date.parse(v)
  if (Number.isNaN(at)) return null
  const ms = at - Date.now()
  return ms > 0 ? ms : null
}

/** The input tokens served from the vendor's cache, as either of the two usual usage fields says; 0 when absent or not a non-negative number. */
function cachedTokensOf(usage: any): number {
  const reported = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens
  return Number.isFinite(reported) && reported >= 0 ? reported : 0
}

/**
 * Talks to any vendor that speaks the OpenAI chat-completions format. Error messages carry only the status or the
 * failure kind, never the prompt, the reply or the vendor's error body, so nothing written to program logs holds content.
 */
export function createOpenAiCompatible(opts: { baseUrl: string; apiKey: string; refusalMarkers: string[]; requestExtras?: Record<string, unknown> }): LlmProvider {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`
  return {
    async complete(model, req, signal) {
      // AbortSignal.timeout throws on a fraction or a negative number, so round up to at least one millisecond.
      const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(req.timeoutMs)))
      const body = {
        ...opts.requestExtras,
        model,
        max_tokens: req.maxOutputTokens,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      }
      let res: Response
      let raw: string
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
        raw = await res.text()
      } catch (err) {
        const kind = timeout.aborted ? '超时' : signal?.aborted ? '已取消' : '网络错误'
        throw new LlmUnavailable(`大模型调用失败：${kind}`, { retryable: true, cause: err instanceof Error ? err.name : undefined })
      }
      if (!res.ok) {
        if (opts.refusalMarkers.some((m) => m !== '' && raw.includes(m))) throw new LlmContentRefused(`大模型因内容拒绝了请求（HTTP ${res.status}）`)
        const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599)
        throw new LlmUnavailable(`大模型返回了错误（HTTP ${res.status}）`, {
          retryable,
          retryAfterMs: retryable ? parseRetryAfter(res.headers.get('retry-after')) : null,
        })
      }
      let parsed: any
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new LlmUnavailable('大模型的回复不是 JSON')
      }
      const text = parsed?.choices?.[0]?.message?.content
      const inputTokens = parsed?.usage?.prompt_tokens
      const outputTokens = parsed?.usage?.completion_tokens
      const cachedInputTokens = cachedTokensOf(parsed?.usage)
      // A reply cut off at the cap may still hold a complete inner JSON object, so it must not reach the caller.
      if (parsed?.choices?.[0]?.finish_reason === 'length') {
        throw new LlmTruncated(
          '大模型的回复被截断了（达到了输出长度上限）',
          Number.isFinite(inputTokens) ? inputTokens : 0,
          Number.isFinite(outputTokens) ? outputTokens : 0,
          cachedInputTokens,
        )
      }
      if (typeof text !== 'string' || !Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) {
        throw new LlmUnavailable('大模型的回复缺少必要的字段')
      }
      return { text, inputTokens, outputTokens, cachedInputTokens }
    },
  }
}
