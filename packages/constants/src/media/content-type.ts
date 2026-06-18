/**
 * Canonical message-kind ("contentType") catalog — the SINGLE source of truth
 * for every send validator, socket schema, and OpenAPI doc across all chat
 * surfaces (private, group, community). Before this module the list was
 * duplicated in three Zod validators that had drifted apart (private/group were
 * missing AUDIO and GIF that community accepted); importing from here keeps them
 * in lock-step.
 *
 * Casing: private / group / socket use these UPPER-CASE values verbatim. The
 * community REST path historically accepts the lower-case spelling (plus the
 * "custom" catch-all kept for pre-expansion stored docs), so it derives its
 * accepted set from {@link isCommunityContentType} / {@link COMMUNITY_CONTENT_TYPES}
 * below — one canonical list, two spellings, never two hand-maintained lists.
 *
 * This is intentionally dependency-free (no Zod) so the constants package stays
 * importable everywhere; validators wrap the tuple with `z.enum(CONTENT_TYPES)`.
 */

/** Every message kind the platform recognizes, UPPER-CASE, on every client wire. */
export const CONTENT_TYPES = [
  "TEXT",
  "IMAGE",
  "VIDEO",
  "AUDIO",
  "VOICE",
  "DOCUMENT",
  "GIF",
  "STICKER",
  "LOCATION",
  "CONTACT",
  "SYSTEM",
] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];

/**
 * The media-bearing subset of {@link CONTENT_TYPES} — i.e. the "MediaType" view
 * requested by product, DERIVED from the canonical list rather than introduced
 * as a competing enum. Excludes TEXT/LOCATION/CONTACT/SYSTEM (no stored object).
 */
export const MEDIA_CONTENT_TYPES = [
  "IMAGE",
  "VIDEO",
  "AUDIO",
  "VOICE",
  "DOCUMENT",
  "GIF",
  "STICKER",
] as const;

export type MediaContentType = (typeof MEDIA_CONTENT_TYPES)[number];

/**
 * Community-only extension kinds that are NOT canonical message kinds. `custom`
 * is a render catch-all retained for messages stored before the type expansion.
 */
export const COMMUNITY_EXTRA_CONTENT_TYPES = ["custom"] as const;

/**
 * The full set the community REST send path accepts, lower-case — derived from
 * the canonical list plus the community extras. SYSTEM is excluded because it is
 * a server-emitted lifecycle kind that the community send validator never
 * accepted from clients; excluding it here keeps that surface byte-identical to
 * its pre-centralization behavior. `readonly string[]` (not a literal tuple)
 * because it is consumed via membership checks, not `z.enum`.
 */
export const COMMUNITY_CONTENT_TYPES: readonly string[] = [
  ...CONTENT_TYPES.filter((t) => t !== "SYSTEM").map((t) => t.toLowerCase()),
  ...COMMUNITY_EXTRA_CONTENT_TYPES,
];

/** True if `value` is a canonical message kind (case-insensitive). */
export function isContentType(value: string): boolean {
  const v = value.toUpperCase();
  return (CONTENT_TYPES as readonly string[]).includes(v);
}

/**
 * True if `value` is acceptable on the community path (canonical kind OR a
 * community extra), case-insensitive. Used by the community send validator so
 * its accepted set is derived from the canonical list, never re-typed.
 */
export function isCommunityContentType(value: string): boolean {
  return COMMUNITY_CONTENT_TYPES.includes(value.toLowerCase());
}

/**
 * Derive the media kind from a MIME type for server-side `mediaType` resolution.
 * Cannot distinguish VOICE from AUDIO (both `audio/*`) — callers that know the
 * message is a voice note should override to "VOICE". Unknown/empty → DOCUMENT.
 */
export function contentTypeFromMime(mime: string): MediaContentType {
  const m = (mime || "").toLowerCase();
  if (m === "image/gif") return "GIF";
  if (m.startsWith("image/")) return "IMAGE";
  if (m.startsWith("video/")) return "VIDEO";
  if (m.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
}
