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

  // ── Security-verdict codes ────────────────────────────────────────────────
  // These give the frontend a machine-readable reason WITHOUT disclosing which
  // detector fired or why. A client can tell "wrong format" from "too big" from
  // "malware" from "try again later" and word its own message accordingly; it
  // cannot learn the ClamAV signature name, the compression-ratio threshold, the
  // bucket, or any internal path. The detail lives in the audit log only.

  /** Structural validation failed: malformed, polyglot, bomb, active content. */
  MEDIA_SECURITY_VALIDATION_FAILED: {
    vi: "Không thể tải tệp này lên vì không vượt qua kiểm tra bảo mật.",
    en: "This file could not be uploaded because it failed security validation.",
    th: "ไม่สามารถอัปโหลดไฟล์นี้ได้เนื่องจากไม่ผ่านการตรวจสอบความปลอดภัย",
  },
  /** An antivirus engine identified malware. Distinct from the above on purpose. */
  MEDIA_MALWARE_DETECTED: {
    vi: "Tệp này chứa mã độc và đã bị chặn.",
    en: "This file contains malware and has been blocked.",
    th: "ไฟล์นี้มีมัลแวร์และถูกบล็อกแล้ว",
  },
  /** The bytes are not a valid instance of the declared format. */
  MEDIA_INVALID_CONTENT: {
    vi: "Nội dung tệp không khớp với định dạng đã khai báo.",
    en: "The file content does not match its declared format.",
    th: "เนื้อหาไฟล์ไม่ตรงกับรูปแบบที่ระบุไว้",
  },
  /** The scan could not complete — transient, the client may retry. */
  MEDIA_SCAN_FAILED: {
    vi: "Không thể kiểm tra tệp này. Vui lòng thử tải lên lại.",
    en: "This file could not be scanned. Please try uploading it again.",
    th: "ไม่สามารถตรวจสอบไฟล์นี้ได้ กรุณาลองอัปโหลดใหม่อีกครั้ง",
  },
  /** Storage/registry is down; the request is well-formed and worth retrying. */
  MEDIA_REGISTRY_UNAVAILABLE: {
    vi: "Dịch vụ phương tiện tạm thời không khả dụng. Vui lòng thử lại.",
    en: "The media service is temporarily unavailable. Please try again.",
    th: "บริการสื่อไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่อีกครั้ง",
  },
  /** A thumbnail key was committed against a different livestream than it was minted for. */
  LIVESTREAM_THUMBNAIL_INVALID_KEY: {
    vi: "Khóa ảnh thu nhỏ không thuộc về buổi phát trực tiếp này",
    en: "This thumbnail key does not belong to this livestream",
    th: "คีย์ภาพขนาดย่อนี้ไม่ได้เป็นของไลฟ์สตรีมนี้",
  },
  /** An attachment was referenced before it passed the security pipeline. */
  MEDIA_NOT_VERIFIED: {
    vi: "Tệp đính kèm chưa được kiểm tra bảo mật xong.",
    en: "This attachment has not finished security verification.",
    th: "ไฟล์แนบนี้ยังตรวจสอบความปลอดภัยไม่เสร็จ",
  },
} as const satisfies MessageCatalog;

export type MediaMessageKey = keyof typeof MEDIA_MESSAGES;
