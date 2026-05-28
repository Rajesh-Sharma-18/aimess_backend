import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateBody } from "../middleware/validate-body.js";
import { validateQuery } from "../middleware/validate-query.js";
import { createRateLimit } from "../../middleware/rate-limit.js";
import {
  deleteGroupMessageSchema,
  forwardGroupMessageSchema,
} from "../validators/group-message.validator.js";
import {
  messageListQuerySchema,
  messageSearchQuerySchema,
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
  router.get(
    "/:roomId/messages",
    authenticate,
    validateQuery(messageListQuerySchema),
    ctrl.getMessages
  );
  router.post(
    "/messages/delete",
    authenticate,
    sendLimit,
    validateBody(deleteGroupMessageSchema),
    ctrl.deleteMessage
  );
  router.get("/:roomId/pins", authenticate, ctrl.getPins);

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

  return router;
}
