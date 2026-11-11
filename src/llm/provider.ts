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
  /** How many of the input tokens the vendor served from its cache; 0 when it did not say. */
  cachedInputTokens: number
}

export interface LlmProvider {
  complete(model: string, req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>
}

/** The vendor refused because of the content itself (its error carries one of the configured refusal markers). */
export class LlmContentRefused extends Error {}

/**
 * The model could not give a usable reply: timeout, network failure, an error status, or a reply that is not in the
 * expected shape. `retryable` says whether trying again can help (timeouts, network errors, 429 and 5xx); it is false
 * unless the thrower says otherwise. `retryAfterMs` is how long the vendor asked to wait first, when it said. `status`
 * is the HTTP status of the vendor's error reply, and null when there was none (timeout, network, a bad reply).
 */
export class LlmUnavailable extends Error {
  readonly retryable: boolean
  readonly retryAfterMs: number | null
  readonly status: number | null
  constructor(
    message: string,
    opts: { retryable?: boolean; retryAfterMs?: number | null; status?: number | null; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.retryable = opts.retryable ?? false
    this.retryAfterMs = opts.retryAfterMs ?? null
    this.status = opts.status ?? null
  }
}

/**
 * The reply stopped at the token cap, so it is cut off. A retry would meet the same cap and be billed again, so it is
 * not retried. Carries the tokens the vendor billed for the attempt (0 when it did not say).
 */
export class LlmTruncated extends LlmUnavailable {
  constructor(
    message: string,
    readonly inputTokens = 0,
    readonly outputTokens = 0,
    readonly cachedInputTokens = 0,
  ) {
    super(message)
  }
}
