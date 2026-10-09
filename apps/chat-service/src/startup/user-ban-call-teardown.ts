/**
 * Platform ban mid-call (AIMESS-43 S13b). auth-service publishes `user:banned`
 * on `user-ban:<userId>` the moment a ban lands (`publishUserBanEvent`); every
 * chat-service instance tears down that user's live 1:1 calls so the peer stops
 * ringing / talking to a dead account instead of waiting for the 60s sweep.
 *
 * Best-effort: pub/sub is not durable, so a missed message falls back to the
 * existing sweeps. Concurrent instances are safe — each end goes through the
 * atomic status claim, so only one wins.
 */
import { logger } from "@aimess/logger";

import { createRedisSubClient } from "../config/redis.js";
import type { CallService } from "../services/call.service.js";

const PATTERN = "user-ban:*";
const PREFIX = "user-ban:";

export function startUserBanCallTeardown(
  callService: Pick<CallService, "terminateCallsForBannedUser">
): void {
  const sub = createRedisSubClient();

  sub.on("pmessage", (_pattern: string, channel: string, raw: string) => {
    if (!channel.startsWith(PREFIX)) return;
    try {
      if ((JSON.parse(raw) as { event?: string }).event !== "user:banned") return;
    } catch {
      return;
    }
    const userId = channel.slice(PREFIX.length);
    void callService.terminateCallsForBannedUser(userId).catch((err: unknown) =>
      logger.warn(`user-ban call teardown failed user=${userId}: ${String(err)}`)
    );
  });

  void sub.psubscribe(PATTERN).catch((err: unknown) => {
    logger.warn(`Failed to psubscribe ${PATTERN}: ${String(err)}`);
  });
}
