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

  // --- Unified search (api-gateway GET /api/v1/search) -----------------------
  // The gateway threw SEARCH_UNAVAILABLE as a literal key with no catalog entry,
  // so `t()` echoed the identifier and users were shown it verbatim.
  SEARCH_FETCHED: {
    vi: "Đã tải kết quả tìm kiếm",
    en: "Search results fetched",
    th: "ดึงผลการค้นหาแล้ว",
  },
  // HTTP 400 — the pagination cursor could not be read; restart the search.
  INVALID_CURSOR: {
    vi: "Con trỏ phân trang không hợp lệ. Vui lòng tìm kiếm lại.",
    en: "The pagination cursor is not valid. Please start the search again.",
    th: "เคอร์เซอร์การแบ่งหน้าไม่ถูกต้อง กรุณาเริ่มค้นหาใหม่",
  },
  // HTTP 400 — a search backend refused the request this route built (a contract
  // mismatch, not an outage). Non-retryable on purpose: replaying cannot help.
  SEARCH_REQUEST_REJECTED: {
    vi: "Không thể thực hiện tìm kiếm này. Vui lòng thử từ khóa khác.",
    en: "This search could not be run. Please try a different term.",
    th: "ไม่สามารถดำเนินการค้นหานี้ได้ กรุณาลองคำค้นอื่น",
  },
  // HTTP 503 — every search backend failed for this request.
  SEARCH_UNAVAILABLE: {
    vi: "Không thể tìm kiếm lúc này. Vui lòng thử lại sau giây lát.",
    en: "Search is unavailable right now. Please try again shortly.",
    th: "ไม่สามารถค้นหาได้ในขณะนี้ กรุณาลองใหม่ในอีกสักครู่",
  },

  // --- Generic transport failures -------------------------------------------
  // Every service's error handler resolves these. They existed only as inline
  // English strings before, which is why a Vietnamese or Thai user got an
  // untranslated sentence for a malformed body, an oversized upload, or a
  // Prisma constraint violation.

  /** HTTP 401 — no credential, or one that has expired. */
  UNAUTHORIZED: {
    vi: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.",
    en: "Authentication token missing or expired. Please log in again.",
    th: "โทเค็นการยืนยันตัวตนหายไปหรือหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง",
  },
  /** HTTP 403 — authenticated, but not allowed to do this. */
  FORBIDDEN: {
    vi: "Bạn không có quyền thực hiện thao tác này.",
    en: "You do not have permission to perform this action.",
    th: "คุณไม่มีสิทธิ์ดำเนินการนี้",
  },
  /** HTTP 400 — the body was not parseable JSON. */
  INVALID_JSON_BODY: {
    vi: "Nội dung yêu cầu không phải JSON hợp lệ.",
    en: "Request body is not valid JSON.",
    th: "เนื้อหาคำขอไม่ใช่ JSON ที่ถูกต้อง",
  },
  /** HTTP 413 — the body exceeded the configured limit. */
  PAYLOAD_TOO_LARGE: {
    vi: "Nội dung yêu cầu quá lớn.",
    en: "Request payload is too large.",
    th: "เนื้อหาคำขอมีขนาดใหญ่เกินไป",
  },
  /** HTTP 409 — a unique constraint was violated and no domain key fits. */
  RESOURCE_CONFLICT: {
    vi: "Dữ liệu này đã tồn tại.",
    en: "This resource already exists.",
    th: "ข้อมูลนี้มีอยู่แล้ว",
  },
  /** HTTP 400 — an identifier was not a well-formed id. */
  INVALID_ID_FORMAT: {
    vi: "Định dạng mã không hợp lệ.",
    en: "Invalid ID format provided.",
    th: "รูปแบบรหัสไม่ถูกต้อง",
  },
  /** HTTP 404 — the record the request needed does not exist. */
  RESOURCE_NOT_FOUND: {
    vi: "Không tìm thấy dữ liệu yêu cầu.",
    en: "The requested resource was not found.",
    th: "ไม่พบข้อมูลที่ร้องขอ",
  },
  /** HTTP 400 — the request referenced a record that does not exist. */
  INVALID_REFERENCE: {
    vi: "Yêu cầu tham chiếu đến dữ liệu không tồn tại.",
    en: "The request references data that does not exist.",
    th: "คำขออ้างอิงถึงข้อมูลที่ไม่มีอยู่",
  },
  /** HTTP 400 — the database rejected the request and no better key applies. */
  REQUEST_FAILED: {
    vi: "Không thể xử lý yêu cầu này.",
    en: "The request could not be processed.",
    th: "ไม่สามารถดำเนินการคำขอนี้ได้",
  },
  // --- Invite recipient eligibility -----------------------------------------
  // Per-recipient outcomes shared by EVERY invite path (community direct
  // invites, community invite-link share, group invite-link share). They are
  // item-level results inside a 200 response, not thrown errors, so the
  // controller localizes them explicitly.
  /** A block exists in either direction between sender and recipient. */
  INVITE_RECIPIENT_BLOCKED: {
    vi: "Bạn không thể gửi lời mời cho người dùng đã bị chặn.",
    en: "You cannot send invitations to a blocked user.",
    th: "คุณไม่สามารถส่งคำเชิญไปยังผู้ใช้ที่ถูกบล็อกได้",
  },
  /** Recipient is admin-suspended or admin-banned — they cannot act on it. */
  INVITE_RECIPIENT_SUSPENDED: {
    vi: "Tài khoản người dùng này hiện đang bị tạm khóa.",
    en: "This user account is currently suspended.",
    th: "บัญชีผู้ใช้นี้ถูกระงับอยู่ในขณะนี้",
  },
  /** Recipient account was deleted. */
  INVITE_RECIPIENT_DELETED: {
    vi: "Tài khoản người nhận không còn tồn tại.",
    en: "Recipient account no longer exists.",
    th: "บัญชีผู้รับไม่มีอยู่แล้ว",
  },
  /** No such account (never existed, or an id from a stale client list). */
  INVITE_RECIPIENT_NOT_FOUND: {
    vi: "Không tìm thấy tài khoản người nhận.",
    en: "Recipient account could not be found.",
    th: "ไม่พบบัญชีผู้รับ",
  },
} as const satisfies MessageCatalog;

export type CommonMessageKey = keyof typeof COMMON_MESSAGES;
