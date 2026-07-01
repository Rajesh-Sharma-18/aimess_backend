/**
 * Album send expansion: a single client "album" (multiple image/video files in
 * one send) is persisted as one message row per media item so unread counters and
 * `countUnreadBulk` stay aligned with actual message records. The caption (when
 * present) is stored only on the first row; sibling rows carry an empty body.
 */

const ALBUM_SPLIT_TYPES = new Set(["IMAGE", "VIDEO"]);

/** True when `file` is a photo/video tile (not location/contact/sticker). */
export function isAlbumMediaFile(file: Record<string, unknown>): boolean {
  const type = String(file.type ?? "").toLowerCase();
  if (type === "location" || type === "contact" || type === "sticker") {
    return false;
  }
  const mime = String(file.mime ?? file.contentType ?? "").toLowerCase();
  if (mime.startsWith("image/") || mime.startsWith("video/")) return true;
  if (type === "image" || type === "video") return true;
  // Legacy rows: objectKey/url with no type — treat as splittable media when the
  // parent messageType is IMAGE/VIDEO.
  return Boolean(file.objectKey || file.url || file.mediaKey);
}

/** Derive the per-file message type for a split album sibling. */
export function inferMediaMessageType(
  file: Record<string, unknown>,
  fallback: string
): string {
  const type = String(file.type ?? "").toLowerCase();
  const mime = String(file.mime ?? file.contentType ?? "").toLowerCase();
  if (type === "video" || mime.startsWith("video/")) return "VIDEO";
  if (type === "image" || mime.startsWith("image/")) return "IMAGE";
  return (fallback || "IMAGE").toUpperCase();
}

export function albumSiblingClientMessageId(
  baseId: string,
  index: number
): string {
  return index === 0 ? baseId : `${baseId}:${index}`;
}

/** Whether a multi-file payload should be expanded into one row per media item. */
export function shouldSplitMediaAlbum(
  messageType: string,
  files: unknown[] | undefined
): boolean {
  const type = (messageType || "").toUpperCase();
  if (!ALBUM_SPLIT_TYPES.has(type)) return false;
  const list = Array.isArray(files) ? files : [];
  if (list.length <= 1) return false;
  return list.every((f) => isAlbumMediaFile(f as Record<string, unknown>));
}

export interface DirectAlbumPart<TContent> {
  content: TContent;
  messageType: string;
  clientMessageId: string | null;
}

/**
 * Expand a private/group send payload into N single-file parts. Non-album sends
 * pass through unchanged.
 */
export function splitDirectMediaAlbum<
  T extends { text?: string; files?: unknown[] },
>(
  messageType: string,
  content: T,
  baseClientMessageId: string | null
): DirectAlbumPart<T>[] {
  const files = Array.isArray(content.files) ? content.files : [];
  if (!shouldSplitMediaAlbum(messageType, files)) {
    return [{ content, messageType, clientMessageId: baseClientMessageId }];
  }

  return files.map((file, index) => ({
    content: {
      ...content,
      text: index === 0 ? (content.text ?? "") : "",
      files: [file],
    } as T,
    messageType: inferMediaMessageType(
      file as Record<string, unknown>,
      messageType
    ),
    clientMessageId: baseClientMessageId
      ? albumSiblingClientMessageId(baseClientMessageId, index)
      : null,
  }));
}

export interface CommunityAlbumPart {
  message: string;
  messageType: string;
  attachments: Array<Record<string, unknown>>;
  clientMessageId: string | null;
}

/**
 * Expand a community send payload into N single-attachment parts. Mixed payloads
 * (e.g. location + files) are never split.
 */
export function splitCommunityMediaAlbum(
  messageType: string,
  message: string,
  attachments: Array<Record<string, unknown>> | undefined,
  baseClientMessageId: string | null
): CommunityAlbumPart[] {
  const atts = Array.isArray(attachments) ? attachments : [];
  const media = atts.filter((a) => isAlbumMediaFile(a));
  const nonMedia = atts.filter((a) => !isAlbumMediaFile(a));
  if (nonMedia.length > 0 || media.length <= 1) {
    return [
      {
        message,
        messageType,
        attachments: atts,
        clientMessageId: baseClientMessageId,
      },
    ];
  }
  if (!shouldSplitMediaAlbum(messageType, media)) {
    return [
      {
        message,
        messageType,
        attachments: atts,
        clientMessageId: baseClientMessageId,
      },
    ];
  }

  return media.map((file, index) => ({
    message: index === 0 ? message : "",
    messageType: inferMediaMessageType(file, messageType),
    attachments: [file],
    clientMessageId: baseClientMessageId
      ? albumSiblingClientMessageId(baseClientMessageId, index)
      : null,
  }));
}
