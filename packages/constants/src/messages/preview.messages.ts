import type { MessageCatalog } from "./types.js";

/**
 * Message PREVIEW labels — the placeholder a non-text message renders as in a
 * conversation/community list row, a push body, or a reply snapshot
 * ("🎤 Voice Message", "📷 Photo", …).
 *
 * These were the last user-facing sentences still hardcoded in English: every
 * SYSTEM line already re-rendered per reader, so a Thai reader saw a Thai
 * transcript under an English "🎤 Voice Message" row. The English values here
 * are byte-identical to the strings they replace, so the stored/baked text
 * (`STORED_TEXT_LOCALE`) is unchanged and only the read/emit seams translate.
 *
 * Two families, because the two surfaces genuinely word it differently in
 * English (the list keeps an emoji on every type; the reply snapshot does not):
 *   PREVIEW_* — list bump + push, from `convertMessageToPreview`
 *   QUOTE_*   — reply snapshot, from `buildReplyPreviewText`
 *
 * Emoji are part of the label and are NOT translated. A label with a dynamic
 * part (`📄 report.pdf`, `📍 Ben Thanh Market`) is user data — it never comes
 * from here and is never rewritten.
 */
export const PREVIEW_MESSAGES = {
  // ── List / push previews ────────────────────────────────────────────────
  PREVIEW_TEXT_FALLBACK: {
    vi: "Đã gửi một tin nhắn",
    en: "Sent a message",
    th: "ส่งข้อความ",
  },
  PREVIEW_IMAGE: {
    vi: "📷 Hình ảnh",
    en: "📷 Photo",
    th: "📷 รูปภาพ",
  },
  PREVIEW_VIDEO: {
    vi: "🎥 Video",
    en: "🎥 Video",
    th: "🎥 วิดีโอ",
  },
  PREVIEW_GIF: {
    vi: "🎞 GIF",
    en: "🎞 GIF",
    th: "🎞 GIF",
  },
  PREVIEW_VOICE: {
    vi: "🎤 Tin nhắn thoại",
    en: "🎤 Voice Message",
    th: "🎤 ข้อความเสียง",
  },
  PREVIEW_AUDIO: {
    vi: "🎵 Âm thanh",
    en: "🎵 Audio",
    th: "🎵 ไฟล์เสียง",
  },
  PREVIEW_DOCUMENT: {
    vi: "📄 Tài liệu",
    en: "📄 Document",
    th: "📄 เอกสาร",
  },
  PREVIEW_STICKER: {
    vi: "Nhãn dán",
    en: "Sticker",
    th: "สติกเกอร์",
  },
  PREVIEW_LOCATION: {
    vi: "📍 Vị trí",
    en: "📍 Location",
    th: "📍 ตำแหน่งที่ตั้ง",
  },
  PREVIEW_CONTACT: {
    vi: "👤 Danh thiếp",
    en: "👤 Contact",
    th: "👤 ผู้ติดต่อ",
  },
  PREVIEW_UNKNOWN: {
    vi: "Tin nhắn mới",
    en: "New message",
    th: "ข้อความใหม่",
  },

  // ── Reply / quote snapshot previews ─────────────────────────────────────
  QUOTE_IMAGE: {
    vi: "📷 Hình ảnh",
    en: "📷 Photo",
    th: "📷 รูปภาพ",
  },
  /** `{{count}}` is the attachment count — never localized away. */
  QUOTE_IMAGE_MANY: {
    vi: "📷 {{count}} hình ảnh",
    en: "📷 {{count}} Photos",
    th: "📷 รูปภาพ {{count}} รูป",
  },
  QUOTE_VIDEO: {
    vi: "🎥 Video",
    en: "🎥 Video",
    th: "🎥 วิดีโอ",
  },
  QUOTE_VOICE: {
    vi: "🎤 Tin nhắn thoại",
    en: "🎤 Voice message",
    th: "🎤 ข้อความเสียง",
  },
  QUOTE_AUDIO: {
    vi: "🎵 Âm thanh",
    en: "🎵 Audio",
    th: "🎵 ไฟล์เสียง",
  },
  QUOTE_DOCUMENT: {
    vi: "📄 Tài liệu",
    en: "📄 Document",
    th: "📄 เอกสาร",
  },
  QUOTE_GIF: {
    vi: "GIF",
    en: "GIF",
    th: "GIF",
  },
  QUOTE_STICKER: {
    vi: "Nhãn dán",
    en: "Sticker",
    th: "สติกเกอร์",
  },
  QUOTE_CONTACT: {
    vi: "Danh thiếp",
    en: "Contact",
    th: "ผู้ติดต่อ",
  },
  QUOTE_LOCATION: {
    vi: "Vị trí",
    en: "Location",
    th: "ตำแหน่งที่ตั้ง",
  },
  QUOTE_VOICE_CALL: {
    vi: "📞 Cuộc gọi thoại",
    en: "📞 Voice call",
    th: "📞 สายสนทนา",
  },
  QUOTE_VIDEO_CALL: {
    vi: "📹 Cuộc gọi video",
    en: "📹 Video call",
    th: "📹 สายวิดีโอ",
  },
  QUOTE_DELETED: {
    vi: "Tin nhắn đã bị xóa",
    en: "Message deleted",
    th: "ข้อความถูกลบแล้ว",
  },
} as const satisfies MessageCatalog;

export type PreviewMessageKey = keyof typeof PREVIEW_MESSAGES;
