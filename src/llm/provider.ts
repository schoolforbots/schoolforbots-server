export interface LlmRequest {
  system: string
  user: string
  /** Ask the vendor for a JSON object reply. */
  json: boolean
  maxOutputTokens: number
  timeoutMs: number
}

export interface LlmResponse {
  text: string
  inputTokens: number
  outputTokens: number
}

export interface LlmProvider {
  complete(model: string, req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>
}

/** The vendor refused because of the content itself (its error carries one of the configured refusal markers). */
export class LlmContentRefused extends Error {}

/** Timeout, network failure, 5xx, 429, or a reply that is not in the expected shape. */
export class LlmUnavailable extends Error {}
