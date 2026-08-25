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

/**
 * Backfill `systemData.actorName` from the row's DURABLE sender id.
 *
 * Every SYSTEM/invite row's sentence is rebuilt per reader from `systemData`
 * (see `buildPrivateSystemFallbackText`), so the stored `actorName` is the only
 * thing standing between the row and its neutral "Someone shared a … invite"
 * fallback. A writer that stamped an empty name — community-service resolved
 * the inviter through `displayName`, which user-service builds from
 * firstName+lastName alone — condemns that row to "Someone" on every future
 * read, in both directions and after every refresh.
 *
 * The id IS on the row (`actorId`/`inviterId`, written by both invite writers),
 * so the name is recoverable from IDENTITY at read time. `nameOf` returns the
 * live name for an id or `""` when there is none to show; friendship is not
 * consulted here and must not be — the sender is the same person whether or not
 * the two are still friends.
 *
 * Returns the input by REFERENCE when nothing changed, so callers can cheaply
 * detect a no-op. A name already on the row always wins: this repairs gaps, it
 * never rewrites history with a since-renamed identity.
 */
export function resolveSystemActorName(
  systemData: unknown,
  nameOf: (userId: string) => string
): unknown {
  if (!systemData || typeof systemData !== "object") return systemData;
  const data = systemData as Record<string, unknown>;
  const stored = String(data.actorName ?? data.inviterName ?? "").trim();
  if (stored) return systemData;
  const actorId = String(data.actorId ?? data.inviterId ?? "").trim();
  if (!actorId) return systemData;
  const name = nameOf(actorId).trim();
  if (!name) return systemData;
  return { ...data, actorName: name };
}

/** {@link resolveSystemActorName} applied to a whole message/preview row. */
export function withResolvedSystemActor<T>(
  row: T,
  nameOf: (userId: string) => string
): T {
  if (!row || typeof row !== "object") return row;
  const current = (row as { systemData?: unknown }).systemData;
  const resolved = resolveSystemActorName(current, nameOf);
  if (resolved === current) return row;
  return { ...(row as object), systemData: resolved } as T;
}
