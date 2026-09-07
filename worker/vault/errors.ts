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
