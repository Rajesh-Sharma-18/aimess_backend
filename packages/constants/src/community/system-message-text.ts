import {
  CommunitySystemMessageType,
  type CommunitySystemMessageType as CommunitySystemMessageTypeValue,
} from "./system-message.js";

/** Prefer first + last name (`displayName`); never fall back to username. */
export function resolvePersonDisplayName(
  snapshot: Record<string, unknown> | null | undefined
): string {
  if (!snapshot) return "";
  return String(snapshot.displayName ?? "").trim();
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
      return newName ? `Renamed to ${newName}` : "Community name updated";
    }
    case "COMMUNITY_DESCRIPTION_UPDATED":
      return "Community description updated";
    case "COMMUNITY_AVATAR_UPDATED":
      return "Community photo updated";
    case "COMMUNITY_BANNER_UPDATED":
      return "Community banner updated";
    case "COMMUNITY_UPDATED":
      return "Community details updated";
    case "LIVE_STREAM_STARTED":
      return "Live stream started";
    case "LIVE_STREAM_ENDED": {
      const duration = ((metadata.duration as string) || "").trim();
      return duration ? `Live stream ended (${duration})` : "Live stream ended";
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
      if (isTarget) return "You were banned";
      return `${target} was banned`;

    case "MEMBER_UNBANNED":
      if (isTarget) return "You were unbanned";
      return `${target} was unbanned`;

    case "MEMBER_MUTED":
      if (isTarget) return "You were muted";
      return `${target} was muted`;

    case "MEMBER_UNMUTED":
      if (isTarget) return "You were unmuted";
      return `${target} was unmuted`;

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
      return "Community details updated";
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

export { CommunitySystemMessageType };
