import {
  currentLocale,
  isPersonalizableSystemContentType,
  localizeMessagePreview,
  personalizeGroupSystemMessageForViewer,
  personalizePrivateSystemMessageForViewer,
  type SupportedLocale,
} from "@aimess/constants";

/**
 * Re-render a persisted list-row SYSTEM preview in the reader's own language.
 *
 * A SYSTEM message row stores its sentence baked in `STORED_TEXT_LOCALE`
 * (English) plus the canonical `systemEvent` + `systemData` it was built from.
 * Message HISTORY has always re-rendered from that pair per reader; the inbox
 * previewing the very same message did not — it passed the baked snapshot
 * through — so a Thai reader saw a Thai transcript under an English list row.
 * The live `conv:updated` bump is fixed at the gateway (per-socket locale); this
 * is the REST half, and both must exist or the row flips language on refresh.
 *
 * Rows written before the group snapshot carried `systemEvent` keep their baked
 * text: there is nothing to rebuild from, and the next message in that room
 * overwrites the snapshot anyway. No migration, no history rewritten — same
 * philosophy as the message rows themselves.
 */
export function withLocalizedSystemPreview<
  T extends {
    messageType?: string | null;
    contentType?: string | null;
    systemEvent?: string | null;
    systemData?: unknown;
    text?: string | null;
    content?: unknown;
  },
>(
  preview: T | null | undefined,
  conversationType: "PRIVATE" | "GROUP",
  viewerUserId: string,
  locale: SupportedLocale = currentLocale()
): T | null | undefined {
  if (!preview || typeof preview !== "object") return preview;

  const contentType = String(
    preview.contentType ?? preview.messageType ?? ""
  ).toUpperCase();
  if (!isPersonalizableSystemContentType(contentType)) {
    // Not a SYSTEM row — but a media/structured row previews as a LABEL
    // ("🎤 Voice Message"), baked in English at write time exactly like a
    // system sentence, so it needs the same per-reader rebuild.
    return withLocalizedLabel(preview, contentType, locale);
  }

  const systemEvent = String(preview.systemEvent ?? "");
  if (!systemEvent) return preview;

  const nested = preview.content as { text?: string | null } | null | undefined;
  // The two snapshot shapes disagree about where the sentence lives: the group
  // preview keeps it at the top level, the private one under `content`. Read
  // whichever is populated and write back to both, so neither shape's readers
  // (nor the `lastActivity.preview` derived from `content`) go stale.
  const storedText = String(preview.text ?? nested?.text ?? "");
  if (!storedText) return preview;

  const systemData = (preview.systemData ?? {}) as Record<string, unknown>;
  const localized =
    conversationType === "PRIVATE"
      ? personalizePrivateSystemMessageForViewer(
          systemEvent,
          systemData,
          storedText,
          viewerUserId,
          locale
        )
      : personalizeGroupSystemMessageForViewer(
          systemEvent,
          systemData,
          storedText,
          viewerUserId,
          locale
        );
  if (localized === storedText) return preview;

  return {
    ...preview,
    ...(preview.text !== undefined ? { text: localized } : {}),
    ...(nested && typeof nested === "object"
      ? { content: { ...nested, text: localized } }
      : {}),
  };
}

/**
 * The media/structured half of {@link withLocalizedSystemPreview}: swap the
 * baked English label for this reader's, leaving a preview that carries user
 * data (a filename, a place name) exactly as stored.
 */
function withLocalizedLabel<
  T extends { text?: string | null; content?: unknown },
>(preview: T, contentType: string, locale: SupportedLocale): T {
  const nested = preview.content as { text?: string | null } | null | undefined;
  const storedText = String(preview.text ?? nested?.text ?? "");
  const localized = localizeMessagePreview(storedText, contentType, locale);
  if (!storedText || localized === storedText) return preview;
  return {
    ...preview,
    ...(preview.text !== undefined ? { text: localized } : {}),
    ...(nested && typeof nested === "object"
      ? { content: { ...nested, text: localized } }
      : {}),
  };
}

/**
 * The same rebuild for the normalized `lastActivity.preview` string, which is
 * derived from the snapshot's content rather than being part of it.
 */
export function localizedActivityPreview(
  preview: string,
  snapshot: {
    messageType?: string | null;
    contentType?: string | null;
    systemEvent?: string | null;
    systemData?: unknown;
  } | null,
  conversationType: "PRIVATE" | "GROUP",
  viewerUserId: string,
  locale: SupportedLocale = currentLocale()
): string {
  if (!preview || !snapshot) return preview;
  const rebuilt = withLocalizedSystemPreview(
    { ...snapshot, text: preview },
    conversationType,
    viewerUserId,
    locale
  );
  return String(rebuilt?.text ?? preview);
}
