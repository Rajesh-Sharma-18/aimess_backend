import type { MessageCatalog } from "./types.js";

/**
 * Media-service domain error messages (category/ownership/object-key validation
 * and the AV scan gate). Distinct from {@link UPLOAD_MESSAGES}, which holds the
 * generic presign-time validation messages shared across services.
 */
export const MEDIA_MESSAGES = {
  MEDIA_UPLOAD_CANCELLED: {
    vi: "Đã hủy tải lên",
    en: "Upload cancelled",
    th: "ยกเลิกการอัปโหลดแล้ว",
  },
  MEDIA_REQUEST_INVALID: {
    vi: "Yêu cầu phương tiện không hợp lệ",
    en: "Invalid media request",
    th: "คำขอสื่อไม่ถูกต้อง",
  },
  MEDIA_UNKNOWN_CATEGORY: {
    vi: "Danh mục phương tiện không xác định",
    en: "Unknown media category",
    th: "ไม่รู้จักหมวดหมู่สื่อนี้",
  },
  MEDIA_INVALID_OBJECT_KEY: {
    vi: "Khóa đối tượng phương tiện không hợp lệ",
    en: "Invalid media object key",
    th: "คีย์ไฟล์สื่อไม่ถูกต้อง",
  },
  MEDIA_NOT_FOUND: {
    vi: "Không tìm thấy tệp phương tiện",
    en: "Media not found",
    th: "ไม่พบไฟล์สื่อ",
  },
  CHAT_MEDIA_FORBIDDEN: {
    vi: "Bạn không có quyền truy cập tệp phương tiện này",
    en: "You are not allowed to access this media",
    th: "คุณไม่ได้รับอนุญาตให้เข้าถึงไฟล์สื่อนี้",
  },
  MEDIA_CONFIRM_FORBIDDEN: {
    vi: "Bạn không có quyền xác nhận lần tải lên này",
    en: "You are not allowed to confirm this upload",
    th: "คุณไม่ได้รับอนุญาตให้ยืนยันการอัปโหลดนี้",
  },
  MEDIA_CANCEL_FORBIDDEN: {
    vi: "Bạn không có quyền hủy lần tải lên này",
    en: "You are not allowed to cancel this upload",
    th: "คุณไม่ได้รับอนุญาตให้ยกเลิกการอัปโหลดนี้",
  },
  MEDIA_SCAN_PENDING: {
    vi: "Tệp đang được quét, vui lòng thử lại sau giây lát",
    en: "This file is still being scanned, please try again shortly",
    th: "กำลังตรวจสอบไฟล์นี้อยู่ กรุณาลองใหม่อีกครั้งในอีกสักครู่",
  },
  MEDIA_QUARANTINED: {
    vi: "Tệp đã bị chặn vì lý do bảo mật",
    en: "This file was blocked by a security scan",
    th: "ไฟล์นี้ถูกบล็อกจากการตรวจสอบความปลอดภัย",
  },
} as const satisfies MessageCatalog;

export type MediaMessageKey = keyof typeof MEDIA_MESSAGES;
