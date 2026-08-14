import { logger } from "@aimess/logger";

/**
 * Late-bound hook onto `CallService.terminateCallsBetween`.
 *
 * `initializeEventConsumers()` runs early in `server.ts`, well before the
 * service graph (and therefore CallService) is wired, so the friendship
 * consumer cannot be handed a CallService at construction time. `server.ts`
 * registers the real implementation the moment CallService exists; until then
 * this is a no-op, and the only events lost in that window are ones for calls
 * that cannot have started yet.
 */
type TerminateCallsFn = (
  userA: string,
  userB: string,
  endedBy: string
) => Promise<void>;

let terminate: TerminateCallsFn | null = null;

export function setCallTerminator(fn: TerminateCallsFn): void {
  terminate = fn;
}

/** Never throws — an event consumer must not nack over a call teardown. */
export async function terminateCallsBetweenSafe(
  userA: string,
  userB: string,
  endedBy: string
): Promise<void> {
  if (!terminate) return;
  try {
    await terminate(userA, userB, endedBy);
  } catch (err) {
    logger.warn(
      `terminateCallsBetweenSafe failed ${userA}<->${userB}: ${String(err)}`
    );
  }
}
