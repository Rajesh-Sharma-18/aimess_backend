import { BadRequestError } from "@aimess/errors";
import { contentTypeFromMime } from "@aimess/constants";
import type { RefinementCtx } from "zod";

import { env } from "../config/env.js";

/**
 * Centralized media/text caps for chat attachments. Byte tunables are read from
 * env so ops can adjust them without a code change; the table below is the
 * single source of truth consumed by the send validators (Zod superRefine) and
 * the defensive service-layer guard `assertAttachmentsValid`.
 *
 * The byte VALUES themselves (25 MB image/audio/document, 100 MB video) are
 * shared with media-service's presigned-upload-time guard via matching env
 * var names/defaults (`CHAT_IMAGE_MAX_BYTES`, `CHAT_AUDIO_MAX_BYTES`,
 * `CHAT_DOCUMENT_MAX_BYTES`, `CHAT_VIDEO_MAX_BYTES` — see
 * apps/media-service/src/config/uploads.ts) so the two independent
 * enforcement points (upload-url issuance vs. message-send) can never
 * silently drift apart, as they previously had (chat-service capped
 * documents at 50 MB while media-service allowed up to 100 MB for some
 * office formats; audio had no dedicated cap at all and reused the 100 MB
 * video ceiling).
 */

/** Max text length for any chat message body (send + edit). */
export const CHAT_TEXT_MAX_CHARS = env.CHAT_TEXT_MAX_CHARS;

/**
 * Max length of a single reaction `emoji` token (REST add/remove + socket).
 * Matches the socket reaction contract; shared by the private/group reaction
 * body + param validators so the cap lives in one place.
 */
export const CHAT_EMOJI_MAX_CHARS = 32;

/** Window during which a sender may still edit their own message. */
export const CHAT_EDIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Canonical media-bearing message types (private/group enum, upper-case). Used
 * by the per-room media-list filters so the whitelist lives in one place.
 */
export const MEDIA_MESSAGE_TYPES = [
  "IMAGE",
  "VIDEO",
  "AUDIO",
  "GIF",
  "VOICE",
  "DOCUMENT",
  "STICKER",
] as const;

/**
 * Map an incoming (upper-cased) media-list `type` filter to the community
 * storage value. Returns undefined for unknown/non-media types so callers can
 * decide on an empty result rather than broadening the query.
 */
const COMMUNITY_MEDIA_TYPE_MAP: Record<string, string> = {
  IMAGE: "image",
  VOICE: "voice",
  AUDIO: "audio",
  STICKER: "sticker",
  VIDEO: "video",
  GIF: "gif",
  DOCUMENT: "document",
};

/** Distinct community storage values that hold media. */
export const COMMUNITY_MEDIA_MESSAGE_TYPES = [
  "image",
  "voice",
  "audio",
  "sticker",
  "video",
  "gif",
  "document",
  "custom", // kept for backward-compat with messages stored before the type expansion
] as const;

/** Resolve a community media storage value for an incoming `type` filter. */
export function mapCommunityMediaType(type: string): string | undefined {
  return COMMUNITY_MEDIA_TYPE_MAP[type.toUpperCase()];
}

const GENERIC_MAX_BYTES = env.CHAT_UPLOAD_MAX_BYTES; // ~50 MB generic cap (GIF/legacy CUSTOM only)
const VIDEO_MAX_BYTES = env.CHAT_VIDEO_MAX_BYTES; // 100 MB video cap
const IMAGE_MAX_BYTES = env.CHAT_IMAGE_MAX_BYTES; // 25 MB image cap
const AUDIO_MAX_BYTES = env.CHAT_AUDIO_MAX_BYTES; // 25 MB audio cap
const DOCUMENT_MAX_BYTES = env.CHAT_DOCUMENT_MAX_BYTES; // 25 MB document cap

/** Telegram-like cap on images per message (gallery/album send). */
const MAX_IMAGES_PER_MESSAGE = 10;

