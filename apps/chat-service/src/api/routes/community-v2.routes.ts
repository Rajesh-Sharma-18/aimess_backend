import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateQuery } from "../middleware/validate-query.js";
import {
  communityTimelineV2QuerySchema,
  communityChangesV2QuerySchema,
} from "../validators/query.validator.js";
import type { CommunityMessageController } from "../controllers/community-message.controller.js";

/**
 * V2 community routes — additive, mounted beside (never replacing) the frozen V1
 * community router. Only the message timeline moves to the gap-safe
 * `sequenceNumber` cursor here; every other community endpoint stays on V1.
 *
 * `GET /api/v2/chat/community/rooms/:roomId/messages`
 *   — before_seq / after_seq / around / limit (see communityTimelineV2QuerySchema).
 * `GET /api/v2/chat/community/rooms/:roomId/changes`
 *   — since_revision / limit — the zero-loss mutation-aware catch-up feed.
 */
export function createCommunityV2Routes(
  messageCtrl: CommunityMessageController
): Router {
  const router = Router();

  router.get(
    "/rooms/:roomId/messages",
    authenticate,
    validateQuery(communityTimelineV2QuerySchema),
    messageCtrl.getMessagesV2
  );

  router.get(
    "/rooms/:roomId/changes",
    authenticate,
    validateQuery(communityChangesV2QuerySchema),
    messageCtrl.getChanges
  );

  return router;
}
