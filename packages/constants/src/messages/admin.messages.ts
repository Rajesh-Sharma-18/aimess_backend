import type { MessageCatalog } from "./types.js";

/**
 * Backoffice (admin panel) API messages — login/OTP/password-reset flows, user
 * & community & livestream & report moderation, and the RBAC/route guards.
 *
 * Backoffice-specific keys live here for clear ownership. The generic auth keys
 * (`AUTH_INVALID_CREDENTIALS`, `AUTH_UNAUTHORIZED`, `AUTH_INVALID_TOKEN`,
 * `AUTH_TOKEN_EXPIRED`) and `COMMUNITY_NOT_FOUND` are reused from their existing
 * domains — do not redefine them here.
 */
export const ADMIN_MESSAGES = {
  // ── Success ──────────────────────────────────────────────────────────────
  ADMIN_LOGIN_SUCCESS: {
    vi: "Đăng nhập thành công",
    en: "Login successful",
  },
  ADMIN_TOKEN_REFRESHED: {
    vi: "Làm mới phiên đăng nhập thành công",
    en: "Token refreshed",
  },
  ADMIN_LOGOUT_SUCCESS: {
    vi: "Đăng xuất thành công",
    en: "Logged out successfully",
  },
  ADMIN_OTP_SENT: {
    vi: "Mã OTP đã được gửi đến email của bạn",
    en: "OTP sent successfully to your email",
  },
  ADMIN_OTP_VERIFIED: {
    vi: "Xác thực OTP thành công",
    en: "OTP verified",
  },
  ADMIN_PASSWORD_RESET_SUCCESS: {
    vi: "Cập nhật mật khẩu thành công",
    en: "Password updated successfully",
  },

  // ── Auth / RBAC / routing guards ──────────────────────────────────────────
  ADMIN_ACCOUNT_NOT_ACTIVE: {
    vi: "Tài khoản quản trị không hoạt động",
    en: "Admin account is not active",
  },
  ADMIN_FORBIDDEN: {
    vi: "Bạn không có quyền thực hiện thao tác này",
    en: "Insufficient permissions",
  },
  ROUTE_NOT_FOUND: {
    vi: "Không tìm thấy",
    en: "Not found",
  },

  // ── Password-reset / OTP flow ──────────────────────────────────────────────
  OTP_INVALID: {
    vi: "Mã OTP không hợp lệ hoặc đã hết hạn",
    en: "Invalid or expired OTP code",
  },
  OTP_MAX_ATTEMPTS: {
    vi: "Bạn đã nhập sai quá nhiều lần. Vui lòng yêu cầu mã mới",
    en: "Too many incorrect attempts. Please request a new code",
  },
  RESET_TOKEN_INVALID: {
    vi: "Mã đặt lại mật khẩu không hợp lệ hoặc đã được sử dụng",
    en: "Invalid or used reset token",
  },
  RESET_TOKEN_EXPIRED: {
    vi: "Mã đặt lại mật khẩu đã hết hạn",
    en: "Reset token has expired",
  },
  PASSWORD_SAME_AS_CURRENT: {
    vi: "Mật khẩu mới phải khác mật khẩu hiện tại",
    en: "New password must be different from the current one",
  },

  // ── User moderation ─────────────────────────────────────────────────────────
  USER_NOT_FOUND: {
    vi: "Không tìm thấy người dùng",
    en: "User not found",
  },
  USER_DELETED: {
    vi: "Tài khoản người dùng này đã bị xóa",
    en: "This user account has been deleted",
  },
  USER_ALREADY_BANNED: {
    vi: "Người dùng này đã bị cấm",
    en: "This user is already banned",
  },
  USER_NOT_BANNED: {
    vi: "Người dùng này chưa bị cấm",
    en: "This user is not banned",
  },

  // ── Report moderation ───────────────────────────────────────────────────────
  REPORT_NOT_FOUND: {
    vi: "Không tìm thấy báo cáo",
    en: "Report not found",
  },
  REPORT_ALREADY_RESOLVED: {
    vi: "Báo cáo này đã được xử lý",
    en: "This report has already been resolved",
  },

  // ── Community moderation ──────────────────────────────────────────────────────
  COMMUNITY_ALREADY_CLOSED: {
    vi: "Cộng đồng đã được đóng",
    en: "Community is already closed",
  },
  COMMUNITY_NOT_CLOSED: {
    vi: "Cộng đồng chưa được đóng",
    en: "Community is not closed",
  },

  // ── Livestream moderation ─────────────────────────────────────────────────────
  LIVESTREAM_NOT_FOUND: {
    vi: "Không tìm thấy buổi phát trực tiếp",
    en: "Livestream not found",
  },
  LIVESTREAM_ALREADY_ENDED: {
    vi: "Buổi phát trực tiếp này đã kết thúc",
    en: "This livestream has already ended",
  },
  LIVESTREAM_REPORT_NOT_FOUND: {
    vi: "Không tìm thấy báo cáo phát trực tiếp",
    en: "Livestream report not found",
  },
} as const satisfies MessageCatalog;

export type AdminMessageKey = keyof typeof ADMIN_MESSAGES;
