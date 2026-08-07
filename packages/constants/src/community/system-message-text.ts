import {
  CommunitySystemMessageType,
  type CommunitySystemMessageType as CommunitySystemMessageTypeValue,
} from "./system-message.js";

/**
 * Prefer first + last name (`displayName`); never fall back to username/handle
 * (system-message sentences read as "X added Y", a raw handle reads wrong
 * there). Still needs SOME non-empty label when displayName is unresolved
 * (snapshot-cache miss) — otherwise the persisted sentence renders with a
 * blank actor/target ("added "), permanently, since system message text is
 * baked in at send time and never recomputed.
 */
export function resolvePersonDisplayName(
  snapshot: Record<string, unknown> | null | undefined
): string {
  const name = snapshot ? String(snapshot.displayName ?? "").trim() : "";
  return name || "Unknown User";
}

/**
 * Human-readable mute duration from whole minutes, rendered to match the client
 * duration picker labels (5m / 10m / 30m / 1h / 6h / 24h / 7d / 30d):
 *   5 → "5 minutes", 30 → "30 minutes", 60 → "1 hour", 360 → "6 hours",
 *   1440 → "24 hours", 10080 → "7 days", 43200 → "30 days".
 * Sub-7-day clean-hour spans stay in HOURS (so 1440 reads "24 hours", not
 * "1 day"); 7 days and up render in DAYS. Falls back to minutes for odd values.
 */
