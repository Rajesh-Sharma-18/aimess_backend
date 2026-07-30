import {
  COMMUNITY_MEDIA_MESSAGE_TYPES,
  MEDIA_MESSAGE_TYPES,
  mapCommunityMediaType,
} from "../constants/media-limits.js";

/**
 * `GET .../rooms/:roomId/media?type=` accepts the three profile tabs
 * (`media` / `file` / `link`) alongside a single concrete message type.
 * The tab aliases were in the query schema but never in the query: the repos
 * used `messageType: params.type`, so `type=media` matched the literal string
 * "media" and every tab returned an empty page.
 */
export const MEDIA_LIST_LINK = "link";

/** Private/group enum (upper-case). Voice/audio stay out — they are not "media files". */
const TAB_TYPES: Record<string, readonly string[]> = {
  media: ["IMAGE", "VIDEO", "GIF"],
  file: ["DOCUMENT"],
};

/** Community storage values are lower-case; "custom" is the pre-expansion catch-all. */
const COMMUNITY_TAB_TYPES: Record<string, readonly string[]> = {
  media: ["image", "video", "gif", "custom"],
  file: ["document"],
};

/** Matches a link-bearing message body (`content.text` / `message`). */
export const LINK_TEXT_REGEX = "https?://";

export function mediaTypeFilter(type?: string): string | { in: string[] } {
  const tab = type ? TAB_TYPES[type] : undefined;
  if (tab) return { in: [...tab] };
  return type ?? { in: [...MEDIA_MESSAGE_TYPES] };
}

export function communityMediaTypeFilter(
  type?: string
): string | { in: string[] } {
  const tab = type ? COMMUNITY_TAB_TYPES[type] : undefined;
  if (tab) return { in: [...tab] };
  // An unmappable concrete type must return nothing, not everything.
  if (type) return mapCommunityMediaType(type) ?? "__none__";
  return { in: [...COMMUNITY_MEDIA_MESSAGE_TYPES] };
}
