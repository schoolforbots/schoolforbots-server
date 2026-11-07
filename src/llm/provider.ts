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

/**
 * The reply stopped at the token cap, so it is cut off. A retry would meet the same cap and be billed again, so it is
 * not retried. Carries the tokens the vendor billed for the attempt (0 when it did not say).
 */
export class LlmTruncated extends LlmUnavailable {
  constructor(
    message: string,
    readonly inputTokens = 0,
    readonly outputTokens = 0,
  ) {
    super(message)
  }
}
