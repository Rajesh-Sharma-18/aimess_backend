import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateQuery } from "../middleware/validate-query.js";
import { validateBody } from "../middleware/validate-body.js";
import { validateParams } from "../middleware/validate-params.js";
import { createRateLimit } from "../../middleware/rate-limit.js";
import {
  deleteMessageQuerySchema,
  forwardMessageSchema,
  editMessageSchema,
  muteRoomSchema,
  autoDeleteSchema,
  reportMessageSchema,
  reportPrivateUserSchema,
  sendPrivateMessageBodySchema,
  markReadBodySchema,
  reactionBodySchema,
  reactionParamSchema,
} from "../validators/private-message.validator.js";
import {
  messageTimelineQuerySchema,
  messageSearchQuerySchema,
  mediaListQuerySchema,
  privateConversationListQuerySchema,
  roomChangesQuerySchema,
} from "../validators/query.validator.js";
import type { PrivateRoomController } from "../controllers/private-room.controller.js";
import type { PrivateMessageController } from "../controllers/private-message.controller.js";
import type { PresenceController } from "../controllers/presence.controller.js";

/**
 * One bucket named `pm:send` used to cover all fourteen throttled routes on
 * this router — sends, reads, reactions, pins, edits, reports and
 * get-or-create — at 60/min combined. Opening a handful of conversations and
 * scrolling them exhausted the SEND budget through `POST /read` alone, which is
 * the single most likely source of the "Too many requests" users actually see.
 *
 * Split by operation class. Send capacity is unchanged at 60/min (that is the
 * abuse-relevant number); the rest get budgets that match how often a normal
 * client legitimately calls them.
 */
const sendLimit = createRateLimit({
  windowMs: 60_000,
  maxRequests: 60,
  keyPrefix: "pm:send",
});

/**
 * Read-position writes. Called on every conversation open, every scroll to
 * bottom and every socket reconnect catch-up, so the ceiling has to clear a
 * reconnect burst across many open rooms without tripping.
 */
const readLimit = createRateLimit({
  windowMs: 60_000,
  maxRequests: 240,
  keyPrefix: "pm:read",
});

/** Reactions, pins and edits — interactive, bursty, individually cheap. */
const interactLimit = createRateLimit({
  windowMs: 60_000,
  maxRequests: 120,
  keyPrefix: "pm:interact",
});

/**
 * Low-frequency, abuse-sensitive operations: reporting, changing the
 * auto-delete policy, and get-or-create-room (which mints rows). Tighter than
 * the old shared 60/min, because none of these is a normal repeated action.
 */
const sensitiveLimit = createRateLimit({
  windowMs: 60_000,
  maxRequests: 30,
  keyPrefix: "pm:sensitive",
});

