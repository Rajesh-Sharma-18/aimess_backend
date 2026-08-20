import { STORED_TEXT_LOCALE, t, type SupportedLocale } from "@aimess/constants";

/**
 * MessagePreviewService — the SINGLE SOURCE OF TRUTH for every conversation /
 * community list bump preview and every push (FCM data-message) preview across
 * chat-service. Both the socket `*:updated` bumps and the persisted
 * `community.activity` denormalization (read by GET /communities/mine) MUST go
 * through here so the REST list preview is byte-identical to the socket preview
 * for the same message.
 *
 * Canonical list/preview string for a message, honoring the documented
 * `ListBumpLastMessage` convention (asyncapi `ListBumpLastMessage` +
 * SOCKET_EVENTS §4.2): TEXT/SYSTEM show the body; media & structured types show a
 * labelled placeholder with the filename / place / contact name interpolated when
 * known. `content` may be the structured content object
 * (`{ text, files[], location, contact }`) or a plain text string (community
 * stores the body as a string), so a non-text message never yields an empty list
 * preview.
 *
 * Do NOT re-implement preview/slice logic anywhere else — import from this file.
 */

/**
 * Convert a message's content-type + content object to its render-ready list
 * preview string. This is the canonical entry point.
 */
export function convertMessageToPreview(
  contentType: string,
  content: unknown,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): string {
  const type = String(contentType ?? "").toUpperCase();
  const c: Record<string, unknown> =
    content && typeof content === "object"
      ? (content as Record<string, unknown>)
      : { text: typeof content === "string" ? content : "" };
  const text = typeof c.text === "string" ? c.text : "";
  const files = Array.isArray(c.files)
    ? (c.files as Array<Record<string, unknown>>)
    : [];
  const fileName = (files[0]?.name as string) || "";
  const placeName =
    ((c.location as Record<string, unknown> | undefined)
      ?.placeName as string) || "";
  const contactName =
    ((c.contact as Record<string, unknown> | undefined)?.name as string) || "";

  switch (type) {
    case "TEXT":
      return text ? text.slice(0, 200) : t("PREVIEW_TEXT_FALLBACK", locale);
    case "IMAGE":
      return t("PREVIEW_IMAGE", locale);
    case "VIDEO":
      return t("PREVIEW_VIDEO", locale);
    case "GIF":
      return t("PREVIEW_GIF", locale);
    case "VOICE":
      return t("PREVIEW_VOICE", locale);
    case "AUDIO":
      return t("PREVIEW_AUDIO", locale);
    // The filename/place/contact name below is USER DATA — interpolated as-is,
    // never translated. Such a preview never equals a pure label, which is what
    // keeps `localizeMessagePreview` from touching it downstream.
    case "DOCUMENT":
      return fileName ? `📄 ${fileName}` : t("PREVIEW_DOCUMENT", locale);
    case "STICKER":
      return t("PREVIEW_STICKER", locale);
    case "LOCATION":
      return placeName ? `📍 ${placeName}` : t("PREVIEW_LOCATION", locale);
    case "CONTACT":
      return contactName ? `👤 ${contactName}` : t("PREVIEW_CONTACT", locale);
    case "SYSTEM":
      return text || "";
    default:
      return text ? text.slice(0, 200) : t("PREVIEW_UNKNOWN", locale);
  }
}

/**
 * Back-compat alias for {@link convertMessageToPreview}. Existing callers import
 * `buildMessagePreview`; keep this export so they keep working.
 */
export const buildMessagePreview = convertMessageToPreview;

/**
 * Short, notification-ready preview from message type + body text. Thin wrapper
 * over {@link convertMessageToPreview} for the push path (which has only the body
 * text in hand, not the structured content object).
 */
export function buildPushPreview(
  messageType: string,
  text: string,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): string {
  return convertMessageToPreview(messageType, { text }, locale);
}

const REACTION_TARGET_PREVIEW_MAX_LEN = 40;

/**
 * Short, quoted preview of the message a reaction targets, for the
 * `"${actor} reacted ${emoji} to ${preview}"` activity line. Reuses
 * {@link convertMessageToPreview} for the label/text, then truncates TEXT
 * bodies to a reaction-line-appropriate length and quotes them; media/
 * structured types keep their emoji label unquoted (e.g. `📷 Photo`).
 */
export function buildReactionTargetPreview(
  contentType: string,
  content: unknown,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): string {
  const type = String(contentType ?? "").toUpperCase();
  const preview = convertMessageToPreview(contentType, content, locale);
  if (type !== "TEXT" && type !== "SYSTEM") return preview;
  const truncated =
    preview.length > REACTION_TARGET_PREVIEW_MAX_LEN
      ? `${preview.slice(0, REACTION_TARGET_PREVIEW_MAX_LEN).trimEnd()}...`
      : preview;
  return `"${truncated}"`;
}
