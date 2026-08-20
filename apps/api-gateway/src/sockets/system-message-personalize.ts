import {
  localizeMessagePreview,
  personalizeCommunitySystemMessageForViewer,
  personalizeGroupSystemMessageForViewer,
  personalizePrivateSystemMessageForViewer,
  isPersonalizableSystemContentType,
  STORED_TEXT_LOCALE,
  type CommunitySystemMessageType,
  type SupportedLocale,
} from "@aimess/constants";

/**
 * The bumped list preview, as published by chat-service's
 * `publishConvUpdated` / `publishCommunityUpdated`. `text` is the sentence baked
 * in at write time (`STORED_TEXT_LOCALE`); the canonical `systemEvent` /
 * `systemMessageType` + params ride alongside it so this side can re-render it.
 * Both are optional — a bump published before they were carried, or by a
 * non-SYSTEM send, simply keeps its `text`.
 */
interface BumpedPreview {
  contentType?: string;
  text?: string;
  systemEvent?: string;
  systemData?: Record<string, unknown>;
  systemMessageType?: CommunitySystemMessageType;
  systemMetadata?: Record<string, unknown>;
}

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

/**
 * Per-viewer translation of the `conv:updated` inbox bump's SYSTEM preview.
 *
 * The in-room `message:new` line and the list row that previews it are two
 * different payloads, and only the first was ever personalized — so the open
 * conversation showed the viewer's language while the row above it in the list
 * showed the writer-baked English. This closes that split for the live bump; the
 * REST inbox does the same rebuild from the persisted row (chat-service
 * `inbox.service.ts`).
 *
 * `selfPreview` (chat-service's first-person override for the subject member) is
 * already applied to `text` by the publisher, and re-rendering with the viewer's
 * id reproduces it — so this is a translation, never a change of perspective.
 */
export function personalizeConvUpdatedPreview(
  data: unknown,
  viewerUserId: string,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): unknown {
  const d = data as Record<string, unknown>;
  const conversationType = String(d.type ?? "").toUpperCase();
  if (conversationType !== "GROUP" && conversationType !== "PRIVATE") {
    return data;
  }
  return withRebuiltPreviewText(d, locale, (preview, storedText) => {
    if (!preview.systemEvent) return storedText;
    const systemData = preview.systemData ?? {};
    return conversationType === "PRIVATE"
      ? personalizePrivateSystemMessageForViewer(
          preview.systemEvent,
          systemData,
          storedText,
          viewerUserId,
          locale
        )
      : personalizeGroupSystemMessageForViewer(
          preview.systemEvent,
          systemData,
          storedText,
          viewerUserId,
          locale
        );
  });
}

/** The `community:updated` half of {@link personalizeConvUpdatedPreview}. */
export function personalizeCommunityUpdatedPreview(
  data: unknown,
  viewerUserId: string,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): unknown {
  const d = data as Record<string, unknown>;
  return withRebuiltPreviewText(d, locale, (preview, storedText) => {
    if (!preview.systemMessageType) return storedText;
    const metadata = preview.systemMetadata ?? {};
    return personalizeCommunitySystemMessageForViewer(
      preview.systemMessageType,
      metadata,
      storedText,
      String(metadata.actorName ?? ""),
      String(metadata.targetName ?? ""),
      viewerUserId,
      locale
    );
  });
}

/**
 * Shared plumbing for both bumps: reach into `lastMessage`, rebuild the SYSTEM
 * sentence, and return a copy. `text` is mirrored at both levels because the two
 * bump payloads disagree about where the preview string lives (the nested
 * `lastMessage.text` is canonical; older clients read the flat one).
 */
function withRebuiltPreviewText(
  d: Record<string, unknown>,
  locale: SupportedLocale,
  rebuild: (preview: BumpedPreview, storedText: string) => string
): unknown {
  const preview = d.lastMessage as BumpedPreview | null | undefined;
  if (!preview || typeof preview !== "object") return d;
  const contentType = String(preview.contentType ?? "").toUpperCase();
  const storedText = String(preview.text ?? "");
  // A media/structured row previews as a LABEL ("🎤 Voice Message"), baked in
  // English by the publisher for the same reason a SYSTEM sentence is: one
  // broadcast, many languages. Swap it for this socket's, then stop — there is
  // no `systemEvent` to rebuild from.
  if (contentType !== "SYSTEM") {
    const label = localizeMessagePreview(storedText, contentType, locale);
    return label === storedText
      ? d
      : { ...d, lastMessage: { ...preview, text: label } };
  }

  const rebuilt = rebuild(preview, storedText);
  if (rebuilt === storedText) return d;
  return { ...d, lastMessage: { ...preview, text: rebuilt } };
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
