import { Router, type IRouter } from "express";

import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import type { StreamController } from "../controllers/index.js";

/**
 * API v1 routes — mounted at `/api/v1`. Every route is behind
 * `authenticateAccessToken` (token issued by auth-service). The controller is
 * injected so it can be wired with its services in `server.ts`.
 */
export function createServiceRoutes(controller: StreamController): IRouter {
  const router = Router();

  router.post("/streams", authenticateAccessToken, controller.createStream);
  // Before the `/streams/:id` routes below — Express matches in registration
  // order, so a later literal path loses to the parameter that precedes it.
  router.post(
    "/streams/resolve",
    authenticateAccessToken,
    controller.resolveSource
  );
  router.get("/streams", authenticateAccessToken, controller.listStreams);
  router.get("/streams/:id", authenticateAccessToken, controller.getStream);
  router.patch(
    "/streams/:id",
    authenticateAccessToken,
    controller.updateStream
  );
  router.delete(
    "/streams/:id",
    authenticateAccessToken,
    controller.deleteStream
  );
  router.post(
    "/streams/:id/stop",
    authenticateAccessToken,
    controller.stopStream
  );
  router.post(
    "/streams/:id/go-live",
    authenticateAccessToken,
    controller.goLive
  );
  router.post(
    "/streams/:id/heartbeat",
    authenticateAccessToken,
    controller.heartbeat
  );
  router.post(
    "/streams/:id/video-lost",
    authenticateAccessToken,
    controller.videoLost
  );
  router.post(
    "/streams/:id/video-restored",
    authenticateAccessToken,
    controller.videoRestored
  );
  router.post(
    "/streams/:id/quality",
    authenticateAccessToken,
    controller.reportQuality
  );
  router.get(
    "/streams/:id/comments",
    authenticateAccessToken,
    controller.getComments
  );
  router.get(
    "/streams/:id/viewers",
    authenticateAccessToken,
    controller.getViewers
  );
  router.get(
    "/streams/:id/publish-credentials",
    authenticateAccessToken,
    controller.getPublishCredentials
  );

  // Chat toggle — owner-only.
  router.patch(
    "/streams/:id/comment-status",
    authenticateAccessToken,
    controller.setCommentStatus
  );

  // Moderation — owner-only (enforced in the service).
  router.post("/streams/:id/ban", authenticateAccessToken, controller.banUser);
  router.delete(
    "/streams/:id/ban/:userId",
    authenticateAccessToken,
    controller.unbanUser
  );
  router.get("/streams/:id/bans", authenticateAccessToken, controller.listBans);

  // Mute — owner or community ADMIN/MODERATOR (enforced by community-service,
  // the single source of truth for the moderation mute record).
  router.post(
    "/streams/:id/mute/:userId",
    authenticateAccessToken,
    controller.muteMember
  );
  router.delete(
    "/streams/:id/mute/:userId",
    authenticateAccessToken,
    controller.unmuteMember
  );

  // Community-wide ban — ADMIN only (enforced by community-service). Distinct
  // from the owner-only, stream-local /ban above: this bans from the entire
  // community, not just this one stream.
  router.post(
    "/streams/:id/community-ban/:userId",
    authenticateAccessToken,
    controller.communityBanMember
  );
  router.delete(
    "/streams/:id/community-ban/:userId",
    authenticateAccessToken,
    controller.communityUnbanMember
  );

  // Comment reporting — any authenticated user.
  router.post(
    "/streams/:id/comments/:commentId/report",
    authenticateAccessToken,
    controller.reportComment
  );

  // Reported comments list — owner or community admin/moderator (enforced in service).
  router.get(
    "/streams/:id/comments/reports",
    authenticateAccessToken,
    controller.listCommentReports
  );

  return router;
}
