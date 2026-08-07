import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateBody } from "../middleware/validate-body.js";
import { validateQuery } from "../middleware/validate-query.js";
import { validateParams } from "../middleware/validate-params.js";
import { createRateLimit } from "../../middleware/rate-limit.js";
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

const sendLimit = createRateLimit({
  windowMs: 60_000,
  maxRequests: 30,
  keyPrefix: "gm:send",
});

export function createGroupMessageRoutes(ctrl: GroupMessageController): Router {
  const router = Router();

  router.get(
    "/:roomId/messages/search",
    authenticate,
    validateQuery(messageSearchQuerySchema),
    ctrl.searchMessages
  );
  // Send a message into a group room (REST send → orchestrator)
  router.post(
    "/:roomId/messages",
    authenticate,
    sendLimit,
    validateBody(sendGroupMessageBodySchema),
    ctrl.sendMessage
  );
  // Mark this group read up to a message (REST read → orchestrator)
  router.post(
    "/:roomId/read",
    authenticate,
    sendLimit,
    validateBody(markGroupReadBodySchema),
    ctrl.markRead
  );
  router.get(
    "/:roomId/messages",
    authenticate,
    validateQuery(messageTimelineQuerySchema),
    ctrl.getMessages
  );
  router.get(
    "/:roomId/conversation",
    authenticate,
    validateQuery(conversationQuerySchema),
    ctrl.getConversation
  );
  router.get(
    "/:roomId/media",
    authenticate,
    validateQuery(mediaListQuerySchema),
    ctrl.getRoomMedia
  );

  // Zero-loss changes feed — every message whose room CHANGE `revision >
  // since_revision` (inserts AND edits/deletes/reactions), current state. Same
  // contract as the private and community equivalents.
  router.get(
    "/:roomId/changes",
    authenticate,
    validateQuery(roomChangesQuerySchema),
    ctrl.getChanges
  );

  router.post(
    "/messages/delete",
    authenticate,
    sendLimit,
    validateBody(deleteGroupMessageSchema),
    ctrl.deleteMessage
  );

  // Path-param delete, matching the private/community shape so a client needs no
  // per-conversation-type branch. The room is resolved FROM the message. The
  // body-carried `POST /messages/delete` above stays available. Two path segments
  // after the `/groups` mount, so it never collides with `DELETE /:roomId` on the
  // group-room router (one segment) even though that router is mounted first.
  router.delete(
    "/messages/:messageId",
    authenticate,
    sendLimit,
    validateQuery(deleteMessageQuerySchema),
    ctrl.deleteMessageByPath
  );

  // Edit a group message (own, TEXT-only, within the 15-min window)
  router.patch(
    "/messages/:messageId",
    authenticate,
    sendLimit,
    validateBody(editGroupMessageSchema),
    ctrl.editMessage
  );

  // Single-write SET reaction — see the private router's equivalent. The
  // room-scoped add/remove toggle pair below stays available.
  router.post(
    "/messages/:messageId/react",
    authenticate,
    sendLimit,
    validateBody(reactionBodySchema),
    ctrl.setReaction
  );
  router.get("/:roomId/pins", authenticate, ctrl.getPins);

  // Pin / unpin a group message (V2 — broadcasts pin:updated to pin:<roomId>)
  router.post(
    "/:roomId/messages/:messageId/pin",
    authenticate,
    sendLimit,
    ctrl.pin
  );
  router.delete(
    "/:roomId/messages/:messageId/pin",
    authenticate,
    sendLimit,
    ctrl.unpin
  );

  // Report a group message
  router.post(
    "/:roomId/messages/:messageId/report",
    authenticate,
    sendLimit,
    validateBody(reportGroupMessageSchema),
    ctrl.reportMessage
  );

  // Forward a group message
  router.post(
    "/:roomId/messages/:messageId/forward",
    authenticate,
    sendLimit,
    validateBody(forwardGroupMessageSchema),
    ctrl.forwardMessage
  );

  // "Viewed list" — members whose read cursor has reached this message
  router.get(
    "/:roomId/messages/:messageId/read-by",
    authenticate,
    ctrl.getMessageReadBy
  );

  // Get reactions on a group message
  router.get(
    "/:roomId/messages/:messageId/reactions",
    authenticate,
    ctrl.getMessageReactions
  );

  // Add the caller's reaction (idempotent toggle-ON → message:reaction broadcast)
  router.post(
    "/:roomId/messages/:messageId/reactions",
    authenticate,
    sendLimit,
    validateBody(reactionBodySchema),
    ctrl.addReaction
  );

  // Remove the caller's reaction (idempotent toggle-OFF → message:reaction broadcast)
  router.delete(
    "/:roomId/messages/:messageId/reactions/:emoji",
    authenticate,
    sendLimit,
    validateParams(reactionParamSchema),
    ctrl.removeReaction
  );

  return router;
}
