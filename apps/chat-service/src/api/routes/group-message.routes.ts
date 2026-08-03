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
} from "../validators/query.validator.js";
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
  router.post(
    "/messages/delete",
    authenticate,
    sendLimit,
    validateBody(deleteGroupMessageSchema),
    ctrl.deleteMessage
  );

  // Edit a group message (own, TEXT-only, within the 15-min window)
  router.patch(
    "/messages/:messageId",
    authenticate,
    sendLimit,
    validateBody(editGroupMessageSchema),
    ctrl.editMessage
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
