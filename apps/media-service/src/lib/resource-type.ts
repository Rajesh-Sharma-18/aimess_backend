/**
 * Resolve a centralized {@link MediaResourceType} (and its owner type) from the
 * legacy upload category + the file's MIME. Chat attachments are split by media
 * kind (IMAGE/VIDEO/AUDIO/DOCUMENT) so the registry can reason about storage and
 * retention per kind without re-deriving from MIME.
 */
import {
  RESOURCE_OWNER_TYPE,
  type MediaOwnerType,
  type MediaResourceType,
} from "@aimess/constants";

import type { MediaCategoryKey } from "../config/uploads.js";

type MediaKind = "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT";

/** Map a MIME to a chat media kind. GIF and any image → IMAGE; non-A/V → DOCUMENT. */
function kindFromMime(mime: string): MediaKind {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return "IMAGE";
  if (m.startsWith("video/")) return "VIDEO";
  if (m.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
}

const CHAT_RESOURCE_PREFIX = {
  CHAT_ATTACHMENT: "PRIVATE_CHAT",
  GROUP_CHAT_ATTACHMENT: "GROUP_CHAT",
  COMMUNITY_CHAT_ATTACHMENT: "COMMUNITY_CHAT",
} as const;

/** Category (+ MIME for chat) → resource type. */
export function resolveResourceType(
  category: MediaCategoryKey,
  mime: string
): MediaResourceType {
  switch (category) {
    case "USER_AVATAR":
      return "USER_AVATAR";
    case "COMMUNITY_AVATAR":
      return "COMMUNITY_AVATAR";
    case "COMMUNITY_COVER":
      return "COMMUNITY_BANNER";
    case "GROUP_AVATAR":
      return "GROUP_AVATAR";
    case "CHAT_ATTACHMENT":
    case "GROUP_CHAT_ATTACHMENT":
    case "COMMUNITY_CHAT_ATTACHMENT":
      return `${CHAT_RESOURCE_PREFIX[category]}_${kindFromMime(
        mime
      )}` as MediaResourceType;
    default:
      return "OTHER";
  }
}

/** The owner-type that owns a given resource type. */
export function ownerTypeForResource(
  resourceType: MediaResourceType
): MediaOwnerType {
  return RESOURCE_OWNER_TYPE[resourceType];
}
