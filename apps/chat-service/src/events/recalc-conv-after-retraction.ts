import { logger } from "@aimess/logger";

import { renderConvOverrides } from "../lib/recipient-override-render.js";
import { publishConvUpdatedSafe } from "./publish-conv-updated.js";
import { buildMessagePreview } from "./publish-message-sent.js";

import type { RecipientOverride } from "../services/last-visible-resolver.js";
import type { Redis, Cluster } from "ioredis";

/**
 * The slice of PrivateMessageService / GroupMessageService this helper needs.
 * Both implement it identically, so PRIVATE and GROUP share one code path.
 */
export interface ConvLastMessageRecalcSource {
  recalculateLastMessageAfterDelete(
    roomId: string,
    removedMessageId: string
  ): Promise<{
    prevMessageId: string | null;
    messageType: string;
    content: unknown;
    senderId: string | null;
    senderName?: string;
    createdAt: Date;
    hasLastMessage: boolean;
    clientMessageId: string | null;
    sequenceNumber: number;
    revision: number;
  } | null>;
  resolveForEveryoneOverrides(
    roomId: string,
    sharedPrevMessageId: string | null,
    recipientIds: string[]
  ): Promise<Map<string, RecipientOverride | null>>;
  getUnreadCountsByUser(roomId: string): Promise<Record<string, number>>;
}

/**
 * A "<actor> pinned a message" SYSTEM line is an ordinary room message, so it
 * is very often the room's current last one. When the pin lifecycle retracts
 * that line (explicit unpin, pin-switch, or the delete-for-everyone hook), the
 * room snapshot still points at a row that is now tombstoned and every list
 * keeps previewing it — Community already recalculated here, PRIVATE and GROUP
 * did not.
 *
 * Recalculates the shared snapshot from the previous VISIBLE message and bumps
 * the affected rows. `recalculateLastMessageAfterDelete` is a repair pass, not
 * an "if it was the last one" branch: it no-ops (returns null) when the stored
 * snapshot already equals the previous visible message, so calling it after a
 * retraction that did not move the last message costs two reads and publishes
 * nothing.
 *
 * Best-effort by design: never throws — a failed list bump must not roll back
 * the pin/unpin/delete that triggered it.
 */
export async function recalcConvAfterSystemLineRetraction(params: {
  redis: Redis | Cluster;
  type: "PRIVATE" | "GROUP";
  roomId: string;
  /** The retracted SYSTEM line's message id. */
  retractedMessageId: string;
  messageService: ConvLastMessageRecalcSource;
  /** Room participants (PRIVATE) or active members (GROUP). */
  fetchRecipients: () => Promise<string[]>;
}): Promise<void> {
  const {
    redis,
    type,
    roomId,
    retractedMessageId,
    messageService,
    fetchRecipients,
  } = params;
  try {
    const recalc = await messageService.recalculateLastMessageAfterDelete(
      roomId,
      retractedMessageId
    );
    // Snapshot already correct — the retracted line was not the last message.
    if (recalc === null) return;

    publishConvUpdatedSafe({
      redis,
      type,
      roomId,
      fetchRecipients,
      resolveOverrides: (recipientIds) =>
        messageService
          .resolveForEveryoneOverrides(
            roomId,
            recalc.prevMessageId,
            recipientIds
          )
          .then((raw) => renderConvOverrides(raw)),
      resolveUnreadCounts: () => messageService.getUnreadCountsByUser(roomId),
      // Without this the bump is discarded by the client's monotonic list
      // guard — it points BACKWARD at the previous visible message.
      deleteRecalc: true,
      senderId: recalc.senderId ?? "",
      // PRIVATE rows are titled by the peer and carry no "<name>: " prefix, so
      // the private recalc resolves no name — "" is the documented value.
      senderName: type === "GROUP" ? (recalc.senderName ?? "") : "",
      lastMessageId: recalc.prevMessageId ?? "",
      // 0 = "nothing visible left" (sorts to the bottom); reusing the retracted
      // line's time would pin the row to the top.
      lastMessageAt: recalc.hasLastMessage ? recalc.createdAt.getTime() : 0,
      preview: {
        contentType: recalc.messageType,
        text: recalc.hasLastMessage
          ? buildMessagePreview(recalc.messageType, recalc.content)
          : "",
        clientMessageId: recalc.clientMessageId,
        seq: recalc.sequenceNumber,
        revision: recalc.revision,
        createdAt: recalc.createdAt.getTime(),
      },
    });
  } catch (err) {
    logger.warn(
      `recalcConvAfterSystemLineRetraction failed type=${type} roomId=${roomId} messageId=${retractedMessageId}: ${String(err)}`
    );
  }
}
