/**
 * Canonical message-kind ("contentType") catalog — the SINGLE source of truth
 * for every send validator, socket schema, and OpenAPI doc across all chat
 * surfaces (private, group, community). Read-only kinds that a client may never
 * send live in {@link CALL_CONTENT_TYPES}; {@link ALL_CONTENT_TYPES} is the union
 * a reader can observe. Before this module the list was
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
 * Call-lifecycle message kinds. A call's timeline row is NOT a generic SYSTEM
 * line: the client renders a call card whose icon/affordance depends on whether
 * the call was voice or video, and that fact must come from the message kind
 * rather than from parsing `content.text`.
 *
 * Deliberately NOT part of {@link CONTENT_TYPES}: that tuple backs the private /
 * group send validators (`z.enum(CONTENT_TYPES)`), and these two are
 * server-emitted only — a client must never be able to forge a call row by
 * sending `messageType: "VOICE_CALL"`. Use {@link ALL_CONTENT_TYPES} wherever the
 * full READ-side catalog is needed (docs, wire types).
 */
export const CALL_CONTENT_TYPES = ["VOICE_CALL", "VIDEO_CALL"] as const;

export type CallContentType = (typeof CALL_CONTENT_TYPES)[number];

/**
 * Invitation-card message kinds — the exact same argument as
 * {@link CALL_CONTENT_TYPES}, one rung up. A shared community/group invite is
 * NOT a generic SYSTEM line either: the client renders a join card whose name,
 * avatar, member count and CTA come from structured data, and whether to render
 * that card at all must come from the message KIND, not from combining
 * `contentType === "SYSTEM"` with a `systemEvent` string.
 *
 * The values match the `systemEvent` they have always carried
 * (COMMUNITY_INVITE / GROUP_INVITE), so nothing about an existing row's
 * identity changes — the kind is simply promoted out of `systemEvent` and onto
 * `contentType` where every reader already looks.
 *
 * Deliberately NOT part of {@link CONTENT_TYPES}: server-emitted only, so a
 * client can never forge a join card by sending
 * `messageType: "COMMUNITY_INVITE"`.
 */
export const INVITE_CONTENT_TYPES = [
  "COMMUNITY_INVITE",
  "GROUP_INVITE",
] as const;

export type InviteContentType = (typeof INVITE_CONTENT_TYPES)[number];

/** Every kind that can appear as `contentType` on a READ/broadcast wire. */
export const ALL_CONTENT_TYPES = [
  ...CONTENT_TYPES,
  ...CALL_CONTENT_TYPES,
  ...INVITE_CONTENT_TYPES,
] as const;

export type AnyContentType = (typeof ALL_CONTENT_TYPES)[number];

/**
 * Map a Call's `type` (`CallType`: "AUDIO" | "VIDEO") to the message kind its
 * chat timeline row is stored as. The SINGLE place this mapping exists — every
 * call-message writer (private DM audit rows, group call audit rows) goes
 * through it, so the kind is derived from call METADATA, never from the
 * rendered text. Unknown/absent type falls back to VOICE_CALL, matching the
 * `CallType.AUDIO` default used when a client omits the call type.
 */
export function callContentType(
  callType: string | null | undefined
): CallContentType {
  return String(callType ?? "").toUpperCase() === "VIDEO"
    ? "VIDEO_CALL"
    : "VOICE_CALL";
}

/** True if `value` is a call-lifecycle message kind (case-insensitive). */
export function isCallContentType(value: string): boolean {
  return (CALL_CONTENT_TYPES as readonly string[]).includes(
    String(value ?? "").toUpperCase()
  );
}

/**
 * Map the invited-to room kind to the message kind its invitation card is
 * stored as — the {@link callContentType} of invitations. The SINGLE place this
 * mapping exists, so both invite writers (community room-sync consumer, group
 * invite-link service) derive the kind the same way.
 */
export function inviteContentType(
  target: "COMMUNITY" | "GROUP"
): InviteContentType {
  return target === "GROUP" ? "GROUP_INVITE" : "COMMUNITY_INVITE";
}

/** True if `value` is an invitation-card message kind (case-insensitive). */
export function isInviteContentType(value: string): boolean {
  return (INVITE_CONTENT_TYPES as readonly string[]).includes(
    String(value ?? "").toUpperCase()
  );
}

/**
 * True for any kind whose `content.text` is a server-rendered lifecycle line
 * that must be re-rendered per viewer/locale before it goes out — i.e. generic
 * SYSTEM rows plus the invitation cards, which carry the same
 * `systemEvent`-driven sentence under a more specific kind.
 *
 * Call rows are deliberately EXCLUDED: their text is rebuilt from
 * `systemData.callType/status/durationSec` on the paths that need it, and
 * routing them through the personalizer here would change long-settled
 * VOICE_CALL/VIDEO_CALL output.
 */
export function isPersonalizableSystemContentType(value: string): boolean {
  const v = String(value ?? "").toUpperCase();
  return v === "SYSTEM" || isInviteContentType(v);
}

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
