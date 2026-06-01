import { BadRequestError } from "@aimess/errors";
import type { RefinementCtx } from "zod";

import { env } from "../config/env.js";

/**
 * Centralized media/text caps for chat attachments. Byte tunables are read from
 * env so ops can adjust them without a code change; the table below is the
 * single source of truth consumed by the send validators (Zod superRefine) and
 * the defensive service-layer guard `assertAttachmentsValid`.
 */

/** Max text length for any chat message body (send + edit). */
export const CHAT_TEXT_MAX_CHARS = env.CHAT_TEXT_MAX_CHARS;

/** Window during which a sender may still edit their own message. */
export const CHAT_EDIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Canonical media-bearing message types (private/group enum, upper-case). Used
 * by the per-room media-list filters so the whitelist lives in one place.
 */
export const MEDIA_MESSAGE_TYPES = [
  "IMAGE",
  "VIDEO",
  "GIF",
  "VOICE",
  "DOCUMENT",
  "STICKER",
] as const;

/**
 * Map an incoming (upper-cased) media-list `type` filter to the community
 * storage value. Community stores IMAGE/VOICE/STICKER lower-cased and carries
 * VIDEO/GIF/DOCUMENT as "custom". Returns undefined for unknown/non-media types
 * so callers can decide on an empty result rather than broadening the query.
 */
const COMMUNITY_MEDIA_TYPE_MAP: Record<string, string> = {
  IMAGE: "image",
  VOICE: "voice",
  STICKER: "sticker",
  VIDEO: "custom",
  GIF: "custom",
  DOCUMENT: "custom",
};

/** Distinct community storage values that hold media. */
export const COMMUNITY_MEDIA_MESSAGE_TYPES = [
  "image",
  "voice",
  "sticker",
  "custom",
] as const;

/** Resolve a community media storage value for an incoming `type` filter. */
export function mapCommunityMediaType(type: string): string | undefined {
  return COMMUNITY_MEDIA_TYPE_MAP[type.toUpperCase()];
}

const GENERIC_MAX_BYTES = env.CHAT_UPLOAD_MAX_BYTES; // ~50 MB generic cap
const VIDEO_MAX_BYTES = env.CHAT_VIDEO_MAX_BYTES; // ~100 MB video cap

/**
 * Per-message-type media limits. `maxCount` caps the number of files in the
 * attachment array; `maxBytes` caps each file's size; `maxDurationMs` caps each
 * file's playback duration (videos / voice notes).
 */
export const MEDIA_LIMITS = {
  IMAGE: { maxCount: 10, maxBytes: GENERIC_MAX_BYTES },
  VIDEO: { maxBytes: VIDEO_MAX_BYTES, maxDurationMs: 180_000 },
  VOICE: { maxBytes: GENERIC_MAX_BYTES, maxDurationMs: 300_000 },
  GIF: { maxBytes: GENERIC_MAX_BYTES },
  DOCUMENT: { maxBytes: GENERIC_MAX_BYTES },
  STICKER: { maxBytes: GENERIC_MAX_BYTES },
} as const;

/** Shape of a file entry inside a message's content/media blob. */
interface AttachmentFile {
  size?: number;
  durationMs?: number;
  [key: string]: unknown;
}

/**
 * Defensive guard mirroring the validator superRefine. Throws BadRequestError
 * with a stable code when count / size / duration caps are exceeded for the
 * given message type. STICKER carries no file array (the sticker object is
 * validated separately), so it is treated as a no-op here.
 *
 * Message types are normalized to upper-case so both the private/group enum
 * ("IMAGE") and the community enum ("image") map to the same limits.
 */
