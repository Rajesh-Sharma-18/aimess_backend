import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateQuery } from "../middleware/validate-query.js";
import {
  communityTimelineV2QuerySchema,
  communityChangesV2QuerySchema,
  communitySyncQuerySchema,
} from "../validators/query.validator.js";
import type { CommunityMessageController } from "../controllers/community-message.controller.js";

/**
 * V2 community routes — additive, mounted beside (never replacing) the frozen V1
 * community router. Every other community endpoint stays on V1.
 *
 * `GET /api/v2/chat/community/rooms/:roomId/messages`
 *   — opaque `cursor` (compound (createdAt,id) keyset) + before_seq/after_seq
 *     (opt-in) + around + limit. See communityTimelineV2QuerySchema.
 * `GET /api/v2/chat/community/rooms/:roomId/changes`
 *   — since_revision / limit — the zero-loss mutation-aware catch-up feed.
 * `GET /api/v2/chat/community/rooms/:roomId/sync`
 *   — since_ts / limit — interim timestamp catch-up (parity with V1 `/sync`,
 *     which was v1-only; keeps catch-up working before a full revision backfill).
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

  // Interim timestamp catch-up on V2 (V1 `/sync` was v1-only → `Cannot GET` on
  // v2). Reuses the exact V1 handler + validator; unchanged updatedAt sweep.
  router.get(
    "/rooms/:roomId/sync",
    authenticate,
    validateQuery(communitySyncQuerySchema),
    messageCtrl.syncMessages
  );

  return router;
}
