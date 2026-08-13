import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateBody } from "../middleware/validate-body.js";
import { createRateLimit } from "../../middleware/rate-limit.js";
import {
  bulkLeaveConversationsSchema,
  bulkMarkReadConversationsSchema,
  bulkMuteConversationsSchema,
} from "../validators/conversation-bulk.validator.js";
import type { ConversationBulkController } from "../controllers/conversation-bulk.controller.js";

// One request fans out to up to 50 rooms, each doing real writes + socket
// fan-out, so this is the heaviest write in the service per call. Keyed
// per-user by the shared limiter (see middleware/rate-limit.ts).
//
// Batch-aware, sub-linear cost. Charging 1 token regardless of size let one
// caller drive 50x the work of a single write for the same quota; charging
// `roomIds.length` would have been worse in the other direction — a single
// max-size batch would exhaust a 30/min budget outright and a legitimate
// "select all and mark read" would fail. `1 + floor(n/10)` bounds the WORK
// while keeping every realistic batch cheap: 1 id costs 1, 50 ids cost 6.
//
// The ceiling is raised 30 -> 60 to match: at the new cost function a client
// doing single-item bulk calls now gets twice the previous allowance, and ten
// full 50-item batches per minute still fit.
const bulkCost = (req: { body?: unknown }): number => {
  const roomIds = (req.body as { roomIds?: unknown } | undefined)?.roomIds;
  const count = Array.isArray(roomIds) ? roomIds.length : 1;
  return 1 + Math.floor(count / 10);
};

const bulkLimit = createRateLimit({
  windowMs: 60_000,
  maxRequests: 60,
  keyPrefix: "conv:bulk",
  cost: bulkCost,
});

export function createConversationBulkRoutes(
  ctrl: ConversationBulkController
): Router {
  const router = Router();

  // NOTE the order: validate BEFORE the limiter. Two reasons — `bulkCost` reads
  // `req.body.roomIds`, and a client with a malformed payload used to burn its
  // whole quota on 400s and then lock itself out of the endpoint entirely.
  router.post(
    "/leave/bulk",
    authenticate,
    validateBody(bulkLeaveConversationsSchema),
    bulkLimit,
    ctrl.bulkLeave
  );

  router.post(
    "/mute/bulk",
    authenticate,
    validateBody(bulkMuteConversationsSchema),
    bulkLimit,
    ctrl.bulkMute
  );

  router.post(
    "/read/bulk",
    authenticate,
    validateBody(bulkMarkReadConversationsSchema),
    bulkLimit,
    ctrl.bulkMarkRead
  );

  return router;
}
