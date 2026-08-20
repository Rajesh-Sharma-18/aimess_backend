import { t } from "./i18n.js";
import { currentLocale } from "./locale-context.js";
import {
  DEFAULT_LOCALE,
  STORED_TEXT_LOCALE,
  type SupportedLocale,
} from "./locale.js";
import type { MessageKey } from "./messages/index.js";

/**
 * The catalog key each content type previews as in a LIST row / push body.
 * Shared so chat-service (which renders the preview) and the read/emit seams
 * that re-render it per reader (api-gateway sockets, notifications-service push,
 * community-service `/communities/mine`) agree on one label table.
 */
export const PREVIEW_KEY_BY_CONTENT_TYPE: Readonly<Record<string, MessageKey>> =
  {
    IMAGE: "PREVIEW_IMAGE",
    VIDEO: "PREVIEW_VIDEO",
    GIF: "PREVIEW_GIF",
    VOICE: "PREVIEW_VOICE",
    AUDIO: "PREVIEW_AUDIO",
    DOCUMENT: "PREVIEW_DOCUMENT",
    STICKER: "PREVIEW_STICKER",
    LOCATION: "PREVIEW_LOCATION",
    CONTACT: "PREVIEW_CONTACT",
  };

/**
 * Re-render an already-built list/push preview in the reader's own language.
 *
 * The preview is built ONCE, at write time, in `STORED_TEXT_LOCALE` (English) —
 * it is fanned out to an audience of many languages, so no single locale is
 * correct at that point. Every per-reader seam calls this to translate it, the
 * same way `personalize*SystemMessageForViewer` re-renders a SYSTEM sentence.
 *
 * Only a PURE label is rewritten: the swap happens when `text` still equals the
 * English label for its type. A preview carrying user data (`📄 report.pdf`,
 * `📍 Ben Thanh Market`, `👤 Minh Anh`) never matches, so user-generated
 * content is returned untouched — which is also why this needs no params.
 */
export function localizeMessagePreview(
  text: string | null | undefined,
  contentType: string | null | undefined,
  locale: SupportedLocale = currentLocale(DEFAULT_LOCALE)
): string {
  return swapLabel(text, PREVIEW_KEY_BY_CONTENT_TYPE, contentType, locale);
}

/** Swap `text` for its `locale` rendering iff it is still the English label. */
function swapLabel(
  text: string | null | undefined,
  table: Readonly<Record<string, MessageKey>>,
  contentType: string | null | undefined,
  locale: SupportedLocale
): string {
  const value = String(text ?? "");
  if (!value || locale === STORED_TEXT_LOCALE) return value;
  const key = table[String(contentType ?? "").toUpperCase()];
  if (!key) return value;
  return value === t(key, STORED_TEXT_LOCALE) ? t(key, locale) : value;
}

/**
 * The catalog key each content type previews as in a REPLY SNAPSHOT. Separate
 * table from {@link PREVIEW_KEY_BY_CONTENT_TYPE} because the two surfaces word
 * it differently in English (the list row carries an emoji on every type, the
 * reply snapshot does not) — see `chat-message.serializer.ts`.
 */
export const QUOTE_KEY_BY_CONTENT_TYPE: Readonly<Record<string, MessageKey>> = {
  IMAGE: "QUOTE_IMAGE",
  VIDEO: "QUOTE_VIDEO",
  VOICE: "QUOTE_VOICE",
  AUDIO: "QUOTE_AUDIO",
  DOCUMENT: "QUOTE_DOCUMENT",
  GIF: "QUOTE_GIF",
  STICKER: "QUOTE_STICKER",
  CONTACT: "QUOTE_CONTACT",
  LOCATION: "QUOTE_LOCATION",
  VOICE_CALL: "QUOTE_VOICE_CALL",
  VIDEO_CALL: "QUOTE_VIDEO_CALL",
};

/**
 * {@link localizeMessagePreview} for a PERSISTED reply snapshot: the preview was
 * rendered and stored when the reply was written, so a reader in another
 * language needs the pure label swapped on read. Quoted user text never matches
 * a label and is returned untouched.
 */
export function localizeQuotePreview(
  text: string | null | undefined,
  contentType: string | null | undefined,
  locale: SupportedLocale = currentLocale(DEFAULT_LOCALE)
): string {
  return swapLabel(text, QUOTE_KEY_BY_CONTENT_TYPE, contentType, locale);
}
