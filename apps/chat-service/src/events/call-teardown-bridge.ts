/**
 * Bridge so a relationship change can end the pair's live calls without the
 * AMQP consumer owning a CallService.
 *
 * `FriendshipEventConsumer` is constructed with no arguments, long before (and
 * independently of) the DI graph in server.ts that builds CallService with its
 * LiveKit, Redis and chat-message dependencies. Threading that whole graph into
 * the consumer just to reach one method is the kind of wiring this codebase
 * already solves with a registry — see `events/unread-summary-bridge.ts`.
 *
 * server.ts registers once, after CallService exists. `notifyRelationshipEnded`
 * is a safe no-op before registration (unit tests, a service booted without
 * calling enabled), and swallows its own failures: a friendship event must
 * still be acked even if the call teardown fails.
 */
import { logger } from "@aimess/logger";

type CallTerminator = (userA: string, userB: string) => Promise<number>;

let terminator: CallTerminator | null = null;

export function registerCallTerminator(fn: CallTerminator): void {
  terminator = fn;
}

export async function notifyRelationshipEnded(
  userA: string,
  userB: string
): Promise<void> {
  if (!terminator) return;
  try {
    await terminator(userA, userB);
  } catch (err) {
    logger.warn(
      `callTeardownBridge|failed to end calls for ${userA}<->${userB}: ${String(err)}`
    );
  }
}