export function assertAttachmentsValid(
  messageType: string,
  files: AttachmentFile[] | undefined
): void {
  const type = (messageType || "").toUpperCase();
  const list = Array.isArray(files) ? files : [];

  switch (type) {
    case "IMAGE": {
      if (list.length > MEDIA_LIMITS.IMAGE.maxCount) {
        throw new BadRequestError("CHAT_IMAGE_COUNT_EXCEEDED");
      }
      for (const f of list) {
        if ((f.size ?? 0) > MEDIA_LIMITS.IMAGE.maxBytes) {
          throw new BadRequestError("CHAT_FILE_TOO_LARGE");
        }
      }
      break;
    }
    case "VIDEO": {
      for (const f of list) {
        if ((f.size ?? 0) > MEDIA_LIMITS.VIDEO.maxBytes) {
          throw new BadRequestError("CHAT_VIDEO_TOO_LARGE");
        }
        if ((f.durationMs ?? 0) > MEDIA_LIMITS.VIDEO.maxDurationMs) {
          throw new BadRequestError("CHAT_VIDEO_TOO_LONG");
        }
      }
      break;
    }
    case "VOICE": {
      for (const f of list) {
        if ((f.size ?? 0) > MEDIA_LIMITS.VOICE.maxBytes) {
          throw new BadRequestError("CHAT_FILE_TOO_LARGE");
        }
        if ((f.durationMs ?? 0) > MEDIA_LIMITS.VOICE.maxDurationMs) {
          throw new BadRequestError("CHAT_VOICE_TOO_LONG");
        }
      }
      break;
    }
    case "GIF":
    case "DOCUMENT":
    case "CUSTOM": {
      for (const f of list) {
        if ((f.size ?? 0) > GENERIC_MAX_BYTES) {
          throw new BadRequestError("CHAT_FILE_TOO_LARGE");
        }
      }
      break;
    }
    case "STICKER":
    default:
      // STICKER has no file array; other types (TEXT/LOCATION/CONTACT/SYSTEM)
      // carry no size-capped media.
      break;
  }
}

/**
 * Zod superRefine helper shared by all three send validators. Maps the same
 * count/size/duration caps as `assertAttachmentsValid` into Zod issues so bad
 * payloads are rejected at the validation layer with a field path.
 *
 * `messageType` is normalized to upper-case so the community enum ("image")
 * resolves to the same limits as the private/group enum ("IMAGE").
 */
export function enforceMediaLimits(
  messageType: string,
  files: AttachmentFile[] | undefined,
  ctx: RefinementCtx
): void {
  const type = (messageType || "").toUpperCase();
  const list = Array.isArray(files) ? files : [];

  const fail = (message: string): void => {
    ctx.addIssue({ code: "custom", message, path: ["files"] });
  };

  switch (type) {
    case "IMAGE": {
      if (list.length > MEDIA_LIMITS.IMAGE.maxCount) {
        fail(`At most ${MEDIA_LIMITS.IMAGE.maxCount} images are allowed`);
      }
      for (const f of list) {
        if ((f.size ?? 0) > MEDIA_LIMITS.IMAGE.maxBytes) {
          fail("Image exceeds the maximum allowed size");
        }
      }
      break;
    }
    case "VIDEO": {
      for (const f of list) {
        if ((f.size ?? 0) > MEDIA_LIMITS.VIDEO.maxBytes) {
          fail("Video exceeds the maximum allowed size");
        }
        if ((f.durationMs ?? 0) > MEDIA_LIMITS.VIDEO.maxDurationMs) {
          fail("Video exceeds the maximum allowed duration");
        }
      }
      break;
    }
    case "VOICE": {
      for (const f of list) {
        if ((f.size ?? 0) > MEDIA_LIMITS.VOICE.maxBytes) {
          fail("Voice note exceeds the maximum allowed size");
        }
        if ((f.durationMs ?? 0) > MEDIA_LIMITS.VOICE.maxDurationMs) {
          fail("Voice note exceeds the maximum allowed duration");
        }
      }
      break;
    }
    case "GIF":
    case "DOCUMENT":
    case "CUSTOM": {
      for (const f of list) {
        if ((f.size ?? 0) > GENERIC_MAX_BYTES) {
          fail("File exceeds the maximum allowed size");
        }
      }
      break;
    }
    default:
      break;
  }
}
