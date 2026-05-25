import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateQuery } from "../middleware/validate-query.js";
import { createRateLimit } from "../../middleware/rate-limit.js";
import { deleteMessageQuerySchema } from "../validators/private-message.validator.js";
import {
  messageListQuerySchema,
  messageSearchQuerySchema,
} from "../validators/query.validator.js";
import type { PrivateRoomController } from "../controllers/private-room.controller.js";
import type { PrivateMessageController } from "../controllers/private-message.controller.js";

const sendLimit = createRateLimit({
  windowMs: 60_000,
  maxRequests: 60,
  keyPrefix: "pm:send",
});

export function createPrivateMessageRoutes(
  roomCtrl: PrivateRoomController,
  messageCtrl: PrivateMessageController
): Router {
  const router = Router();

  // Conversation list
  router.get("/conversations", authenticate, roomCtrl.getConversationList);

  // Get or create room with a peer
  router.post(
    "/rooms/:peerId",
    authenticate,
    sendLimit,
    roomCtrl.getOrCreateRoom
  );

  // Delete conversation for me
  router.delete("/rooms/:roomId", authenticate, roomCtrl.deleteForMe);

  // Search messages in a room (must precede the messages list route)
  router.get(
    "/rooms/:roomId/messages/search",
    authenticate,
    validateQuery(messageSearchQuerySchema),
    messageCtrl.searchMessages
  );

  // Get messages in a room
  router.get(
    "/rooms/:roomId/messages",
    authenticate,
    validateQuery(messageListQuerySchema),
    messageCtrl.getMessages
  );

  // Delete a message
  router.delete(
    "/messages/:messageId",
    authenticate,
    sendLimit,
    validateQuery(deleteMessageQuerySchema),
    messageCtrl.deleteMessage
  );

  // Get pins in a room
  router.get("/rooms/:roomId/pins", authenticate, messageCtrl.getPins);

  return router;
}
