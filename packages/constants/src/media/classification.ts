/**
 * Media classification — the SINGLE source of truth for owner type, resource
 * type, scan status, and download-access policy across the platform: the
 * `media-service` MediaFile registry, every upload/confirm path, and every
 * download-authorization decision.
 *
 * House idiom (see content-type.ts): closed sets are dependency-free `as const`
 * string tuples with a derived union type — NOT the TS `enum` keyword — so the
 * constants package stays importable everywhere and validators wrap a tuple
 * with `z.enum(...)`. These ARE the "enums" the media spec asks for, expressed
 * in the codebase's convention.
 *
 * Two-level model:
 *   • {@link MediaOwnerType}    — the KIND of entity an object belongs to.
 *   • {@link MediaResourceType} — the precise ROLE of the file (drives storage
 *     prefix, authorization, and lifecycle).
 * Every resource type maps to exactly one owner type ({@link RESOURCE_OWNER_TYPE})
 * and exactly one download-access policy ({@link RESOURCE_ACCESS_POLICY}).
 */

// ─── Owner type (Phase 3) ──────────────────────────────────────────────────

/** Which kind of entity owns / scopes an uploaded object. */
export const MEDIA_OWNER_TYPES = [
  "USER",
  "COMMUNITY",
  "GROUP",
  "PRIVATE_CHAT",
  "COMMUNITY_CHAT",
  "GROUP_CHAT",
  "LIVESTREAM",
  "SYSTEM",
  "ADMIN",
] as const;
export type MediaOwnerType = (typeof MEDIA_OWNER_TYPES)[number];

// ─── Resource type (Phase 4) ───────────────────────────────────────────────

/**
 * The precise role of a stored file. Chat attachments are split by media kind
 * (IMAGE/VIDEO/AUDIO/DOCUMENT) so storage analytics and per-kind retention can
 * be reasoned about without re-deriving from MIME. Derived at confirm time from
 * the upload category + the file's MIME (see media-service `resolveResourceType`).
 */
export const MEDIA_RESOURCE_TYPES = [
  // Profile
  "USER_AVATAR",
  "USER_COVER",
  // Community branding
  "COMMUNITY_AVATAR",
  "COMMUNITY_BANNER",
  // Group branding
  "GROUP_AVATAR",
  // Private (1:1) chat attachments
  "PRIVATE_CHAT_IMAGE",
  "PRIVATE_CHAT_VIDEO",
  "PRIVATE_CHAT_AUDIO",
  "PRIVATE_CHAT_DOCUMENT",
  // Group chat attachments
  "GROUP_CHAT_IMAGE",
  "GROUP_CHAT_VIDEO",
  "GROUP_CHAT_AUDIO",
  "GROUP_CHAT_DOCUMENT",
  // Community chat attachments
  "COMMUNITY_CHAT_IMAGE",
  "COMMUNITY_CHAT_VIDEO",
  "COMMUNITY_CHAT_AUDIO",
  "COMMUNITY_CHAT_DOCUMENT",
  // Livestream (future stream-service)
  "LIVESTREAM_THUMBNAIL",
  "LIVESTREAM_BANNER",
  "LIVESTREAM_RECORDING",
  // Backoffice / moderation
  "ADMIN_ATTACHMENT",
  // Fallback for un-classifiable / legacy objects
  "OTHER",
] as const;
export type MediaResourceType = (typeof MEDIA_RESOURCE_TYPES)[number];

// ─── Scan status (Phase 7) ─────────────────────────────────────────────────

/**
 * Lifecycle status of an uploaded object's safety check. Reconciles the
 * media-service working union with the spec: adds REJECTED as a FIRST-CLASS
 * structural-rejection verdict (magic-byte / ZIP / OOXML mismatch) — previously
 * the service overloaded INFECTED for that, conflating "failed validation" with
 * "virus found". SCANNING is reserved for finer-grained progress reporting.
 *
 *   PENDING     — /confirm called; structural checks done, AV scan queued.
 *   SCANNING    — AV worker actively scanning (reserved; optional finer state).
 *   CLEAN       — all checks passed → downloadable.
 *   REJECTED    — structural validation failed (not a virus); object removed.
 *   INFECTED    — AV engine flagged malware; object removed.
 *   QUARANTINED — isolated after a terminal reject/infect; object removed.
 *   SKIPPED     — AV disabled (dev / no-op scanner); structurally valid only.
 *   ERROR       — terminal scan failure after retries; NOT downloadable.
 *
 * Downloadable set (allow-list): CLEAN, SKIPPED. See {@link DOWNLOADABLE_SCAN_STATUSES}.
 */
export const MEDIA_SCAN_STATUSES = [
  "PENDING",
  "SCANNING",
  "CLEAN",
  "REJECTED",
  "INFECTED",
  "QUARANTINED",
  "SKIPPED",
  "ERROR",
] as const;
export type MediaScanStatus = (typeof MEDIA_SCAN_STATUSES)[number];

/**
 * The ONLY statuses for which a download URL may be issued. Defense-in-depth
 * allow-list — any new/unknown status defaults to blocked.
 */
export const DOWNLOADABLE_SCAN_STATUSES: readonly MediaScanStatus[] = [
  "CLEAN",
  "SKIPPED",
];

/** True if an object in this scan status may be served. */
export function isDownloadableScanStatus(status: string): boolean {
  return (DOWNLOADABLE_SCAN_STATUSES as readonly string[]).includes(status);
}

// ─── Download-access policy (Phase 9) ──────────────────────────────────────

