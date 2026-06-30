/**
 * Render the resolver's raw per-recipient overrides (RecipientOverride, carrying
 * a raw messageType + content) into the wire-ready RecipientBump (a rendered
 * preview) for the delete-for-everyone fan-out. Two variants because the
 * community list and the private/group conv list use different preview renderers
 * and contentType conventions — matching each surface's existing bump shape.
 */
import type { RecipientOverride } from "../services/last-visible-resolver.js";
import type { RecipientBump } from "../events/publish-conv-updated.js";
import { convertMessageToPreview } from "../services/message-preview.service.js";
import { buildMessagePreview } from "../events/publish-message-sent.js";
import { normalizeMessageType } from "./chat-message.serializer.js";

/** Community (`community:updated`) preview shape: normalized contentType,
 *  sender-less for SYSTEM lines. */
export function renderCommunityOverrides(
  raw: Map<string, RecipientOverride | null>
): Map<string, RecipientBump | null> {
  const out = new Map<string, RecipientBump | null>();
  for (const [uid, o] of raw) {
    if (!o) {
      out.set(uid, null);
      continue;
    }
    const isSystem = o.messageType.toUpperCase() === "SYSTEM";
    out.set(uid, {
      lastMessageId: o.lastMessageId,
      lastMessageAt: o.lastMessageAt,
      senderId: isSystem ? "" : o.senderId,
      senderName: isSystem ? "" : o.senderName,
      preview: {
        contentType: normalizeMessageType(o.messageType),
        text: convertMessageToPreview(o.messageType, o.content),
      },
    });
  }
  return out;
}

/** Private/Group (`conv:updated`) preview shape: raw contentType, buildMessagePreview. */
export function renderConvOverrides(
  raw: Map<string, RecipientOverride | null>
): Map<string, RecipientBump | null> {
  const out = new Map<string, RecipientBump | null>();
  for (const [uid, o] of raw) {
    if (!o) {
      out.set(uid, null);
      continue;
    }
    out.set(uid, {
      lastMessageId: o.lastMessageId,
      lastMessageAt: o.lastMessageAt,
      senderId: o.senderId,
      senderName: o.senderName,
      preview: {
        contentType: o.messageType,
        text: buildMessagePreview(o.messageType, o.content),
      },
    });
  }
  return out;
}
