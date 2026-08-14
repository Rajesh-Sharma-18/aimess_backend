import {
  personalizeCommunitySystemMessageForViewer,
  personalizeGroupSystemMessageForViewer,
  personalizePrivateSystemMessageForViewer,
  isPersonalizableSystemContentType,
  STORED_TEXT_LOCALE,
  type CommunitySystemMessageType,
  type SupportedLocale,
} from "@aimess/constants";

/**
 * Per-viewer "You …" swap AND per-viewer translation for a
 * `community:message:new` SYSTEM payload. The row's stored text is English;
 * `locale` is the recipient socket's own language.
 */
export function personalizeCommunitySocketMessage(
  data: unknown,
  viewerUserId: string,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): unknown {
  if (!viewerUserId && locale === STORED_TEXT_LOCALE) return data;
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
    viewerUserId,
    locale
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

/** Per-viewer "You …" swap AND translation for a group/private SYSTEM payload. */
export function personalizeGroupSocketMessage(
  data: unknown,
  viewerUserId: string,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): unknown {
  if (!viewerUserId && locale === STORED_TEXT_LOCALE) return data;
  const d = data as Record<string, unknown>;
  const conversationType = String(d.conversationType ?? "").toUpperCase();
  if (conversationType !== "GROUP" && conversationType !== "PRIVATE") {
    return data;
  }

  const contentType = String(
    d.contentType ?? d.messageType ?? ""
  ).toUpperCase();
  // Invitation cards carry their own kind but still render a `systemEvent`-
  // driven sentence, so they personalize exactly like a generic SYSTEM row.
  if (!isPersonalizableSystemContentType(contentType)) return data;

  const systemEvent = String(d.systemEvent ?? "");
  if (!systemEvent) return data;

  const systemData = (d.systemData ?? {}) as Record<string, unknown>;
  const thirdPersonText =
    String(d.contentText ?? "") ||
    String((d.content as { text?: string } | null)?.text ?? "");

  const personalized =
    conversationType === "PRIVATE"
      ? personalizePrivateSystemMessageForViewer(
          systemEvent,
          systemData,
          thirdPersonText,
          viewerUserId,
          locale
        )
      : personalizeGroupSystemMessageForViewer(
          systemEvent,
          systemData,
          thirdPersonText,
          viewerUserId,
          locale
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
