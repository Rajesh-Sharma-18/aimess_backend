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
    en: "Login successful.",
  },
  ADMIN_TOKEN_REFRESHED: {
    vi: "Làm mới phiên đăng nhập thành công",
    en: "Session refreshed successfully.",
  },
  ADMIN_LOGOUT_SUCCESS: {
    vi: "Đăng xuất thành công",
    en: "Signed out successfully.",
  },
  ADMIN_OTP_SENT: {
    vi: "Mã xác minh đã được gửi đến email của bạn",
    en: "A verification code has been sent to your email.",
  },
  ADMIN_OTP_VERIFIED: {
    vi: "Xác thực mã thành công",
    en: "Verification code confirmed.",
  },
  ADMIN_PASSWORD_RESET_SUCCESS: {
    vi: "Cập nhật mật khẩu thành công",
    en: "Password updated successfully.",
  },

  // ── Auth / RBAC / routing guards ──────────────────────────────────────────
  // Admin login is email-only, unlike the shared AUTH_INVALID_CREDENTIALS key
  // (used by the regular-user flow, which also accepts a username) — this key
  // gives the admin panel its own accurate wording without touching that one.
  ADMIN_INVALID_CREDENTIALS: {
    vi: "Email hoặc mật khẩu không đúng",
    en: "Invalid email or password.",
  },
  ADMIN_ACCOUNT_NOT_ACTIVE: {
    vi: "Tài khoản quản trị không hoạt động",
    en: "Your account has been disabled. Please contact the super administrator.",
  },
  ADMIN_ACCOUNT_DELETED: {
    vi: "Tài khoản quản trị này không còn tồn tại",
    en: "Your account is no longer available.",
  },
  ADMIN_FORBIDDEN: {
    vi: "Bạn không có quyền thực hiện thao tác này",
    en: "You do not have permission to perform this action.",
  },
  ROUTE_NOT_FOUND: {
    vi: "Không tìm thấy đường dẫn",
    en: "The requested route was not found.",
  },

  // ── Password-reset / OTP flow ──────────────────────────────────────────────
  OTP_INVALID: {
    vi: "Mã xác minh không hợp lệ hoặc đã hết hạn",
    en: "Invalid or expired verification code.",
  },
  OTP_MAX_ATTEMPTS: {
    vi: "Bạn đã nhập sai quá nhiều lần. Vui lòng yêu cầu mã mới",
    en: "Too many failed attempts. Please request a new verification code.",
  },
  RESET_TOKEN_INVALID: {
    vi: "Mã đặt lại mật khẩu không hợp lệ hoặc đã được sử dụng",
    en: "This password reset link is invalid or has already been used.",
  },
  RESET_TOKEN_EXPIRED: {
    vi: "Mã đặt lại mật khẩu đã hết hạn",
    en: "This password reset link has expired. Please request a new one.",
  },
  PASSWORD_SAME_AS_CURRENT: {
    vi: "Mật khẩu mới phải khác mật khẩu hiện tại",
    en: "New password must be different from the current password.",
  },

  // ── User moderation ─────────────────────────────────────────────────────────
  USER_NOT_FOUND: {
    vi: "Không tìm thấy người dùng",
    en: "User not found.",
  },
  USER_DELETED: {
    vi: "Tài khoản người dùng này đã bị xóa",
    en: "This user account has been deleted.",
  },
  USER_ALREADY_BANNED: {
    vi: "Người dùng này đã bị cấm",
    en: "This user is already banned.",
  },
  USER_NOT_BANNED: {
    vi: "Người dùng này chưa bị cấm",
    en: "This user is not currently banned.",
  },

  // ── Report moderation ───────────────────────────────────────────────────────
  REPORT_NOT_FOUND: {
    vi: "Không tìm thấy báo cáo",
    en: "Report not found.",
  },
  REPORT_ALREADY_RESOLVED: {
    vi: "Báo cáo này đã được xử lý",
    en: "This report has already been resolved.",
  },

  // ── Community moderation ──────────────────────────────────────────────────────
  COMMUNITY_ALREADY_CLOSED: {
    vi: "Cộng đồng đã được đóng",
    en: "This community is already closed.",
  },
  COMMUNITY_NOT_CLOSED: {
    vi: "Cộng đồng chưa được đóng",
    en: "This community is not closed.",
  },

  // ── Livestream moderation ─────────────────────────────────────────────────────
  LIVESTREAM_NOT_FOUND: {
    vi: "Không tìm thấy buổi phát trực tiếp",
    en: "Livestream not found.",
  },
  LIVESTREAM_ALREADY_ENDED: {
    vi: "Buổi phát trực tiếp này đã kết thúc",
    en: "This livestream has already ended.",
  },
  LIVESTREAM_REPORT_NOT_FOUND: {
    vi: "Không tìm thấy báo cáo phát trực tiếp",
    en: "Livestream report not found.",
  },

  // ── Admin Accounts ──────────────────────────────────────────────────────────
  ADMIN_NOT_FOUND: {
    vi: "Không tìm thấy quản trị viên",
    en: "Admin account not found.",
  },
  ADMIN_EMAIL_TAKEN: {
    vi: "Email này đã được sử dụng bởi một quản trị viên khác",
    en: "This email is already used by another admin.",
  },
  ADMIN_ROLE_NOT_FOUND: {
    vi: "Không tìm thấy vai trò",
    en: "Role not found.",
  },
  ADMIN_ALREADY_ACTIVE: {
    vi: "Tài khoản quản trị này đã hoạt động",
    en: "This admin account is already active.",
  },
  ADMIN_ALREADY_INACTIVE: {
    vi: "Tài khoản quản trị này đã bị vô hiệu hóa",
    en: "This admin account is already deactivated.",
  },
  ADMIN_CANNOT_DEACTIVATE_SELF: {
    vi: "Bạn không thể tự vô hiệu hóa tài khoản của mình",
    en: "You cannot deactivate your own account.",
  },
  ADMIN_USERNAME_TAKEN: {
    vi: "Tên đăng nhập này đã được sử dụng bởi một quản trị viên khác",
    en: "This username is already used by another admin.",
  },
  ADMIN_CANNOT_DEACTIVATE_LAST_SUPER_ADMIN: {
    vi: "Không thể vô hiệu hóa Super Admin cuối cùng",
    en: "Cannot deactivate the last remaining Super Admin.",
  },
} as const satisfies MessageCatalog;

export type AdminMessageKey = keyof typeof ADMIN_MESSAGES;
