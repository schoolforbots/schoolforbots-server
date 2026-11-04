import { LlmContentRefused, LlmUnavailable, type LlmProvider } from './provider.js'

/**
 * Talks to any vendor that speaks the OpenAI chat-completions format. Error messages carry only the status or the
 * failure kind, never the prompt, the reply or the vendor's error body, so nothing written to program logs holds content.
 */
export function createOpenAiCompatible(opts: { baseUrl: string; apiKey: string; refusalMarkers: string[] }): LlmProvider {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`
  return {
    async complete(model, req, signal) {
      // AbortSignal.timeout throws on a fraction or a negative number, so round up to at least one millisecond.
      const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(req.timeoutMs)))
      const body = {
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
        throw new LlmUnavailable(`大模型调用失败：${kind}`, { cause: err instanceof Error ? err.name : undefined })
      }
      if (!res.ok) {
        if (opts.refusalMarkers.some((m) => m !== '' && raw.includes(m))) throw new LlmContentRefused(`大模型因内容拒绝了请求（HTTP ${res.status}）`)
        throw new LlmUnavailable(`大模型返回了错误（HTTP ${res.status}）`)
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
      if (typeof text !== 'string' || !Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) {
        throw new LlmUnavailable('大模型的回复缺少必要的字段')
      }
      return { text, inputTokens, outputTokens }
    },
  }
}
