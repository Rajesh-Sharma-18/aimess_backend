import type { MessageCatalog } from "./types.js";

/** Auth-service API messages (register, login, sessions, …). */
export const AUTH_MESSAGES = {
  AUTH_REGISTRATION_SUCCESS: {
    vi: "Đăng ký thành công",
    en: "Registration successful",
  },
  AUTH_EMAIL_EXISTS: {
    vi: "Email này đã được sử dụng",
    en: "An account with this email already exists",
  },
  AUTH_ACCOUNT_TAKEN: {
    vi: "Tên tài khoản này đã được sử dụng",
    en: "This account name is already taken",
  },
  AUTH_ACCOUNT_VALIDATED: {
    vi: "Đã kiểm tra tên tài khoản",
    en: "Account name availability checked",
  },
  INVALID_ACCOUNT_FORMAT: {
    vi: "Tên tài khoản không hợp lệ",
    en: "Invalid account name format",
  },
  AUTH_LOGIN_SUCCESS: {
    vi: "Đăng nhập thành công",
    en: "Login successful",
  },
  AUTH_INVALID_CREDENTIALS: {
    vi: "Tài khoản hoặc mật khẩu không đúng",
    en: "Invalid account or password",
  },
  AUTH_ACCOUNT_LOCKED: {
    vi: "Tài khoản đã bị khóa tạm thời. Vui lòng thử lại sau",
    en: "Account is temporarily locked. Please try again later",
  },
  AUTH_ACCOUNT_NOT_ACTIVE: {
    vi: "Tài khoản không khả dụng",
    en: "Account is not available",
  },
  AUTH_PASSWORD_NOT_SET: {
    vi: "Tài khoản này không hỗ trợ đăng nhập bằng mật khẩu",
    en: "This account does not support password login",
  },
  AUTH_UNAUTHORIZED: {
    vi: "Yêu cầu xác thực",
    en: "Authentication required",
  },
  AUTH_INVALID_TOKEN: {
    vi: "Token không hợp lệ",
    en: "Invalid access token",
  },
  AUTH_TOKEN_EXPIRED: {
    vi: "Token đã hết hạn, vui lòng đăng nhập lại",
    en: "Access token has expired, please sign in again",
  },
  AUTH_REFRESH_SUCCESS: {
    vi: "Làm mới phiên đăng nhập thành công",
    en: "Session refreshed successfully",
  },
  AUTH_REFRESH_TOKEN_INVALID: {
    vi: "Phiên đăng nhập không hợp lệ, vui lòng đăng nhập lại",
    en: "Invalid refresh token, please sign in again",
  },
  AUTH_REFRESH_TOKEN_EXPIRED: {
    vi: "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại",
    en: "Refresh token has expired, please sign in again",
  },
  AUTH_LOGOUT_SUCCESS: {
    vi: "Đăng xuất thành công",
    en: "Signed out successfully",
  },
  AUTH_SESSIONS_LISTED: {
    vi: "Lấy danh sách thiết bị đăng nhập thành công",
    en: "Active sessions listed successfully",
  },
  AUTH_SESSION_REVOKED: {
    vi: "Đã đăng xuất thiết bị",
    en: "Device signed out successfully",
  },
  AUTH_SESSION_ENDED: {
    vi: "Phiên đăng nhập đã kết thúc, vui lòng đăng nhập lại",
    en: "This session has ended, please sign in again",
  },
  AUTH_SESSION_NOT_FOUND: {
    vi: "Phiên đăng nhập không tồn tại hoặc đã kết thúc",
    en: "Session not found or already ended",
  },
  AUTH_SESSIONS_ALL_REVOKED: {
    vi: "Đã đăng xuất trên tất cả thiết bị",
    en: "Signed out on all devices",
  },
  AUTH_PASSWORD_RESET_OTP_SENT: {
    vi: "Nếu email tồn tại, mã OTP đã được gửi",
    en: "If the email exists, an OTP has been sent",
  },
  AUTH_PASSWORD_RESET_OTP_VERIFIED: {
    vi: "Xác minh OTP thành công",
    en: "OTP verified successfully",
  },
  AUTH_PASSWORD_RESET_SUCCESS: {
    vi: "Đặt lại mật khẩu thành công",
    en: "Password reset successfully",
  },
  AUTH_PASSWORD_SAME_AS_CURRENT: {
    vi: "Mật khẩu mới phải khác mật khẩu hiện tại",
    en: "New password must be different from your current password",
  },
  AUTH_OTP_INVALID: {
    vi: "Mã OTP không hợp lệ hoặc đã hết hạn",
    en: "Invalid or expired OTP",
  },
  AUTH_OTP_MAX_ATTEMPTS: {
    vi: "Đã vượt quá số lần nhập OTP, vui lòng yêu cầu mã mới",
    en: "Too many OTP attempts, please request a new code",
  },
  AUTH_RESET_TOKEN_INVALID: {
    vi: "Liên kết đặt lại mật khẩu không hợp lệ",
    en: "Invalid password reset token",
  },
  AUTH_RESET_TOKEN_EXPIRED: {
    vi: "Liên kết đặt lại mật khẩu đã hết hạn",
    en: "Password reset token has expired",
  },
  AUTH_SOCIAL_LOGIN_SUCCESS: {
    vi: "Đăng nhập thành công",
    en: "Signed in successfully",
  },
  AUTH_SOCIAL_TOKEN_INVALID: {
    vi: "Token đăng nhập mạng xã hội không hợp lệ",
    en: "Invalid social sign-in token",
  },
  AUTH_SOCIAL_EMAIL_REQUIRED: {
    vi: "Cần email để tạo tài khoản lần đầu với Apple",
    en: "Email is required for first-time Apple sign-in",
  },
  AUTH_LINK_EMAIL_OTP_SENT: {
    vi: "Mã OTP đã được gửi tới email của bạn",
    en: "An OTP has been sent to your email",
  },
  AUTH_LINK_EMAIL_SUCCESS: {
    vi: "Email đã được xác minh và liên kết",
    en: "Email verified and linked successfully",
  },
  AUTH_EMAIL_ALREADY_LINKED: {
    vi: "Email này đã được liên kết và xác minh trên tài khoản của bạn",
    en: "This email is already linked and verified on your account",
  },
  AUTH_EMAIL_ALREADY_ON_ACCOUNT: {
    vi: "Email này đã có trên tài khoản của bạn. Mã xác minh mới đã được gửi",
    en: "This email is already on your account. A new verification code has been sent",
  },
  AUTH_EMAIL_NOT_SET: {
    vi: "Tài khoản chưa có email để thay đổi",
    en: "No email is set on this account to change",
  },
  AUTH_OLD_EMAIL_MISMATCH: {
    vi: "Email hiện tại không khớp",
    en: "Current email does not match",
  },
  AUTH_NEW_EMAIL_SAME_AS_OLD: {
    vi: "Email mới phải khác email hiện tại",
    en: "New email must be different from your current email",
  },
  AUTH_CHANGE_EMAIL_OTP_SENT: {
    vi: "Mã OTP đã được gửi tới email mới",
    en: "An OTP has been sent to your new email",
  },
  AUTH_CHANGE_EMAIL_SUCCESS: {
    vi: "Đổi email thành công",
    en: "Email changed successfully",
  },
  AUTH_CHANGE_PASSWORD_SUCCESS: {
    vi: "Đổi mật khẩu thành công",
    en: "Password changed successfully",
  },
  AUTH_CURRENT_PASSWORD_INVALID: {
    vi: "Mật khẩu hiện tại không đúng",
    en: "Current password is incorrect",
  },
  AUTH_SOCIAL_LINK_SUCCESS: {
    vi: "Liên kết đăng nhập mạng xã hội thành công",
    en: "Social sign-in linked successfully",
  },
  AUTH_SOCIAL_UNLINK_SUCCESS: {
    vi: "Hủy liên kết đăng nhập mạng xã hội thành công",
    en: "Social sign-in unlinked successfully",
  },
  AUTH_SOCIAL_ALREADY_LINKED: {
    vi: "Tài khoản mạng xã hội này đã được liên kết với bạn",
    en: "This social account is already linked to you",
  },
  AUTH_SOCIAL_ACCOUNT_LINKED_ELSEWHERE: {
    vi: "Tài khoản mạng xã hội này đã được liên kết với người dùng khác",
    en: "This social account is already linked to another user",
  },
  AUTH_PROVIDER_ALREADY_LINKED: {
    vi: "Bạn đã liên kết nhà cung cấp này",
    en: "You have already linked this provider",
  },
  AUTH_SOCIAL_NOT_LINKED: {
    vi: "Nhà cung cấp này chưa được liên kết",
    en: "This provider is not linked to your account",
  },
  AUTH_LAST_SIGN_IN_METHOD: {
    vi: "Không thể hủy phương thức đăng nhập cuối cùng",
    en: "Cannot remove your only sign-in method",
  },
  AUTH_ACCOUNT_FETCHED: {
    vi: "Lấy thông tin tài khoản thành công",
    en: "Account information fetched successfully",
  },
} as const satisfies MessageCatalog;

export type AuthMessageKey = keyof typeof AUTH_MESSAGES;
