import { log } from "./log";

export interface FallbackLink<T> {
  name: string;
  fn: () => Promise<T>;
}

export interface FallbackContext {
  caseId?: string | null;
  taskId: string;
  component: string;
}

/**
 * Execute a chain of strategies in order. Returns the first success.
 * Every attempt is logged (start / ok / error). If all fail, logs FATAL and throws.
 *
 * Use for any external-provider call where we have a primary + fallback.
 */
export async function withFallback<T>(
  chain: FallbackLink<T>[],
  ctx: FallbackContext
): Promise<T> {
  if (chain.length === 0) throw new Error("withFallback called with empty chain");

  let lastError: unknown = null;

  for (let i = 0; i < chain.length; i++) {
    const { name, fn } = chain[i];
    const started = Date.now();
    const attempt = i + 1;
    const primary = chain[0].name;

    await log({
      ...ctx,
      event: `${name}_start`,
      provider: name,
      attempt,
      fallback_of: attempt === 1 ? undefined : primary,
    });

    try {
      const result = await fn();
      await log({
        ...ctx,
        event: `${name}_ok`,
        provider: name,
        attempt,
        fallback_of: attempt === 1 ? undefined : primary,
        latency_ms: Date.now() - started,
      });
      return result;
    } catch (e) {
      lastError = e;
      await log({
        ...ctx,
        level: "WARN",
        event: `${name}_error`,
        provider: name,
        attempt,
        fallback_of: attempt === 1 ? undefined : primary,
        latency_ms: Date.now() - started,
        error_message: String(e).slice(0, 500),
      });
    }
  }

  await log({
    ...ctx,
    level: "FATAL",
    event: "all_fallbacks_exhausted",
    error_message: String(lastError).slice(0, 500),
  });

  throw lastError;
}

/**
 * Exponential-backoff retry for transient errors (429 / 5xx / timeout).
 * Use INSIDE a single fallback link, not across links.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    attempts?: number;
    initialDelayMs?: number;
    backoffMultiplier?: number;
    isRetryable?: (e: unknown) => boolean;
    ctx?: FallbackContext;
    providerName?: string;
  } = {}
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const initial = opts.initialDelayMs ?? 1000;
  const mult = opts.backoffMultiplier ?? 2.5;
  const isRetryable = opts.isRetryable ?? defaultRetryable;

  let lastError: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!isRetryable(e) || i === attempts - 1) throw e;
      const delay = Math.floor(initial * Math.pow(mult, i) * (0.75 + Math.random() * 0.5));
      if (opts.ctx) {
        await log({
          ...opts.ctx,
          level: "WARN",
          event: "retry_waiting",
          provider: opts.providerName,
          attempt: i + 1,
          latency_ms: delay,
          error_message: String(e).slice(0, 200),
        });
      }
      await sleep(delay);
    }
  }
  throw lastError;
}

function defaultRetryable(e: unknown): boolean {
  const s = String(e).toLowerCase();
  if (s.includes("429") || s.includes("rate limit")) return true;
  if (s.includes("5") && /\b5\d\d\b/.test(s)) return true;
  if (s.includes("timeout") || s.includes("etimedout") || s.includes("econnreset")) return true;
  if (s.includes("overloaded")) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
