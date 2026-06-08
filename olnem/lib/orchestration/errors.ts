// C11 — Error classification and retry logic.
//
// Transient errors (network, timeout, rate-limit, server 5xx) are retried
// with exponential backoff. Permanent errors (auth, bad request) are not.
// The main agent stream is NOT retried mid-stream — a failed stream
// terminates the turn and the pipeline exits. Only atomic calls (verification
// agent) are retried because retrying a partial stream would send duplicate
// reasoning_chunk events to the client.

import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  RateLimitError,
  InternalServerError,
} from "@anthropic-ai/sdk";

// ─── Classification ───────────────────────────────────────────────────────────

export function isTransientError(err: unknown): boolean {
  return (
    err instanceof APIConnectionError ||
    err instanceof APIConnectionTimeoutError ||
    err instanceof RateLimitError ||
    err instanceof InternalServerError
  );
}

// Abort errors are not transient — they are intentional signals.
export function isAbortError(err: unknown): boolean {
  return (
    err instanceof APIUserAbortError ||
    (err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("aborted")))
  );
}

export function classifyError(err: unknown): {
  message: string;
  recoverable: boolean;
} {
  if (isAbortError(err)) {
    return { message: "Request aborted", recoverable: false };
  }
  if (isTransientError(err)) {
    return {
      message: err instanceof Error ? err.message : "Transient API error",
      recoverable: true,
    };
  }
  return {
    message: err instanceof Error ? err.message : String(err),
    recoverable: false,
  };
}

// ─── Retry ────────────────────────────────────────────────────────────────────

const RETRY_DEFAULTS = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10_000,
} as const;

export function makeAbortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

// Resolves after ms, or rejects immediately when signal fires — no lingering
// setTimeout after abort. This prevents stop signals from being delayed by
// backoff periods during verification retries.
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(makeAbortError()); return; }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = (): void => { clearTimeout(timer); reject(makeAbortError()); };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<typeof RETRY_DEFAULTS> & { signal?: AbortSignal } = {}
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, signal } = {
    ...RETRY_DEFAULTS,
    ...options,
  };

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // C14: check before each attempt so a stop during backoff exits immediately.
    if (signal?.aborted) throw makeAbortError();

    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Never retry abort errors or non-transient errors.
      if (isAbortError(err) || !isTransientError(err)) throw err;
      if (attempt === maxAttempts) throw err;

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      await abortableSleep(delay, signal);
    }
  }

  // Unreachable — loop always throws on final attempt.
  throw lastError;
}
