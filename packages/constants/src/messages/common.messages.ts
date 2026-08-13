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
  /**
   * Generic HTTP 429. `admin-otp-throttle.ts` and every limiter that has no
   * more specific copy already throw the literal key "RATE_LIMITED"; without
   * this entry `t()` echoes the identifier back and the user is shown
   * "RATE_LIMITED" verbatim.
   */
  RATE_LIMITED: {
    vi: "Bạn đang thao tác hơi nhanh. Vui lòng đợi một chút rồi thử lại.",
    en: "You're doing that a little too quickly. Please wait a moment and try again.",
    th: "คุณดำเนินการเร็วเกินไปเล็กน้อย กรุณารอสักครู่แล้วลองใหม่",
  },
  /** HTTP 503 — a downstream service is unreachable or its circuit breaker is open. */
  SERVICE_UNAVAILABLE: {
    vi: "Dịch vụ tạm thời gián đoạn. Vui lòng thử lại sau giây lát.",
    en: "A temporary service issue occurred. Please try again shortly.",
    th: "เกิดปัญหาบริการชั่วคราว กรุณาลองใหม่ในอีกสักครู่",
  },
  /** HTTP 504 / client-side abort — the request outlived its deadline. */
  REQUEST_TIMEOUT: {
    vi: "Yêu cầu đang mất nhiều thời gian hơn dự kiến. Vui lòng thử lại.",
    en: "The request is taking longer than expected. Please try again.",
    th: "คำขอใช้เวลานานกว่าที่คาดไว้ กรุณาลองใหม่อีกครั้ง",
  },
  APP_VERSION_CHECKED: {
    vi: "Đã kiểm tra phiên bản ứng dụng",
    en: "App version checked",
    th: "ตรวจสอบเวอร์ชันแอปแล้ว",
  },
} as const satisfies MessageCatalog;

export type CommonMessageKey = keyof typeof COMMON_MESSAGES;
