import { Router, type IRouter, type Request, type Response } from "express";
import express from "express";
import { WebhookReceiver } from "livekit-server-sdk";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import type { MessagingClient } from "../grpc/clients/messaging.client.js";

/**
 * POST /livekit/webhook — signed webhook receiver for LiveKit server events.
 * See Docs/calls/CALLS-LIVEKIT.md §7 Phase 3.
 *
 * LiveKit posts with Content-Type `application/webhook+json`; the body is a
 * signed JWT in the `Authorization` header covering a SHA-256 of the raw body.
 * `WebhookReceiver.receive(rawBody, authHeader)` verifies the signature and
 * returns the decoded event.
 *
 * We ACK 200 unconditionally on shape errors — LiveKit will retry on non-2xx
 * and there's no upstream fix if we've already stored/skipped the event.
 * Only unverified/malformed requests get 401/400 so bad senders back off.
 */
export function createLiveKitWebhookRouter(
  messagingClient: MessagingClient
): IRouter {
  const router = Router();
  const receiver = new WebhookReceiver(
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET
  );

  router.post(
    "/webhook",
    // Raw body is required for signature verification.
    express.raw({ type: "application/webhook+json", limit: "1mb" }),
    async (req: Request, res: Response) => {
      const auth = req.get("Authorization");
      if (!auth) {
        res.status(401).json({ error: "missing_authorization" });
        return;
      }
      let event: {
        event?: string;
        room?: { name?: string };
      };
      try {
        // WebhookReceiver.receive expects a stringified body. express.raw gives
        // us a Buffer of the exact bytes LiveKit signed — decode utf-8 losslessly.
        const raw =
          req.body instanceof Buffer
            ? req.body.toString("utf8")
            : String(req.body);
        event = (await receiver.receive(raw, auth)) as typeof event;
      } catch (err) {
        logger.warn(`livekit webhook signature verify failed: ${String(err)}`);
        res.status(401).json({ error: "invalid_signature" });
        return;
      }

      const eventType = event.event ?? "";
      const roomName = event.room?.name ?? "";

      // `room_finished` and `participant_left` both reconcile the Call for
      // `roomName` (== callId) through the same idempotent handler.
      // `room_finished` covers the room emptying; `participant_left` additionally
      // covers the 1:1 case where one peer drops but the other stays connected —
      // the room never empties, so `room_finished` never fires, and the row would
      // otherwise sit IN_PROGRESS keeping BOTH users "busy" until the max-duration
      // sweep. LiveKit fires `participant_left` only after its own reconnection
      // grace, so a transient network blip does not trigger it. Other events are
      // dropped after a debug log — wire them later for analytics.
      if (
        (eventType === "room_finished" || eventType === "participant_left") &&
        roomName
      ) {
        try {
          await messagingClient.handleLiveKitRoomFinished({
            roomName,
            eventType,
          });
        } catch (err) {
          logger.warn(
            `livekit ${eventType} reconcile failed for room=${roomName}: ${String(err)}`
          );
          // Fall through to 200 — LiveKit shouldn't retry a business-logic miss.
        }
      } else {
        logger.debug(
          `livekit webhook received event=${eventType} room=${roomName} (no-op)`
        );
      }
      res.status(200).json({ ok: true });
    }
  );

  return router;
}