/**
 * Who may obtain a download URL for a resource, evaluated by media-service on
 * the standalone `/download-url` and `/scan-status` endpoints.
 *
 *   PUBLIC                   — any authenticated user (avatars, community branding).
 *   OWNER                    — only the uploader.
 *   PRIVATE_CHAT_PARTICIPANT — either participant of the 1:1 room.
 *   GROUP_MEMBER             — a member of the group.
 *   COMMUNITY_MEMBER         — a member of the community.
 *   ADMIN                    — backoffice/moderation roles only.
 *
 * NOTE: this governs the EXPLICIT download endpoint. The inline resolve-on-read
 * path (chat-service presigns attachment URLs as part of message delivery)
 * authorizes at the message-delivery layer — if you received the message you may
 * see its attachments — and intentionally does not re-run these checks per file.
 */
export const MEDIA_ACCESS_POLICIES = [
  "PUBLIC",
  "OWNER",
  "PRIVATE_CHAT_PARTICIPANT",
  "GROUP_MEMBER",
  "COMMUNITY_MEMBER",
  "ADMIN",
] as const;
export type MediaAccessPolicy = (typeof MEDIA_ACCESS_POLICIES)[number];

// ─── Resource → owner type ─────────────────────────────────────────────────

/** Every resource type's owning entity kind. */
export const RESOURCE_OWNER_TYPE: Record<MediaResourceType, MediaOwnerType> = {
  USER_AVATAR: "USER",
  USER_COVER: "USER",
  COMMUNITY_AVATAR: "COMMUNITY",
  COMMUNITY_BANNER: "COMMUNITY",
  GROUP_AVATAR: "GROUP",
  PRIVATE_CHAT_IMAGE: "PRIVATE_CHAT",
  PRIVATE_CHAT_VIDEO: "PRIVATE_CHAT",
  PRIVATE_CHAT_AUDIO: "PRIVATE_CHAT",
  PRIVATE_CHAT_DOCUMENT: "PRIVATE_CHAT",
  GROUP_CHAT_IMAGE: "GROUP_CHAT",
  GROUP_CHAT_VIDEO: "GROUP_CHAT",
  GROUP_CHAT_AUDIO: "GROUP_CHAT",
  GROUP_CHAT_DOCUMENT: "GROUP_CHAT",
  COMMUNITY_CHAT_IMAGE: "COMMUNITY_CHAT",
  COMMUNITY_CHAT_VIDEO: "COMMUNITY_CHAT",
  COMMUNITY_CHAT_AUDIO: "COMMUNITY_CHAT",
  COMMUNITY_CHAT_DOCUMENT: "COMMUNITY_CHAT",
  LIVESTREAM_THUMBNAIL: "LIVESTREAM",
  LIVESTREAM_BANNER: "LIVESTREAM",
  LIVESTREAM_RECORDING: "LIVESTREAM",
  ADMIN_ATTACHMENT: "ADMIN",
  OTHER: "SYSTEM",
};

// ─── Resource → download-access policy ─────────────────────────────────────

/**
 * The authorization rule for each resource type on the explicit download path.
 * Avatars/covers/banners are PUBLIC; chat attachments require participation /
 * membership of the owning conversation; group avatars are member-gated because
 * groups are private; livestream media is community-gated; admin attachments are
 * admin-only; OTHER falls back to OWNER (most restrictive sensible default).
 */
export const RESOURCE_ACCESS_POLICY: Record<
  MediaResourceType,
  MediaAccessPolicy
> = {
  USER_AVATAR: "PUBLIC",
  USER_COVER: "PUBLIC",
  COMMUNITY_AVATAR: "PUBLIC",
  COMMUNITY_BANNER: "PUBLIC",
  GROUP_AVATAR: "GROUP_MEMBER",
  PRIVATE_CHAT_IMAGE: "PRIVATE_CHAT_PARTICIPANT",
  PRIVATE_CHAT_VIDEO: "PRIVATE_CHAT_PARTICIPANT",
  PRIVATE_CHAT_AUDIO: "PRIVATE_CHAT_PARTICIPANT",
  PRIVATE_CHAT_DOCUMENT: "PRIVATE_CHAT_PARTICIPANT",
  GROUP_CHAT_IMAGE: "GROUP_MEMBER",
  GROUP_CHAT_VIDEO: "GROUP_MEMBER",
  GROUP_CHAT_AUDIO: "GROUP_MEMBER",
  GROUP_CHAT_DOCUMENT: "GROUP_MEMBER",
  COMMUNITY_CHAT_IMAGE: "COMMUNITY_MEMBER",
  COMMUNITY_CHAT_VIDEO: "COMMUNITY_MEMBER",
  COMMUNITY_CHAT_AUDIO: "COMMUNITY_MEMBER",
  COMMUNITY_CHAT_DOCUMENT: "COMMUNITY_MEMBER",
  LIVESTREAM_THUMBNAIL: "PUBLIC",
  LIVESTREAM_BANNER: "PUBLIC",
  LIVESTREAM_RECORDING: "COMMUNITY_MEMBER",
  ADMIN_ATTACHMENT: "ADMIN",
  OTHER: "OWNER",
};

// ─── Guards ────────────────────────────────────────────────────────────────

export function isMediaOwnerType(value: string): value is MediaOwnerType {
  return (MEDIA_OWNER_TYPES as readonly string[]).includes(value);
}

export function isMediaResourceType(value: string): value is MediaResourceType {
  return (MEDIA_RESOURCE_TYPES as readonly string[]).includes(value);
}

export function isMediaScanStatus(value: string): value is MediaScanStatus {
  return (MEDIA_SCAN_STATUSES as readonly string[]).includes(value);
}
