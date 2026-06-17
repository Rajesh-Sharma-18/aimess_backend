import type { MessageCatalog } from "./types.js";

/**
 * Media-service domain error messages (category/ownership/object-key validation
 * and the AV scan gate). Distinct from {@link UPLOAD_MESSAGES}, which holds the
 * generic presign-time validation messages shared across services.
 */
export const MEDIA_MESSAGES = {
  MEDIA_REQUEST_INVALID: {
    vi: "Yêu cầu phương tiện không hợp lệ",
    en: "Invalid media request",
  },
  MEDIA_UNKNOWN_CATEGORY: {
    vi: "Danh mục phương tiện không xác định",
    en: "Unknown media category",
  },
  MEDIA_INVALID_OBJECT_KEY: {
    vi: "Khóa đối tượng phương tiện không hợp lệ",
    en: "Invalid media object key",
  },
  MEDIA_NOT_FOUND: {
    vi: "Không tìm thấy tệp phương tiện",
    en: "Media not found",
  },
  CHAT_MEDIA_FORBIDDEN: {
    vi: "Bạn không có quyền truy cập tệp phương tiện này",
    en: "You are not allowed to access this media",
  },
  MEDIA_CONFIRM_FORBIDDEN: {
    vi: "Bạn không có quyền xác nhận lần tải lên này",
    en: "You are not allowed to confirm this upload",
  },
  MEDIA_CANCEL_FORBIDDEN: {
    vi: "Bạn không có quyền hủy lần tải lên này",
    en: "You are not allowed to cancel this upload",
  },
  MEDIA_SCAN_PENDING: {
    vi: "Tệp đang được quét, vui lòng thử lại sau giây lát",
    en: "This file is still being scanned, please try again shortly",
  },
  MEDIA_QUARANTINED: {
    vi: "Tệp đã bị chặn vì lý do bảo mật",
    en: "This file was blocked by a security scan",
  },
} as const satisfies MessageCatalog;

export type MediaMessageKey = keyof typeof MEDIA_MESSAGES;
