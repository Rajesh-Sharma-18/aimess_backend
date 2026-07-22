import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateQuery } from "../middleware/validate-query.js";
import { createRateLimit } from "../../middleware/rate-limit.js";
import {
  privateTimelineV2QuerySchema,
  groupTimelineV2QuerySchema,
  chatChangesV2QuerySchema,
  inboxV2QuerySchema,
} from "../validators/query.validator.js";
import type { PrivateMessageController } from "../controllers/private-message.controller.js";
import type { GroupMessageController } from "../controllers/group-message.controller.js";
import type { InboxController } from "../controllers/inbox.controller.js";

/**
 * V2 chat routes — additive, mounted beside (never replacing) the frozen V1
 * `/api/chat/*` routers. Only the two endpoints below move to Cursor V2; every
 * other chat endpoint stays on V1.
 *
 * `GET /api/v2/chat/private/rooms/:roomId/messages`
 *   — opaque compound `(createdAt, id)` cursor on `before_cursor`/`after_cursor`
 *     (+ opt-in before_seq/after_seq + around + limit). Same handler, response
 *     and business logic as V1; only the pagination params change.
 * `GET /api/v2/chat/inbox`
 *   — opaque compound `(lastMessageAt, roomId)` cursor on
 *     `before_cursor`/`after_cursor` + limit.
 *
 * See `community-v2.routes.ts` — this mirrors that mount exactly.
 */
export function createPrivateV2Routes(
  messageCtrl: PrivateMessageController
): Router {
  const router = Router();

  router.get(
    "/rooms/:roomId/messages",
    authenticate,
    validateQuery(privateTimelineV2QuerySchema),
    messageCtrl.getMessagesV2
  );

  router.get(
    "/rooms/:roomId/changes",
    authenticate,
    validateQuery(chatChangesV2QuerySchema),
    messageCtrl.getChanges
  );

  return router;
}

export function createGroupV2Routes(
  messageCtrl: GroupMessageController
): Router {
  const router = Router();

  router.get(
    "/rooms/:roomId/messages",
    authenticate,
    validateQuery(groupTimelineV2QuerySchema),
    messageCtrl.getMessagesV2
  );

  router.get(
    "/rooms/:roomId/changes",
    authenticate,
    validateQuery(chatChangesV2QuerySchema),
    messageCtrl.getChanges
  );

  return router;
}

// Same per-user read limiter the V1 inbox route carries (inbox is the heaviest
// read in the service). Separate instance, separate key prefix, so V2 traffic
// does not eat a V1 client's budget.
const inboxV2Limit = createRateLimit({
  windowMs: 60_000,
  maxRequests: 120,
  keyPrefix: "inbox:list:v2",
});

export function createInboxV2Routes(ctrl: InboxController): Router {
  const router = Router();

  router.get(
    "/",
    authenticate,
    inboxV2Limit,
    validateQuery(inboxV2QuerySchema),
    ctrl.getInboxV2
  );

  return router;
}