export function createPrivateMessageRoutes(
  roomCtrl: PrivateRoomController,
  messageCtrl: PrivateMessageController,
  presenceCtrl: PresenceController
): Router {
  const router = Router();

  // Conversation list
  router.get(
    "/conversations",
    authenticate,
    validateQuery(privateConversationListQuerySchema),
    roomCtrl.getConversationList
  );

  // Peer presence (online/offline + last seen)
  router.get("/presence/:userId", authenticate, presenceCtrl.getPresence);

  // Get or create room with a peer
  router.post(
    "/rooms/:peerId",
    authenticate,
    sensitiveLimit,
    roomCtrl.getOrCreateRoom
  );

  // Room details — community-getById-aligned response (peer info, avatar,
  // presence, friendship). Accepts either the room's own id (`prv_...`) or a
  // peer's userId — see PrivateRoomController.getRoomDetails.
  router.get("/rooms/:peerId", authenticate, roomCtrl.getRoomDetails);

  // Delete conversation for me
  router.delete("/rooms/:roomId", authenticate, roomCtrl.deleteForMe);
  router.post("/rooms/:roomId/clear", authenticate, roomCtrl.clearChat);

  // Mute / unmute a conversation
  router.post(
    "/rooms/:roomId/mute",
    authenticate,
    validateBody(muteRoomSchema),
    roomCtrl.muteRoom
  );
  router.post("/rooms/:roomId/unmute", authenticate, roomCtrl.unmuteRoom);

  // Report the peer of this conversation (user-level, not message-level) —
  // private-chat counterpart of POST /chat/group-members/report.
  router.post(
    "/rooms/:roomId/report",
    authenticate,
    sensitiveLimit,
    validateBody(reportPrivateUserSchema),
    roomCtrl.reportUser
  );

  // Automatically Delete Messages (disappearing messages) — per-user setting
  router.get(
    "/rooms/:roomId/auto-delete",
    authenticate,
    roomCtrl.getAutoDelete
  );
  router.put(
    "/rooms/:roomId/auto-delete",
    authenticate,
    sensitiveLimit,
    validateBody(autoDeleteSchema),
    roomCtrl.setAutoDelete
  );

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

  // Send a message into a room (REST send → orchestrator)
  router.post(
    "/rooms/:roomId/messages",
    authenticate,
    sendLimit,
    validateBody(sendPrivateMessageBodySchema),
    messageCtrl.sendMessage
  );

  // Mark this conversation read up to a message (REST read → orchestrator)
  router.post(
    "/rooms/:roomId/read",
    authenticate,
    readLimit,
    validateBody(markReadBodySchema),
    messageCtrl.markRead
  );

  // Get messages in a room
  router.get(
    "/rooms/:roomId/messages",
    authenticate,
    validateQuery(messageTimelineQuerySchema),
    messageCtrl.getMessages
  );

  // Zero-loss changes feed — every message whose room CHANGE `revision >
  // since_revision` (inserts AND edits/deletes/reactions), current state. Same
  // contract as the group and community equivalents.
  router.get(
    "/rooms/:roomId/changes",
    authenticate,
    validateQuery(roomChangesQuerySchema),
    messageCtrl.getChanges
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
    interactLimit,
    validateBody(editMessageSchema),
    messageCtrl.editMessage
  );

  // Report a message
  router.post(
    "/messages/:messageId/report",
    authenticate,
    sensitiveLimit,
    validateBody(reportMessageSchema),
    messageCtrl.reportMessage
  );

  // Delete a message
  router.delete(
    "/messages/:messageId",
    authenticate,
    interactLimit,
    validateQuery(deleteMessageQuerySchema),
    messageCtrl.deleteMessage
  );

  // Single-write SET reaction. The room is resolved FROM the message, so an
  // offline queue can drain a reaction with only (messageId, emoji) and no
  // per-conversation-type branch. The room-scoped add/remove toggle pair below
  // stays available for clients that already know the room.
  router.post(
    "/messages/:messageId/react",
    authenticate,
    interactLimit,
    validateBody(reactionBodySchema),
    messageCtrl.setReaction
  );

  // Get pins in a room
  router.get("/rooms/:roomId/pins", authenticate, messageCtrl.getPins);

  // Pin / unpin a message (V2 — broadcasts pin:updated to pin:<roomId>)
  router.post(
    "/rooms/:roomId/messages/:messageId/pin",
    authenticate,
    interactLimit,
    messageCtrl.pin
  );
  router.delete(
    "/rooms/:roomId/messages/:messageId/pin",
    authenticate,
    interactLimit,
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

  // Add the caller's reaction (idempotent toggle-ON → message:reaction broadcast)
  router.post(
    "/rooms/:roomId/messages/:messageId/reactions",
    authenticate,
    interactLimit,
    validateBody(reactionBodySchema),
    messageCtrl.addReaction
  );

  // Remove the caller's reaction (idempotent toggle-OFF → message:reaction broadcast)
  router.delete(
    "/rooms/:roomId/messages/:messageId/reactions/:emoji",
    authenticate,
    interactLimit,
    validateParams(reactionParamSchema),
    messageCtrl.removeReaction
  );

  return router;
}
