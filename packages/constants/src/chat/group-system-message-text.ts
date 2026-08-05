import { resolvePersonDisplayName } from "../community/system-message-text.js";

export { resolvePersonDisplayName };

export const ChatSystemMessageType = {
  GROUP_CREATED: "GROUP_CREATED",
  MEMBER_JOINED: "MEMBER_JOINED",
  MEMBER_LEFT: "MEMBER_LEFT",
  MEMBER_REMOVED: "MEMBER_REMOVED",
  MEMBER_ADDED: "MEMBER_ADDED",
  MEMBER_BANNED: "MEMBER_BANNED",
  MEMBER_UNBANNED: "MEMBER_UNBANNED",
  ROOM_RENAMED: "ROOM_RENAMED",
  ROLE_CHANGED: "ROLE_CHANGED",
  AVATAR_CHANGED: "AVATAR_CHANGED",
  ADMIN_ASSIGNED: "ADMIN_ASSIGNED",
  ADMIN_REMOVED: "ADMIN_REMOVED",
  OWNERSHIP_TRANSFERRED: "OWNERSHIP_TRANSFERRED",
  DESCRIPTION_CHANGED: "DESCRIPTION_CHANGED",
  INVITE_LINK_CREATED: "INVITE_LINK_CREATED",
  GROUP_INVITE: "GROUP_INVITE",
  CALL_STARTED: "CALL_STARTED",
  CALL_ENDED: "CALL_ENDED",
  MESSAGE_PINNED: "MESSAGE_PINNED",
  MESSAGE_UNPINNED: "MESSAGE_UNPINNED",
  MESSAGES_ENCRYPTED: "MESSAGES_ENCRYPTED",
  FRIENDSHIP_CREATED: "FRIENDSHIP_CREATED",
  FRIENDSHIP_DELETED: "FRIENDSHIP_DELETED",
  FRIENDSHIP_BLOCKED: "FRIENDSHIP_BLOCKED",
  FRIENDSHIP_BANNED: "FRIENDSHIP_BANNED",
} as const;

export type ChatSystemMessageType =
  (typeof ChatSystemMessageType)[keyof typeof ChatSystemMessageType];

/**
 * Shared Private/Group SYSTEM last-activity policy. Mirrors Community's
 * SYSTEM_MESSAGE_BUMPS_ACTIVITY: lifecycle churn and low-signal state changes
 * render in history without reordering the conversation list.
 */
export const CHAT_SYSTEM_MESSAGE_BUMPS_ACTIVITY: Record<
  ChatSystemMessageType,
  boolean
> = {
  GROUP_CREATED: true,
  MEMBER_JOINED: false,
  MEMBER_LEFT: false,
  MEMBER_REMOVED: false,
  MEMBER_ADDED: true,
  MEMBER_BANNED: false,
  MEMBER_UNBANNED: false,
  OWNERSHIP_TRANSFERRED: true,
  ROOM_RENAMED: true,
  ROLE_CHANGED: true,
  AVATAR_CHANGED: true,
  ADMIN_ASSIGNED: true,
  ADMIN_REMOVED: true,
  DESCRIPTION_CHANGED: true,
  INVITE_LINK_CREATED: false,
  GROUP_INVITE: true,
  CALL_STARTED: true,
  CALL_ENDED: true,
  MESSAGE_PINNED: true,
  MESSAGE_UNPINNED: false,
  MESSAGES_ENCRYPTED: false,
  FRIENDSHIP_CREATED: true,
  FRIENDSHIP_DELETED: true,
  FRIENDSHIP_BLOCKED: true,
  FRIENDSHIP_BANNED: false,
};

export function chatSystemMessageBumpsActivity(event: string): boolean {
  return (
    CHAT_SYSTEM_MESSAGE_BUMPS_ACTIVITY[event as ChatSystemMessageType] ?? true
  );
}

function groupRoleArticleForm(role: string): string {
  const r = role.toUpperCase();
  if (r === "OWNER") return "the group owner";
  if (r === "ADMIN") return "an admin";
  if (r === "MODERATOR") return "a moderator";
  return "a member";
}

