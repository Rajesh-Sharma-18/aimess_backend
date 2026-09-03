/**
 * Per-process fixed-window counter, used when Redis cannot answer a rate-limit
 * question on a WRITE path.
 *
 * A write limiter that fails fully open is a limiter that disappears at exactly
 * the moment the platform is least able to absorb a flood — and it did so
 * silently, since only the fail-open itself was logged. Read paths may still
 * fail open (a stale listing is harmless); sends, OTP issuance and invite
 * creation degrade to this instead.
 *
 * It is deliberately modest: one process, wiped on restart, not shared across
 * replicas. That is strictly better than no ceiling, and it is honest about
 * what it is — the Redis counter remains the real limiter.
 */

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

/**
 * Charge `tokens` against `key` and report whether the caller stays within
 * `limit` for the current window.
 */
export function consumeFallbackWindow(params: {
  key: string;
  windowMs: number;
  limit: number;
  tokens?: number;
}): { allowed: boolean; retryAfterSec: number } {
  const { key, windowMs, limit } = params;
  const tokens = Math.max(1, params.tokens ?? 1);
  const now = Date.now();

  const existing = windows.get(key);
  const window: Window =
    existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + windowMs };

  window.count += tokens;
  windows.set(key, window);

  // Opportunistic sweep: without it a long-lived process accumulates one entry
  // per distinct key forever, which is the memory leak this map would otherwise
  // become — and the keys are frequently user-supplied.
  if (windows.size > 10_000) {
    for (const [k, v] of windows) {
      if (v.resetAt <= now) windows.delete(k);
    }
  }

  return {
    allowed: window.count <= limit,
    retryAfterSec: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
  };
}

/** Drop a key's window. Exposed for tests and for explicit resets. */
export function clearFallbackWindow(key: string): void {
  windows.delete(key);
}