export function formatMuteDuration(minutes: number): string {
  // 7 days (10080 min) and beyond → days, matching the 7d / 30d presets.
  if (minutes >= 10080 && minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  // 1h..< 7d in whole hours → hours, so 24h stays "24 hours".
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * Human-readable livestream runtime from whole seconds, Telegram-style:
 *   5040 → "1h 24m", 3600 → "1h", 1440 → "24m", 45 → "45s", 0 → "0s".
 * Hours+minutes when ≥ 1h (minutes dropped on the exact hour), minutes when
 * ≥ 1m, otherwise seconds. Used for the LIVE_STREAM_ENDED system message and
 * the livestream-ended push body.
 */
export function formatStreamDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${s}s`;
}

/** "MODERATOR" → "moderator", "ADMIN" → "admin". */
function roleArticleForm(role: string): string {
  const r = role.toUpperCase();
  if (r === "ADMIN") return "an admin";
  if (r === "MODERATOR") return "a moderator";
  return "a member";
}

function actorUserIdOf(metadata: Record<string, unknown>): string {
  return String(metadata.actorUserId ?? "").trim();
}

function targetUserIdOf(metadata: Record<string, unknown>): string {
  return String(metadata.targetUserId ?? "").trim();
}

/**
 * Deterministic English fallback text per community SYSTEM subtype (Telegram
 * phrasing). When `viewerUserId` is set and matches the actor or subject, names
 * are replaced with first-person "You …" forms for that viewer.
 */
export function buildCommunitySystemFallbackText(
  type: CommunitySystemMessageTypeValue,
  metadata: Record<string, unknown>,
  actorName: string,
  targetName: string,
  viewerUserId?: string | null
): string {
  const actor = actorName || "Someone";
  const target = (metadata.targetName as string) || targetName || "A member";

  const actorId = actorUserIdOf(metadata);
  const targetId = targetUserIdOf(metadata);
  const viewer = viewerUserId?.trim() ?? "";
  const isActor = Boolean(viewer && actorId && viewer === actorId);
  const isTarget = Boolean(viewer && targetId && viewer === targetId);

  switch (type) {
    case "COMMUNITY_CREATED":
      return "Community created";
    case "COMMUNITY_NAME_UPDATED": {
      const newName = ((metadata.newName as string) || "").trim();
      return newName
        ? `Community renamed to "${newName}"`
        : "Community name updated";
    }
    case "COMMUNITY_DESCRIPTION_UPDATED":
      return "Community description updated";
    case "COMMUNITY_AVATAR_UPDATED":
      return "Community photo updated";
    case "COMMUNITY_BANNER_UPDATED":
      return "Community banner updated";
    case "COMMUNITY_HANDLE_UPDATED":
      return "Community handle updated";
    case "COMMUNITY_UPDATED":
      return "Community settings updated";
    case "LIVE_STREAM_STARTED":
      // Host-named (Telegram group video-chat parity). "You started …" for the
      // host's own view; "{host} started …" for everyone else.
      return isActor
        ? "You started a livestream"
        : `${actor} started a livestream`;
    case "LIVE_STREAM_ENDED": {
      // Stored fallback stays single-line so the community-list preview is clean;
      // the client composes the richer two-line "…ended the livestream / Duration:
      // {duration}" from systemMessageType + systemMetadata.duration.
      const duration = ((metadata.duration as string) || "").trim();
      const lead = isActor
        ? "You ended the livestream"
        : `${actor} ended the livestream`;
      return duration ? `${lead} (${duration})` : lead;
    }

    case "ROLE_CHANGED":
    case "MEMBER_ROLE_CHANGED": {
      if (isTarget) {
        return buildCommunitySystemFallbackText(
          "ROLE_CHANGED_SELF",
          metadata,
          "",
          "",
          viewer
        );
      }
      const newRole = ((metadata.newRole as string) || "").toUpperCase();
      const oldRole = ((metadata.oldRole as string) || "").toUpperCase();
      // Admin promotion is an ownership hand-off — there is exactly ONE admin, so
      // phrase it as "the community admin" (Telegram-style) rather than "an admin".
      if (newRole === "ADMIN") {
        return `${target} is now the community admin`;
      }
      if (
        newRole === "MEMBER" &&
        (oldRole === "ADMIN" || oldRole === "MODERATOR")
      ) {
        return `${target} is now a member`;
      }
      return `${target} is now ${roleArticleForm(newRole)}`;
    }

    case "ROLE_CHANGED_SELF": {
      const newRole = ((metadata.newRole as string) || "").toUpperCase();
      const oldRole = ((metadata.oldRole as string) || "").toUpperCase();
      if (newRole === "ADMIN") {
        return "You are now the community admin";
      }
      if (
        newRole === "MEMBER" &&
        (oldRole === "ADMIN" || oldRole === "MODERATOR")
      ) {
        return "You are now a member";
      }
      return `You are now ${roleArticleForm(newRole)}`;
    }

    case "MEMBER_JOINED":
      if (isTarget || isActor) return "You joined the community";
      return `${target} joined the community`;

    case "MEMBER_LEFT":
      if (isTarget) return "You left the community";
      return `${target} left the community`;

    case "MEMBER_REMOVED":
      if (isTarget) return "You were removed";
      return `${target} was removed`;

    case "MEMBER_BANNED":
      // PERSONAL message — only the banned member ever reads this.
      if (isTarget) return "You were banned from this community.";
      return `${target} was banned`;

    case "MEMBER_UNBANNED":
      if (isTarget) return "You were unbanned";
      return `${target} was unbanned`;

    case "MEMBER_MUTED": {
      // PERSONAL message — only the muted member ever reads this.
      // Show the concrete expiry timestamp so the user knows exactly when they
      // can post again; fall back to "indefinitely" when no expiry was set.
      const mutedUntilMs = Number(metadata.mutedUntil);
      if (Number.isFinite(mutedUntilMs) && mutedUntilMs > 0) {
        const dateStr = new Date(mutedUntilMs).toUTCString();
        if (isTarget) return `You are muted until ${dateStr}`;
        return `${target} is muted until ${dateStr}`;
      }
      if (isTarget) return "You are muted indefinitely";
      return `${target} is muted indefinitely`;
    }

    case "MEMBER_UNMUTED":
      if (isTarget) return "You were unmuted";
      return `${target} was unmuted`;

    // The ACTOR is a person, never the community — a pin is performed by an
    // admin/moderator, so the line reads "{actor} pinned a message". Symmetrical
    // with UNPINNED_MESSAGE below. `actor` is the pinner's displayName, resolved
    // upstream from the user snapshot (see resolvePersonDisplayName).
    // metadata.communityName is still carried for clients that render the
    // community context alongside the line, but it is NOT the actor.
    case "PINNED_MESSAGE":
      if (isActor) return "You pinned a message";
      return `${actor} pinned a message`;

    case "UNPINNED_MESSAGE":
      if (isActor) return "You unpinned a message";
      return `${actor} unpinned a message`;

    case "COMMUNITY_INVITE_CREATED":
      if (isActor) return "You created an invite link";
      return `${actor} created an invite link`;

    case "COMMUNITY_JOINED":
      return "You joined the community";
    case "JOIN_REQUEST_APPROVED":
      return "Your request to join was approved";
    case "JOIN_REQUEST_REJECTED":
      return "Your request to join was declined";

    default:
      return "Community settings updated";
  }
}

/**
 * Member whose community-list / socket preview should read "You …" for a
 * COMMUNITY-visible system line. Returns null when everyone sees the same text.
 */
export function resolveCommunitySystemSubjectUserId(
  type: CommunitySystemMessageTypeValue,
  metadata: Record<string, unknown>,
  triggeredByUserId: string
): string | null {
  const targetId = targetUserIdOf(metadata);
  const actorId = actorUserIdOf(metadata) || triggeredByUserId;

  switch (type) {
    case "ROLE_CHANGED":
    case "MEMBER_ROLE_CHANGED":
    case "MEMBER_REMOVED":
    case "MEMBER_BANNED":
    case "MEMBER_UNBANNED":
    case "MEMBER_MUTED":
    case "MEMBER_UNMUTED":
    case "MEMBER_LEFT":
      return targetId || null;
    case "PINNED_MESSAGE":
    case "UNPINNED_MESSAGE":
    case "COMMUNITY_INVITE_CREATED":
      return actorId || null;
    default:
      return null;
  }
}

/** First-person preview for the subject member (community list + live bump). */
export function buildCommunitySystemSelfPreview(
  type: CommunitySystemMessageTypeValue,
  metadata: Record<string, unknown>,
  actorName: string,
  targetName: string,
  subjectUserId: string
): string {
  if (type === "ROLE_CHANGED" || type === "MEMBER_ROLE_CHANGED") {
    return buildCommunitySystemFallbackText(
      "ROLE_CHANGED_SELF",
      metadata,
      "",
      "",
      subjectUserId
    );
  }
  if (type === "MEMBER_JOINED") {
    return buildCommunitySystemFallbackText(
      "COMMUNITY_JOINED",
      metadata,
      "",
      "",
      subjectUserId
    );
  }
  return buildCommunitySystemFallbackText(
    type,
    metadata,
    actorName,
    targetName,
    subjectUserId
  );
}

/** Personalize a persisted third-person SYSTEM line for one viewer. */
export function personalizeCommunitySystemMessageForViewer(
  type: CommunitySystemMessageTypeValue,
  metadata: Record<string, unknown>,
  thirdPersonText: string,
  actorName: string,
  targetName: string,
  viewerUserId: string
): string {
  if (!viewerUserId.trim()) return thirdPersonText;
  const personalized = buildCommunitySystemFallbackText(
    type,
    metadata,
    actorName,
    targetName,
    viewerUserId
  );
  return personalized === thirdPersonText ? thirdPersonText : personalized;
}

/**
 * Telegram-style copy for a community message reaction, in all three viewer
 * perspectives at once (community-service's `selectListPreview` picks the
 * right one per viewer; this is the single source of truth for the wording,
 * mirroring the SYSTEM-message self/third-person split above).
 *
 * Self-reaction (`isSelfReaction`, actor reacted to their own message) collapses
 * the target-perspective copy into the self copy since actor === target — there
 * is no third "you received a reaction" viewer in that case.
 */
export function buildReactionActivityText(params: {
  actorName: string;
  /**
   * The reacted-to message's own preview text (e.g. `"Let's meet at 5..."`
   * or `📷 Photo`), from `MessagePreviewService.buildReactionTargetPreview`.
   * Replaces the message owner's name so the line references WHAT was
   * reacted to, not WHO owns it (Telegram/WhatsApp convention).
   */
  targetMessagePreview: string;
  emoji: string;
  isSelfReaction: boolean;
}): {
  /** Shown to everyone except the actor and the target. */
  thirdPersonPreview: string;
  /** Shown to the actor (the person who reacted). */
  selfPreview: string;
  /** Shown to the target (the message owner), when target !== actor. */
  targetPreview: string;
} {
  const { actorName, targetMessagePreview, emoji, isSelfReaction } = params;
  if (isSelfReaction) {
    const selfPreview = `You reacted ${emoji} to ${targetMessagePreview}`;
    return {
      thirdPersonPreview: `${actorName} reacted ${emoji} to ${targetMessagePreview}`,
      selfPreview,
      targetPreview: selfPreview,
    };
  }
  return {
    thirdPersonPreview: `${actorName} reacted ${emoji} to ${targetMessagePreview}`,
    selfPreview: `You reacted ${emoji} to ${targetMessagePreview}`,
    // Target (message owner) sees WHAT was reacted to, same as everyone else —
    // not a vague "your message" placeholder.
    targetPreview: `${actorName} reacted ${emoji} to ${targetMessagePreview}`,
  };
}

export { CommunitySystemMessageType };
