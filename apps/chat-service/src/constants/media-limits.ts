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
 * Message types shown in the shared "Media" tab (private/group enum, upper-case).
 * Intentionally IMAGE + VIDEO only — stickers, GIFs, voice notes, audio, and
 * documents each have their own tab (or none) and must not appear in Media.
 * Used by the per-room media-list filters so the whitelist lives in one place.
 */
export const MEDIA_MESSAGE_TYPES = ["IMAGE", "VIDEO"] as const;

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

/** Community storage values shown in the shared "Media" tab. IMAGE + VIDEO
 *  only — stickers/GIFs/voice/audio/documents belong in other tabs. */
export const COMMUNITY_MEDIA_MESSAGE_TYPES = ["image", "video"] as const;

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

type FileLimit = { maxBytes: number; tooLargeCode: string };

const DOCUMENT_LIMIT: FileLimit = {
  maxBytes: MEDIA_LIMITS.DOCUMENT.maxBytes,
  tooLargeCode: "CHAT_DOCUMENT_TOO_LARGE",
};

/**
 * Resolve the byte cap + error code for a file by its OWN detected MIME,
 * falling back to `fallback` when the mime is missing/empty or doesn't
 * resolve to a known media type. `mime` on the wire defaults to `""` (see the
 * send validators' `z.string().default("")`), never `undefined`, so this must
 * treat falsy the same as unresolvable — it is NOT evidence the file is a
 * DOCUMENT.
 */
function resolveFileLimit(
  mime: string | undefined,
  fallback: FileLimit
): FileLimit {
  const detected = mime ? contentTypeFromMime(mime) : undefined;
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
    default:
      return fallback;
  }
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
 * through to the document cap — the correct fallback for THIS bucket, since
 * an unresolvable file picked via the generic "attach a file" flow really is
 * most likely a document.
 */
function resolveGenericFileLimit(mime: string | undefined): FileLimit {
  return resolveFileLimit(mime, DOCUMENT_LIMIT);
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
    // IMAGE and VIDEO are also the two "gallery" picker types (a single
    // Photos attach can mix images and videos into one album send — see
    // splitDirectMediaAlbum). The top-level messageType is derived from the
    // batch as a whole (IMAGE whenever it contains any image), so checking
    // every file against ONE fixed bucket would validate a video against the
    // image cap (or vice versa) and reject an otherwise-valid mixed album.
    // Resolve each file by its OWN mime — same approach as the GIF/DOCUMENT/
    // CUSTOM bucket below — so a video in an "IMAGE" batch is still checked
    // against the video cap, and an image in a "VIDEO" batch against the
    // image cap.
    case "IMAGE": {
      if (list.length > MEDIA_LIMITS.IMAGE.maxCount) {
        violations.push({
          code: "CHAT_IMAGE_COUNT_EXCEEDED",
          message: `At most ${MEDIA_LIMITS.IMAGE.maxCount} images are allowed`,
        });
      }
      for (const f of list) {
        // Falls back to the IMAGE cap (not DOCUMENT) when mime is empty/
        // unresolvable — matches the pre-fix behavior for a plain image send.
        const { maxBytes, tooLargeCode } = resolveFileLimit(f.mime, {
          maxBytes: MEDIA_LIMITS.IMAGE.maxBytes,
          tooLargeCode: "CHAT_IMAGE_TOO_LARGE",
        });
        if ((f.size ?? 0) > maxBytes) {
          violations.push({
            code: tooLargeCode,
            message: TOO_LARGE_MESSAGE[tooLargeCode]!,
          });
        }
        if (
          contentTypeFromMime(f.mime ?? "") === "VIDEO" &&
          (f.durationMs ?? 0) > MEDIA_LIMITS.VIDEO.maxDurationMs
        ) {
          violations.push({
            code: "CHAT_VIDEO_TOO_LONG",
            message: "Video exceeds the maximum allowed duration",
          });
        }
      }
      break;
    }
    case "VIDEO": {
      for (const f of list) {
        // Falls back to the VIDEO cap (not DOCUMENT) when mime is empty/
        // unresolvable — matches the pre-fix behavior for a plain video send.
        const { maxBytes, tooLargeCode } = resolveFileLimit(f.mime, {
          maxBytes: MEDIA_LIMITS.VIDEO.maxBytes,
          tooLargeCode: "CHAT_VIDEO_TOO_LARGE",
        });
        if ((f.size ?? 0) > maxBytes) {
          violations.push({
            code: tooLargeCode,
            message: TOO_LARGE_MESSAGE[tooLargeCode]!,
          });
        }
        if (
          contentTypeFromMime(f.mime ?? "") === "VIDEO" &&
          (f.durationMs ?? 0) > MEDIA_LIMITS.VIDEO.maxDurationMs
        ) {
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
