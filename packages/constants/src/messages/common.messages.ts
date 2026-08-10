import type { MessageCatalog } from "./types.js";

/** Shared messages used across services. */
export const COMMON_MESSAGES = {
  VALIDATION_FAILED: {
    vi: "Dữ liệu không hợp lệ",
    en: "Validation failed",
    th: "ข้อมูลไม่ถูกต้อง",
  },
  INTERNAL_SERVER_ERROR: {
    vi: "Lỗi máy chủ nội bộ",
    en: "Internal server error",
    th: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์",
  },
  APP_VERSION_CHECKED: {
    vi: "Đã kiểm tra phiên bản ứng dụng",
    en: "App version checked",
    th: "ตรวจสอบเวอร์ชันแอปแล้ว",
  },
} as const satisfies MessageCatalog;

export type CommonMessageKey = keyof typeof COMMON_MESSAGES;
