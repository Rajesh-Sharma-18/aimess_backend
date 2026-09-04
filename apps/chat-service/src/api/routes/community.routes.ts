import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateQuery } from "../middleware/validate-query.js";
import { validateBody } from "../middleware/validate-body.js";
import { messagingRateLimits } from "../../middleware/rate-limit.js";
import {
  communityTimelineQuerySchema,
  communitySyncQuerySchema,
  messageSearchQuerySchema,
  mediaListQuerySchema,
  conversationQuerySchema,
  roomChangesQuerySchema,
} from "../validators/query.validator.js";
import {
  editCommunityMessageSchema,
  reactCommunityMessageBodySchema,
  pinCommunityMessageSchema,
  unpinCommunityMessageSchema,
  unpinCommunityMessageQuerySchema,
  sendCommunityMessageBodySchema,
  markCommunityReadBodySchema,
  forwardCommunityMessageBodySchema,
  listRoomsSchema,
  searchRoomsSchema,
} from "../validators/community.validator.js";
import type { CommunityController } from "../controllers/community.controller.js";
import type { CommunityMessageController } from "../controllers/community-message.controller.js";

/**
 * One 30/min bucket named `cm:send` used to cover every throttled route on this
 * router — sends, read-position writes, reactions, pins, edits, deletes and
 * forwards. Communities are the busiest rooms in the product, so this was the
 * first limit users hit: opening and scrolling a few of them spent the whole
 * send allowance before a message was typed.
 *
 * Split by operation class, matching the private router. See
 * `messagingRateLimits` for the numbers and why each is what it is.
 */
const limits = messagingRateLimits("cm");

export function createCommunityRoutes(
  roomCtrl: CommunityController,
  messageCtrl: CommunityMessageController
): Router {
  const router = Router();

  // Both listings are viewer-scoped (PUBLIC communities + the caller's own
  // memberships), so they REQUIRE a token — they used to be the only two
  // unauthenticated routes on this router and returned every PRIVATE
  // community's name and last-message preview to anonymous callers.
  router.get(
    "/rooms",
    authenticate,
    validateQuery(listRoomsSchema),
    roomCtrl.getRooms
  );
  router.get(
    "/rooms/search",
    authenticate,
    validateQuery(searchRoomsSchema),
    roomCtrl.searchRooms
  );
  router.post("/rooms/:roomId/join", authenticate, roomCtrl.join);
  router.post("/rooms/:roomId/leave", authenticate, roomCtrl.leave);

  // Incremental sync: returns ALL mutations (new + edits + reactions + tombstones)
  // for the room since the given updatedAt cursor. Distinct from the timeline
  // endpoint; since_ts is required here so the intent is unambiguous.
  router.get(
    "/rooms/:roomId/sync",
    authenticate,
    validateQuery(communitySyncQuerySchema),
    messageCtrl.syncMessages
  );

  // Zero-loss changes feed — the revision-axis catch-up that `/sync` (updatedAt)
  // approximates. Returns inserts AND mutations whose `revision >
  // since_revision`, plus `resetRequired` for a deep-gap re-baseline. Same
  // contract as the private and group equivalents.
  router.get(
    "/rooms/:roomId/changes",
    authenticate,
    validateQuery(roomChangesQuerySchema),
    messageCtrl.getChanges
  );

  router.post(
    "/rooms/:roomId/messages/:messageId/pin",
    authenticate,
    limits.interact,
    validateBody(pinCommunityMessageSchema),
    messageCtrl.pinMessage
  );
  router.delete(
    "/rooms/:roomId/messages/:messageId/pin",
    authenticate,
    limits.interact,
    validateBody(unpinCommunityMessageSchema),
    messageCtrl.unpinMessage
  );

  router.get(
    "/rooms/:roomId/messages/search",
    authenticate,
    validateQuery(messageSearchQuerySchema),
    messageCtrl.searchMessages
  );
  // Send a message into a community room (REST send → orchestrator)
  router.post(
    "/rooms/:roomId/messages",
    authenticate,
    limits.send,
    validateBody(sendCommunityMessageBodySchema),
    messageCtrl.sendMessage
  );
  // Mark this community room read (coarse read-to-now; no socket broadcast)
  router.post(
    "/rooms/:roomId/read",
    authenticate,
    limits.read,
    validateBody(markCommunityReadBodySchema),
    messageCtrl.markRead
  );
  router.get(
    "/rooms/:roomId/messages",
    authenticate,
    validateQuery(communityTimelineQuerySchema),
    messageCtrl.getMessages
  );
  router.get(
    "/rooms/:roomId/conversation",
    authenticate,
    validateQuery(conversationQuerySchema),
    messageCtrl.getConversation
  );
  router.get(
    "/rooms/:roomId/media",
    authenticate,
    validateQuery(mediaListQuerySchema),
    messageCtrl.getRoomMedia
  );
  router.delete(
    "/messages/:messageId",
    authenticate,
    limits.interact,
    messageCtrl.deleteMessage
  );

  // Edit a community message (own, text-only, within the 15-min window)
  router.patch(
    "/messages/:messageId",
    authenticate,
    limits.interact,
    validateBody(editCommunityMessageSchema),
    messageCtrl.editMessage
  );

  router.post(
    "/messages/:messageId/react",
    authenticate,
    limits.interact,
    validateBody(reactCommunityMessageBodySchema),
    messageCtrl.reactToMessage
  );

  // Forward a community message into another community room (roomId path
  // param = SOURCE room, bound server-side to the message's actual room)
  router.post(
    "/rooms/:roomId/messages/:messageId/forward",
    authenticate,
    limits.send,
    validateBody(forwardCommunityMessageBodySchema),
    messageCtrl.forwardMessage
  );

  // Pin a community message (MODERATOR+)
  router.post(
    "/rooms/:roomId/pins",
    authenticate,
    limits.interact,
    validateBody(pinCommunityMessageSchema),
    messageCtrl.pinMessage
  );

  // Unpin a community message (MODERATOR+)
  router.delete(
    "/rooms/:roomId/pins/:messageId",
    authenticate,
    limits.interact,
    validateQuery(unpinCommunityMessageQuerySchema),
    messageCtrl.unpinMessage
  );

  // List pinned messages (any authenticated user)
  router.get("/rooms/:roomId/pins", authenticate, messageCtrl.getPins);

  // Navigation anchor for a community message (used by pin banner tap → jump-to-message)
  router.get(
    "/rooms/:roomId/messages/:messageId/context",
    authenticate,
    messageCtrl.getMessageContext
  );

  return router;
}