/**
 * Deterministic English fallback text per group SYSTEM event. When `viewerUserId`
 * matches the actor or subject, names are replaced with first-person "You …" forms.
 */
export function buildGroupSystemFallbackText(
  event: string,
  data: Record<string, unknown>,
  viewerUserId?: string | null
): string {
  const actor = (data.actorName as string) || "Someone";
  const target = (data.targetName as string) || "a member";
  const actorId = String(data.actorId ?? "").trim();
  const targetId = String(data.targetUserId ?? "").trim();
  const viewer = viewerUserId?.trim() ?? "";
  const isActor = Boolean(viewer && actorId && viewer === actorId);
  const isTarget = Boolean(viewer && targetId && viewer === targetId);

  switch (event) {
    case "GROUP_CREATED":
      if (isActor) return "You created the group";
      return `${actor} created the group`;

    case "MEMBER_ADDED":
      if (isTarget) return "You were added to the group";
      return `${actor} added ${target}`;

    case "MEMBER_JOINED":
      if (isActor) return "You joined the group";
      return `${actor} joined the group`;

    case "MEMBER_LEFT":
      if (isActor) return "You left the group";
      return `${actor} left the group`;

    case "MEMBER_REMOVED":
      if (isTarget) return "You were removed";
      return `${actor} removed ${target}`;

    case "MEMBER_BANNED":
      if (isTarget) return "You were banned";
      return `${actor} banned ${target}`;

    case "MEMBER_UNBANNED":
      if (isTarget) return "You were unbanned";
      return `${actor} unbanned ${target}`;

    case "ADMIN_ASSIGNED":
      if (isTarget) return "You are now an admin";
      return `${target} is now an admin`;

    case "ADMIN_REMOVED":
      if (isTarget) return "You are now a member";
      return `${target} is now a member`;

    case "OWNERSHIP_TRANSFERRED":
      if (isActor) return `You transferred ownership to ${target}`;
      if (isTarget) return `${actor} transferred ownership to you`;
      return `${actor} transferred ownership to ${target}`;

    case "ROLE_CHANGED": {
      const newRole = (data.newRole as string) || "";
      const role = groupRoleArticleForm(newRole);
      if (isTarget) return `You are now ${role}`;
      return `${target} is now ${role}`;
    }

    case "MESSAGE_PINNED":
      if (isActor) return "You pinned a message";
      return `${actor} pinned a message`;

    case "MESSAGE_UNPINNED":
      if (isActor) return "You unpinned a message";
      return `${actor} unpinned a message`;

    case "ROOM_RENAMED": {
      const name = (data.newName as string) || "";
      if (isActor) {
        return name
          ? `You renamed the group to "${name}"`
          : "You renamed the group";
      }
      return name
        ? `${actor} renamed the group to "${name}"`
        : `${actor} renamed the group`;
    }

    case "AVATAR_CHANGED":
      if (isActor) return "You changed the group photo";
      return `${actor} changed the group photo`;

    case "DESCRIPTION_CHANGED":
      if (isActor) return "You updated the group description";
      return `${actor} updated the group description`;

    case "INVITE_LINK_CREATED":
      if (isActor) return "You created an invite link";
      return `${actor} created an invite link`;

    case "GROUP_INVITE":
      if (isActor) return "You shared a group invite";
      return `${actor} shared a group invite`;

    case "MESSAGES_ENCRYPTED":
      return "Messages are end-to-end encrypted";

    default:
      if (isActor) return "You updated the group";
      return `${actor} updated the group`;
  }
}

