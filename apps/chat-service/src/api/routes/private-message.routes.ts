import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateQuery } from "../middleware/validate-query.js";
import { validateBody } from "../middleware/validate-body.js";
import { createRateLimit } from "../../middleware/rate-limit.js";
import {
  deleteMessageQuerySchema,
  forwardMessageSchema,
  editMessageSchema,
  muteRoomSchema,
  reportMessageSchema,
} from "../validators/private-message.validator.js";
import {
  messageTimelineQuerySchema,
  messageSearchQuerySchema,
  mediaListQuerySchema,
} from "../validators/query.validator.js";
import type { PrivateRoomController } from "../controllers/private-room.controller.js";
import type { PrivateMessageController } from "../controllers/private-message.controller.js";
import type { PresenceController } from "../controllers/presence.controller.js";

const sendLimit = createRateLimit({
  windowMs: 60_000,
  maxRequests: 60,
  keyPrefix: "pm:send",
});

export function createPrivateMessageRoutes(
  roomCtrl: PrivateRoomController,
  messageCtrl: PrivateMessageController,
  presenceCtrl: PresenceController
): Router {
  const router = Router();

  // Conversation list
  router.get("/conversations", authenticate, roomCtrl.getConversationList);

  // Peer presence (online/offline + last seen)
  router.get("/presence/:userId", authenticate, presenceCtrl.getPresence);

  // Get or create room with a peer
  router.post(
    "/rooms/:peerId",
    authenticate,
    sendLimit,
    roomCtrl.getOrCreateRoom
  );

  // Delete conversation for me
  router.delete("/rooms/:roomId", authenticate, roomCtrl.deleteForMe);

  // Mute / unmute a conversation
  router.post(
    "/rooms/:roomId/mute",
    authenticate,
    validateBody(muteRoomSchema),
    roomCtrl.muteRoom
  );
  router.post("/rooms/:roomId/unmute", authenticate, roomCtrl.unmuteRoom);

  // Archive / unarchive a conversation
  router.patch("/rooms/:roomId/archive", authenticate, roomCtrl.archiveRoom);
  router.patch(
    "/rooms/:roomId/unarchive",
    authenticate,
    roomCtrl.unarchiveRoom
  );

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
    validateQuery(messageTimelineQuerySchema),
    messageCtrl.getMessages
  );

  // Shared media / docs listing for a room
  router.get(
    "/rooms/:roomId/media",
    authenticate,
    validateQuery(mediaListQuerySchema),
    messageCtrl.getRoomMedia
  );

  // Edit a message
  router.patch(
    "/messages/:messageId",
    authenticate,
    sendLimit,
    validateBody(editMessageSchema),
    messageCtrl.editMessage
  );

  // Report a message
  router.post(
    "/messages/:messageId/report",
    authenticate,
    sendLimit,
    validateBody(reportMessageSchema),
    messageCtrl.reportMessage
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

  // Pin / unpin a message (V2 — broadcasts pin:updated to pin:<roomId>)
  router.post(
    "/rooms/:roomId/messages/:messageId/pin",
    authenticate,
    sendLimit,
    messageCtrl.pin
  );
  router.delete(
    "/rooms/:roomId/messages/:messageId/pin",
    authenticate,
    sendLimit,
    messageCtrl.unpin
  );

  // Forward a private message to another private room
  router.post(
    "/rooms/:roomId/messages/:messageId/forward",
    authenticate,
    sendLimit,
    validateBody(forwardMessageSchema),
    messageCtrl.forwardMessage
  );

  // Get reactions on a private message
  router.get(
    "/rooms/:roomId/messages/:messageId/reactions",
    authenticate,
    messageCtrl.getMessageReactions
  );

  return router;
}
