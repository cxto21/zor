/**
 * Starkscan prover error taxonomy.
 *
 * Terminal = do not retry/poll (fix input).
 * Retryable = transient, caller may retry with same Idempotency-Key.
 * BudgetExhausted = daily quota hit, honor Retry-After / wait until UTC midnight.
 */

export class StarkscanTerminalError extends Error {
  readonly code: string | number;
  readonly retryAfter?: number;

  constructor(message: string, code: string | number, retryAfter?: number) {
    super(message);
    this.name = "StarkscanTerminalError";
    this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export class StarkscanRetryableError extends Error {
  readonly code: string | number;
  readonly retryAfter?: number;

  constructor(message: string, code: string | number, retryAfter?: number) {
    super(message);
    this.name = "StarkscanRetryableError";
    this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

/**
 * Daily budget exhausted — caller must defer until Retry-After or UTC midnight.
 * Extends retryable semantics but surfaced separately for rate-limiter handling.
 */
export class BudgetExhaustedError extends StarkscanRetryableError {
  constructor(
    message: string = "Starkscan daily budget exhausted",
    code: string | number = "prover_daily_budget_exhausted",
    retryAfter?: number,
  ) {
    super(message, code, retryAfter);
    this.name = "BudgetExhaustedError";
  }
}

/** Alias kept for callers that reference the fully-qualified name. */
export const StarkscanBudgetExhaustedError = BudgetExhaustedError;

/** Type guard helpers */
export function isTerminalError(e: unknown): e is StarkscanTerminalError {
  return e instanceof StarkscanTerminalError;
}

export function isRetryableError(e: unknown): e is StarkscanRetryableError {
  return e instanceof StarkscanRetryableError;
}

export function isBudgetExhaustedError(e: unknown): e is BudgetExhaustedError {
  return e instanceof BudgetExhaustedError;
}

// ── Classifier ──────────────────────────────────────────────────────────

/**
 * Classify Starkscan error codes into retry/terminal/budget buckets.
 *
 * Codes:
 *  24 → re-pin to older block (retryable)
 *  55, 61, 1000, -32603 → terminal (fix input)
 *  prover_unavailable, prover_queue_full → retryable (backoff)
 *  prover_key_concurrency → retryable (wait in-flight)
 *  prover_daily_budget_exhausted → BudgetExhausted (wait Retry-After / midnight)
 *  prover_* unknown → retryable
 */
export function classifyStarkscanError(
  code: string | number,
  message?: string,
  retryAfter?: number,
): StarkscanTerminalError | StarkscanRetryableError | BudgetExhaustedError {
  const normalized = String(code);
  const msg = message ?? `Starkscan error ${code}`;

  if (normalized === "prover_daily_budget_exhausted") {
    return new BudgetExhaustedError(msg, code, retryAfter);
  }
  if (["55", "61", "1000", "-32603"].includes(normalized)) {
    return new StarkscanTerminalError(msg, code, retryAfter);
  }
  if (normalized === "24") {
    return new StarkscanRetryableError(
      message ?? "Block not found — re-pin to older finalized block",
      code,
      retryAfter,
    );
  }
  if (
    normalized === "prover_unavailable" ||
    normalized === "prover_queue_full" ||
    normalized === "prover_key_concurrency"
  ) {
    return new StarkscanRetryableError(msg, code, retryAfter);
  }
  if (normalized.startsWith("prover_")) {
    return new StarkscanRetryableError(msg, code, retryAfter);
  }
  // Unknown numeric codes default to terminal to avoid infinite retry
  return new StarkscanTerminalError(msg, code, retryAfter);
}