/**
 * Per-message-type media limits. `maxCount` caps the number of files in the
 * attachment array; `maxBytes` caps each file's size; `maxDurationMs` caps each
 * file's playback duration (videos / voice notes).
 */
export const MEDIA_LIMITS = {
  IMAGE: { maxCount: MAX_IMAGES_PER_MESSAGE, maxBytes: IMAGE_MAX_BYTES },
  VIDEO: { maxBytes: VIDEO_MAX_BYTES, maxDurationMs: 180_000 },
  VOICE: { maxBytes: GENERIC_MAX_BYTES, maxDurationMs: 300_000 },
  AUDIO: { maxBytes: AUDIO_MAX_BYTES },
  GIF: { maxBytes: GENERIC_MAX_BYTES },
  DOCUMENT: { maxBytes: DOCUMENT_MAX_BYTES },
  STICKER: { maxBytes: GENERIC_MAX_BYTES },
} as const;

/** Shape of a file entry inside a message's content/media blob. */
interface AttachmentFile {
  size?: number;
  durationMs?: number;
  /** The file's own MIME, when known — see {@link resolveGenericFileLimit}. */
  mime?: string;
  [key: string]: unknown;
}

/** One violated cap: a stable error code (throw-friendly) + a display message (Zod-issue-friendly). */
interface MediaLimitViolation {
  code: string;
  message: string;
}

/**
 * Resolve the byte cap + error code for a file inside the GENERIC bucket
 * (DOCUMENT / CUSTOM message types). A generic "attach a file" picker lets a
 * user pick an image/video/audio file just as easily as an actual document —
 * validating every file in that bucket against the flat document cap would
 * wrongly reject e.g. a 40 MB video (under the 100 MB video cap) at the 25 MB
 * document cap. So each file here is reclassified by its OWN detected MIME
 * (never by "came from the file picker") and checked against ITS type's real
 * limit; only a file whose MIME doesn't resolve to image/video/audio falls
 * through to the document cap.
 */
function resolveGenericFileLimit(mime: string | undefined): {
  maxBytes: number;
  tooLargeCode: string;
} {
  const detected = mime ? contentTypeFromMime(mime) : "DOCUMENT";
  switch (detected) {
    case "IMAGE":
      return {
        maxBytes: MEDIA_LIMITS.IMAGE.maxBytes,
        tooLargeCode: "CHAT_IMAGE_TOO_LARGE",
      };
    case "VIDEO":
      return {
        maxBytes: MEDIA_LIMITS.VIDEO.maxBytes,
        tooLargeCode: "CHAT_VIDEO_TOO_LARGE",
      };
    case "AUDIO":
      return {
        maxBytes: MEDIA_LIMITS.AUDIO.maxBytes,
        tooLargeCode: "CHAT_AUDIO_TOO_LARGE",
      };
    case "GIF":
      return {
        maxBytes: MEDIA_LIMITS.GIF.maxBytes,
        tooLargeCode: "CHAT_FILE_TOO_LARGE",
      };
    case "DOCUMENT":
    default:
      return {
        maxBytes: MEDIA_LIMITS.DOCUMENT.maxBytes,
        tooLargeCode: "CHAT_DOCUMENT_TOO_LARGE",
      };
  }
}

const TOO_LARGE_MESSAGE: Record<string, string> = {
  CHAT_IMAGE_TOO_LARGE: "Image exceeds the maximum allowed size",
  CHAT_VIDEO_TOO_LARGE: "Video exceeds the maximum allowed size",
  CHAT_AUDIO_TOO_LARGE: "Audio exceeds the maximum allowed size",
  CHAT_DOCUMENT_TOO_LARGE: "Document exceeds the maximum allowed size",
  CHAT_FILE_TOO_LARGE: "File exceeds the maximum allowed size",
};

/**
 * Single source of truth for count/size/duration/type violations — computes
 * the full list so `enforceMediaLimits` can surface every issue as a Zod
 * issue, while `assertAttachmentsValid` just throws on the first one.
 */
