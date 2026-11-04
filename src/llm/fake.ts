import type { LlmProvider, LlmRequest, LlmResponse } from './provider.js'

/** A scripted provider for tests: an `Error` returned by the script is thrown to the caller. */
export function createFakeLlm(
  script: (model: string, req: LlmRequest) => LlmResponse | Error | Promise<LlmResponse | Error>,
): LlmProvider & { calls: { model: string; req: LlmRequest }[] } {
  const calls: { model: string; req: LlmRequest }[] = []
  return {
    calls,
    async complete(model, req) {
      calls.push({ model, req })
      const out = await script(model, req)
      if (out instanceof Error) throw out
      return out
    },
  }
}
