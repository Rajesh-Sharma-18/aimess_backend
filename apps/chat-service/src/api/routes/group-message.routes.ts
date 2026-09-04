import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateBody } from "../middleware/validate-body.js";
import { validateQuery } from "../middleware/validate-query.js";
import { validateParams } from "../middleware/validate-params.js";
import { messagingRateLimits } from "../../middleware/rate-limit.js";
import {
  deleteGroupMessageSchema,
  forwardGroupMessageSchema,
  editGroupMessageSchema,
  reportGroupMessageSchema,
  sendGroupMessageBodySchema,
  markGroupReadBodySchema,
  reactionBodySchema,
  reactionParamSchema,
} from "../validators/group-message.validator.js";
import {
  messageTimelineQuerySchema,
  messageSearchQuerySchema,
  mediaListQuerySchema,
  conversationQuerySchema,
  roomChangesQuerySchema,
} from "../validators/query.validator.js";
import { deleteMessageQuerySchema } from "../validators/private-message.validator.js";
import type { GroupMessageController } from "../controllers/group-message.controller.js";

/**
 * One 30/min bucket named `gm:send` used to cover all twelve throttled routes
 * on this router — sends, read-position writes, reactions, pins, edits, deletes,
 * reports and forwards. Scrolling a few group chats exhausted the SEND budget
 * through `POST /read` alone, which is the "Too many requests" a user actually
 * hits when they then try to type.
 *
 * Split by operation class, matching the private router. See
 * `messagingRateLimits` for the numbers and why each is what it is.
 */
const limits = messagingRateLimits("gm");

export function createGroupMessageRoutes(ctrl: GroupMessageController): Router {
  const router = Router();

  router.get(
    "/rooms/:roomId/messages/search",
    authenticate,
    validateQuery(messageSearchQuerySchema),
    ctrl.searchMessages
  );
  // Send a message into a group room (REST send → orchestrator)
  router.post(
    "/rooms/:roomId/messages",
    authenticate,
    limits.send,
    validateBody(sendGroupMessageBodySchema),
    ctrl.sendMessage
  );
  // Mark this group read up to a message (REST read → orchestrator)
  router.post(
    "/rooms/:roomId/read",
    authenticate,
    limits.read,
    validateBody(markGroupReadBodySchema),
    ctrl.markRead
  );
  router.get(
    "/rooms/:roomId/messages",
    authenticate,
    validateQuery(messageTimelineQuerySchema),
    ctrl.getMessages
  );
  router.get(
    "/rooms/:roomId/conversation",
    authenticate,
    validateQuery(conversationQuerySchema),
    ctrl.getConversation
  );
  router.get(
    "/rooms/:roomId/media",
    authenticate,
    validateQuery(mediaListQuerySchema),
    ctrl.getRoomMedia
  );

  // Zero-loss changes feed — every message whose room CHANGE `revision >
  // since_revision` (inserts AND edits/deletes/reactions), current state. Same
  // contract as the private and community equivalents.
  router.get(
    "/rooms/:roomId/changes",
    authenticate,
    validateQuery(roomChangesQuerySchema),
    ctrl.getChanges
  );

  router.post(
    "/messages/delete",
    authenticate,
    limits.interact,
    validateBody(deleteGroupMessageSchema),
    ctrl.deleteMessage
  );

  // Path-param delete, matching the private/community shape so a client needs no
  // per-conversation-type branch. The room is resolved FROM the message. The
  // body-carried `POST /messages/delete` above stays available. Message-scoped
  // routes keep the bare `/messages/...` prefix; only room-scoped ones sit under
  // `/rooms/:roomId`, so the two families can never collide.
  router.delete(
    "/messages/:messageId",
    authenticate,
    limits.interact,
    validateQuery(deleteMessageQuerySchema),
    ctrl.deleteMessageByPath
  );

  // Edit a group message (own, TEXT-only, within the 15-min window)
  router.patch(
    "/messages/:messageId",
    authenticate,
    limits.interact,
    validateBody(editGroupMessageSchema),
    ctrl.editMessage
  );

  // Single-write SET reaction — see the private router's equivalent. The
  // room-scoped add/remove toggle pair below stays available.
  router.post(
    "/messages/:messageId/react",
    authenticate,
    limits.interact,
    validateBody(reactionBodySchema),
    ctrl.setReaction
  );
  router.get("/rooms/:roomId/pins", authenticate, ctrl.getPins);

  // Pin / unpin a group message (V2 — broadcasts pin:updated to pin:<roomId>)
  router.post(
    "/rooms/:roomId/messages/:messageId/pin",
    authenticate,
    limits.interact,
    ctrl.pin
  );
  router.delete(
    "/rooms/:roomId/messages/:messageId/pin",
    authenticate,
    limits.interact,
    ctrl.unpin
  );

  // Report a group message
  router.post(
    "/rooms/:roomId/messages/:messageId/report",
    authenticate,
    limits.sensitive,
    validateBody(reportGroupMessageSchema),
    ctrl.reportMessage
  );

  // Forward a group message
  router.post(
    "/rooms/:roomId/messages/:messageId/forward",
    authenticate,
    limits.send,
    validateBody(forwardGroupMessageSchema),
    ctrl.forwardMessage
  );

  // "Viewed list" — members whose read cursor has reached this message
  router.get(
    "/rooms/:roomId/messages/:messageId/read-by",
    authenticate,
    ctrl.getMessageReadBy
  );

  // Get reactions on a group message
  router.get(
    "/rooms/:roomId/messages/:messageId/reactions",
    authenticate,
    ctrl.getMessageReactions
  );

  // Add the caller's reaction (idempotent toggle-ON → message:reaction broadcast)
  router.post(
    "/rooms/:roomId/messages/:messageId/reactions",
    authenticate,
    limits.interact,
    validateBody(reactionBodySchema),
    ctrl.addReaction
  );

  // Remove the caller's reaction (idempotent toggle-OFF → message:reaction broadcast)
  router.delete(
    "/rooms/:roomId/messages/:messageId/reactions/:emoji",
    authenticate,
    limits.interact,
    validateParams(reactionParamSchema),
    ctrl.removeReaction
  );

  return router;
}
