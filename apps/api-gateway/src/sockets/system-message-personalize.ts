import {
  personalizeCommunitySystemMessageForViewer,
  personalizeGroupSystemMessageForViewer,
  type CommunitySystemMessageType,
} from "@aimess/constants";

/** Per-viewer "You …" swap for a `community:message:new` SYSTEM payload. */
export function personalizeCommunitySocketMessage(
  data: unknown,
  viewerUserId: string
): unknown {
  if (!viewerUserId) return data;
  const d = data as Record<string, unknown>;
  const contentType = String(d.contentType ?? "").toUpperCase();
  if (contentType !== "SYSTEM") return data;

  const systemMessageType = d.systemMessageType as
    | CommunitySystemMessageType
    | undefined;
  if (!systemMessageType) return data;

  const metadata = (d.systemMetadata ?? {}) as Record<string, unknown>;
  const actorName = String(metadata.actorName ?? "");
  const targetName = String(metadata.targetName ?? "");
  const thirdPersonText =
    String(d.message ?? "") ||
    String((d.content as { text?: string } | null)?.text ?? "");

  const personalized = personalizeCommunitySystemMessageForViewer(
    systemMessageType,
    metadata,
    thirdPersonText,
    actorName,
    targetName,
    viewerUserId
  );
  if (personalized === thirdPersonText) return data;

  const content = d.content;
  return {
    ...d,
    message: personalized,
    content:
      content && typeof content === "object"
        ? { ...(content as object), text: personalized }
        : { text: personalized, files: [] },
  };
}

/** Per-viewer "You …" swap for a group `message:new` SYSTEM payload. */
export function personalizeGroupSocketMessage(
  data: unknown,
  viewerUserId: string
): unknown {
  if (!viewerUserId) return data;
  const d = data as Record<string, unknown>;
  // `/chat` carries both PRIVATE and GROUP messages on `conv:*`. A private
  // SYSTEM message (for example CALL_ENDED) has its own complete fallback text
  // and must never be run through the group lifecycle renderer, whose unknown-
  // event fallback would rewrite it to "Someone updated the group".
  const conversationType = String(d.conversationType ?? "").toUpperCase();
  if (conversationType !== "GROUP") return data;

  const contentType = String(
    d.contentType ?? d.messageType ?? ""
  ).toUpperCase();
  if (contentType !== "SYSTEM") return data;

  const systemEvent = String(d.systemEvent ?? "");
  if (!systemEvent) return data;

  const systemData = (d.systemData ?? {}) as Record<string, unknown>;
  const thirdPersonText =
    String(d.contentText ?? "") ||
    String((d.content as { text?: string } | null)?.text ?? "");

  const personalized = personalizeGroupSystemMessageForViewer(
    systemEvent,
    systemData,
    thirdPersonText,
    viewerUserId
  );
  if (personalized === thirdPersonText) return data;

  const content = d.content;
  return {
    ...d,
    contentText: personalized,
    content:
      content && typeof content === "object"
        ? { ...(content as object), text: personalized }
        : { text: personalized, urls: [], files: [] },
  };
}
