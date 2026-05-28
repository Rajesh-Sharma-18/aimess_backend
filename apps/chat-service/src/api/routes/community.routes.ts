import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateQuery } from "../middleware/validate-query.js";
import { createRateLimit } from "../../middleware/rate-limit.js";
import {
  messageListQuerySchema,
  messageSearchQuerySchema,
} from "../validators/query.validator.js";
import type { CommunityController } from "../controllers/community.controller.js";
import type { CommunityMessageController } from "../controllers/community-message.controller.js";

const messageLimit = createRateLimit({
  windowMs: 60_000,
  maxRequests: 30,
  keyPrefix: "cm:send",
});

export function createCommunityRoutes(
  roomCtrl: CommunityController,
  messageCtrl: CommunityMessageController
): Router {
  const router = Router();

  router.get("/rooms", roomCtrl.getRooms);
  router.get("/rooms/search", roomCtrl.searchRooms);
  router.post("/rooms/:roomId/join", authenticate, roomCtrl.join);
  router.post("/rooms/:roomId/leave", authenticate, roomCtrl.leave);

  router.get(
    "/rooms/:roomId/messages/search",
    authenticate,
    validateQuery(messageSearchQuerySchema),
    messageCtrl.searchMessages
  );
  router.get(
    "/rooms/:roomId/messages",
    authenticate,
    validateQuery(messageListQuerySchema),
    messageCtrl.getMessages
  );
  router.delete(
    "/messages/:messageId",
    authenticate,
    messageLimit,
    messageCtrl.deleteMessage
  );

  return router;
}