function findMediaLimitViolations(
  messageType: string,
  files: AttachmentFile[] | undefined
): MediaLimitViolation[] {
  const type = (messageType || "").toUpperCase();
  const list = Array.isArray(files) ? files : [];
  const violations: MediaLimitViolation[] = [];

  switch (type) {
    case "IMAGE": {
      if (list.length > MEDIA_LIMITS.IMAGE.maxCount) {
        violations.push({
          code: "CHAT_IMAGE_COUNT_EXCEEDED",
          message: `At most ${MEDIA_LIMITS.IMAGE.maxCount} images are allowed`,
        });
      }
      for (const f of list) {
        if ((f.size ?? 0) > MEDIA_LIMITS.IMAGE.maxBytes) {
          violations.push({
            code: "CHAT_IMAGE_TOO_LARGE",
            message: TOO_LARGE_MESSAGE.CHAT_IMAGE_TOO_LARGE!,
          });
        }
      }
      break;
    }
    case "VIDEO": {
      for (const f of list) {
        if ((f.size ?? 0) > MEDIA_LIMITS.VIDEO.maxBytes) {
          violations.push({
            code: "CHAT_VIDEO_TOO_LARGE",
            message: TOO_LARGE_MESSAGE.CHAT_VIDEO_TOO_LARGE!,
          });
        }
        if ((f.durationMs ?? 0) > MEDIA_LIMITS.VIDEO.maxDurationMs) {
          violations.push({
            code: "CHAT_VIDEO_TOO_LONG",
            message: "Video exceeds the maximum allowed duration",
          });
        }
      }
      break;
    }
    case "VOICE": {
      // Voice-note MIME (audio/*) is indistinguishable from a plain AUDIO
      // file, so — unlike the generic bucket below — this always trusts the
      // message-level type: only a dedicated voice-recorder UI sends VOICE.
      for (const f of list) {
        if ((f.size ?? 0) > MEDIA_LIMITS.VOICE.maxBytes) {
          violations.push({
            code: "CHAT_FILE_TOO_LARGE",
            message: "Voice note exceeds the maximum allowed size",
          });
        }
        if ((f.durationMs ?? 0) > MEDIA_LIMITS.VOICE.maxDurationMs) {
          violations.push({
            code: "CHAT_VOICE_TOO_LONG",
            message: "Voice note exceeds the maximum allowed duration",
          });
        }
      }
      break;
    }
    case "AUDIO": {
      for (const f of list) {
        if ((f.size ?? 0) > MEDIA_LIMITS.AUDIO.maxBytes) {
          violations.push({
            code: "CHAT_AUDIO_TOO_LARGE",
            message: TOO_LARGE_MESSAGE.CHAT_AUDIO_TOO_LARGE!,
          });
        }
      }
      break;
    }
    case "GIF":
    case "DOCUMENT":
    case "CUSTOM": {
      for (const f of list) {
        const { maxBytes, tooLargeCode } = resolveGenericFileLimit(f.mime);
        if ((f.size ?? 0) > maxBytes) {
          violations.push({
            code: tooLargeCode,
            message: TOO_LARGE_MESSAGE[tooLargeCode]!,
          });
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

  return violations;
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
  const [violation] = findMediaLimitViolations(messageType, files);
  if (violation) {
    throw new BadRequestError(violation.code);
  }
}

/**
 * Zod superRefine helper shared by all three send validators. Maps the same
 * count/size/duration caps as `assertAttachmentsValid` into Zod issues so bad
 * payloads are rejected at the validation layer with a field path. The
 * content-type whitelist itself is a separate `.refine(isCommunityContentType)`
 * on the same schema, so it isn't repeated here.
 *
 * `messageType` is normalized to upper-case so the community enum ("image")
 * resolves to the same limits as the private/group enum ("IMAGE").
 */
export function enforceMediaLimits(
  messageType: string,
  files: AttachmentFile[] | undefined,
  ctx: RefinementCtx
): void {
  for (const violation of findMediaLimitViolations(messageType, files)) {
    ctx.addIssue({
      code: "custom",
      message: violation.message,
      path: ["files"],
    });
  }
}
