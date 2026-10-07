import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

/**
 * `community:message:edited` to the room (open transcripts) and, when the edit changed the list
 * preview, to each member's `user:` bus — `community:<room>` only reaches sockets with the room open.
 */
export async function publishCommunityMessageEdited(
  redis: Redis | Cluster,
  roomId: string,
  data: unknown,
  previewRecipientIds: string[]
): Promise<void> {
  const payload = JSON.stringify({ event: "community:message:edited", data });
  await redis.publish(`community:${roomId}`, payload);
  for (const userId of new Set(previewRecipientIds.filter(Boolean))) {
    redis.publish(`user:${userId}`, payload).catch((err: unknown) => {
      logger.warn(
        `publishCommunityMessageEdited|user fan-out failed roomId=${roomId} userId=${userId}: ${String(err)}`
      );
    });
  }
}