function formatCallDuration(durationSec: number): string {
  const total = Math.max(0, Math.floor(durationSec));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${mm}:${ss}`
    : `${mm}:${ss}`;
}

/** Shared deterministic English fallback text for Private SYSTEM events. */
export function buildPrivateSystemFallbackText(
  event: string,
  data: Record<string, unknown>,
  viewerUserId?: string | null
): string {
  const actor = (data.actorName as string) || "Someone";
  const target = (data.targetName as string) || "someone";
  const actorId = String(data.actorId ?? "").trim();
  const targetId = String(data.targetUserId ?? data.peerId ?? "").trim();
  const viewer = viewerUserId?.trim() ?? "";
  const isActor = Boolean(viewer && actorId && viewer === actorId);
  const isTarget = Boolean(viewer && targetId && viewer === targetId);

  switch (event) {
    case "MESSAGE_PINNED":
      if (isActor) return "You pinned a message";
      return `${actor} pinned a message`;

    case "MESSAGE_UNPINNED":
      if (isActor) return "You unpinned a message";
      return `${actor} unpinned a message`;

    case "GROUP_INVITE":
      if (isActor) return "You shared a group invite";
      return `${actor} shared a group invite`;

    case "CALL_ENDED": {
      const callLabel =
        String(data.callType ?? "").toUpperCase() === "VIDEO"
          ? "Video"
          : "Voice";
      const status = String(data.status ?? "ENDED").toUpperCase();
      const durationSec = Number(data.durationSec ?? 0);
      if (status === "DECLINED") return `${callLabel} call declined`;
      if (status === "CANCELLED") return `${callLabel} call cancelled`;
      return `${callLabel} call lasted ${formatCallDuration(durationSec)}`;
    }

    case "FRIENDSHIP_CREATED":
      return isActor || isTarget
        ? `You and ${isActor ? target : actor} are now friends`
        : `${actor} and ${target} are now friends`;

    case "FRIENDSHIP_DELETED":
      if (isActor) return `You removed ${target}`;
      if (isTarget) return `${actor} removed you`;
      return `${actor} removed ${target}`;

    case "FRIENDSHIP_BLOCKED":
      if (isActor) return `You blocked ${target}`;
      if (isTarget) return `${actor} blocked you`;
      return `${actor} blocked ${target}`;

    case "FRIENDSHIP_BANNED":
      if (isActor) return `You banned ${target}`;
      if (isTarget) return `${actor} banned you`;
      return `${actor} banned ${target}`;

    default:
      if (isActor) return "You updated the chat";
      return `${actor} updated the chat`;
  }
}

/**
 * Member whose inbox-list bump preview should read "You …" instead of the
 * third-person line — mirrors `resolveCommunitySystemSubjectUserId`. Only the
 * events where the target's own perspective actually differs from everyone
 * else's need an entry; every other event bumps with the shared text as-is.
 */
export function resolveGroupSystemSubjectUserId(
  event: string,
  data: Record<string, unknown>
): string | null {
  const targetId = String(data.targetUserId ?? "").trim();
  switch (event) {
    case "MEMBER_ADDED":
    case "MEMBER_BANNED":
    case "MEMBER_UNBANNED":
    case "OWNERSHIP_TRANSFERRED":
    case "ROLE_CHANGED":
      return targetId || null;
    default:
      return null;
  }
}

/** Personalize a persisted third-person group SYSTEM line for one viewer. */
export function personalizeGroupSystemMessageForViewer(
  event: string,
  systemData: Record<string, unknown>,
  thirdPersonText: string,
  viewerUserId: string
): string {
  if (!viewerUserId.trim()) return thirdPersonText;
  const personalized = buildGroupSystemFallbackText(
    event,
    systemData,
    viewerUserId
  );
  return personalized === thirdPersonText ? thirdPersonText : personalized;
}

/** Personalize a persisted private SYSTEM line for one viewer. */
export function personalizePrivateSystemMessageForViewer(
  event: string,
  systemData: Record<string, unknown>,
  thirdPersonText: string,
  viewerUserId: string
): string {
  if (!viewerUserId.trim()) return thirdPersonText;
  if (event === "CALL_ENDED") return thirdPersonText;
  const personalized = buildPrivateSystemFallbackText(
    event,
    systemData,
    viewerUserId
  );
  return personalized === thirdPersonText ? thirdPersonText : personalized;
}
