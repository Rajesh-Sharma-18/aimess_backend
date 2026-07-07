/**
 * Predicate + retry helper for transient PostgreSQL connection failures.
 *
 * The announcement scheduler ticks on a `setInterval`, so its Prisma queries
 * sit on connections that go idle between ticks — exactly the shape that
 * trips a "Connection terminated unexpectedly" error when the underlying pg
 * client's socket was already closed (by the server, a proxy, or a network
 * blip) before the pool noticed. Prisma surfaces this as `P1017`/`P1001` or
 * lets the raw `pg` message through unchanged, depending on where the drop
 * is detected. None of these mean the query was wrong — retrying once the
 * pool hands out a fresh connection succeeds.
 */
export function isTransientConnectionError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };

  // Prisma: P1001 = can't reach DB server, P1017 = server closed the connection.
  if (e.code === "P1001" || e.code === "P1017") return true;

  if (typeof e.message !== "string") return false;
  return (
    e.message.includes("Connection terminated unexpectedly") ||
    e.message.includes("Connection terminated due to connection timeout") ||
    e.message.includes("Server has closed the connection") ||
    e.message.includes("ECONNRESET") ||
    e.message.includes("ETIMEDOUT") ||
    e.message.includes("Client has encountered a connection error")
  );
}

/**
 * Run `op`, retrying once on a transient connection drop after a short delay
 * (long enough for the pool to open a replacement connection). Any other
 * error — or a transient error that survives the retry — is rethrown so
 * callers' existing error handling is unaffected.
 */
export async function withTransientDbRetry<T>(
  op: () => Promise<T>
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (!isTransientConnectionError(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return op();
  }
}
