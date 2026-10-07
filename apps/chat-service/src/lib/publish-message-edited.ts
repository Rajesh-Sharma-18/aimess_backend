import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

/**
 * `message:edited` to the open transcript (`conv:<roomId>`) AND every participant's personal bus
 * (`user:<id>`), the sender included: `conv:` only reaches sockets with the chat open, so the
 * sender's other devices and recipients on the list would otherwise miss the edit until a catch-up.
 * A socket in both rooms gets it twice — clients apply edits idempotently (same id + editedAt).
 */
export async function publishMessageEdited(
  redis: Redis | Cluster,
  roomId: string,
  data: unknown,
  participantIds: string[]
): Promise<void> {
  const payload = JSON.stringify({ event: "message:edited", data });
  await redis.publish(`conv:${roomId}`, payload);
  for (const userId of new Set(participantIds.filter(Boolean))) {
    redis.publish(`user:${userId}`, payload).catch((err: unknown) => {
      logger.warn(
        `publishMessageEdited|user fan-out failed roomId=${roomId} userId=${userId}: ${String(err)}`
      );
    });
  }
}
