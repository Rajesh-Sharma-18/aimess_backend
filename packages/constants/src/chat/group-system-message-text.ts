import { resolvePersonDisplayName } from "../community/system-message-text.js";

export { resolvePersonDisplayName };

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

    case "ROLE_CHANGED": {
      const newRole = (data.newRole as string) || "";
      const oldRole = (data.oldRole as string) || "";
      const rank: Record<string, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };
      const roleLabel = (r: string) => r.charAt(0) + r.slice(1).toLowerCase();

      if (newRole === "OWNER") {
        if (isActor) return `You made ${target} the group owner`;
        if (isTarget) return `${actor} made you the group owner`;
        return `${actor} made ${target} the group owner`;
      }
      if (oldRole && rank[oldRole] != null && rank[newRole] != null) {
        const promoted = rank[newRole]! > rank[oldRole]!;
        if (promoted) {
          if (isTarget) return `${actor} promoted you to ${roleLabel(newRole)}`;
          return `${actor} promoted ${target} to ${roleLabel(newRole)}`;
        }
        if (isTarget) return `${actor} demoted you to ${roleLabel(newRole)}`;
        return `${actor} demoted ${target} to ${roleLabel(newRole)}`;
      }
      const role = newRole || "a new role";
      if (isTarget) return `${actor} changed your role to ${role}`;
      return `${actor} changed ${target}'s role to ${role}`;
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

    default:
      if (isActor) return "You updated the group";
      return `${actor} updated the group`;
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
