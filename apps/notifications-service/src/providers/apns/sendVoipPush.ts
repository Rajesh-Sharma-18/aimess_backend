import apn from "@parse/node-apn";
import { logger } from "@aimess/logger";

import { env } from "../../config/env.js";
import { apnsProvider } from "./apns.js";
import type { SendPushResult } from "../firebase/sendPush.js";

interface SendVoipPushParams {
  token: string;
  /** String→string data payload — mirrors sendPush's `data` shape. */
  data: Record<string, string>;
  /** VoIP push TTL in seconds — mirrors sendPush's `ttl`. */
  ttl?: number;
}

/** APNs reasons that mean the token is permanently dead → prune it. */
const INVALID_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "Unregistered",
  "DeviceTokenNotForTopic",
]);

/**
 * Sends a VoIP push over raw APNs (never FCM) so the iOS app wakes reliably
 * for an incoming call. Data-only — no `aps.alert`/`sound`; CallKit renders
 * the incoming-call UI client-side once PushKit delivers this payload. Apple
 * requires every VoIP push to report a call to CallKit, or it can revoke the
 * app's VoIP push entitlement.
 */
export async function sendVoipPush({
  token,
  data,
  ttl = 30,
}: SendVoipPushParams): Promise<SendPushResult> {
  try {
    const notification = new apn.Notification();
    notification.pushType = "voip";
    notification.topic = `${env.APNS_BUNDLE_ID}.voip`;
    notification.expiry = Math.floor(Date.now() / 1000) + ttl;
    notification.priority = 10;
    // Use rawPayload so toJSON() returns our object verbatim. Setting
    // notification.payload (custom data) and leaving aps properties unset
    // causes apsPayload() to return undefined, which JSON.stringify silently
    // drops — the resulting APNs payload has no "aps" key at all.
    // Apple requires "aps" to be present even when empty.
    notification.rawPayload = { ...data, aps: {} };

    const result = await apnsProvider.send(notification, token);

    const failure = result.failed[0];
    if (!failure) {
      logger.info("VoIP push delivered");
      return { messageId: null, invalidToken: false };
    }

    const reason = failure.response?.reason ?? "";
    const invalidToken = INVALID_TOKEN_REASONS.has(reason);
    logger.error(
      `VoIP push failed — reason=${reason} invalidToken=${invalidToken}`
    );
    return { messageId: null, invalidToken };
  } catch (error) {
    logger.error("VoIP push threw unexpectedly");
    logger.error(error);
    return { messageId: null, invalidToken: false };
  }
}
