import type { MessageCatalog } from "./types.js";

/** Auth-service API messages (register, login, sessions, …). */
export const AUTH_MESSAGES = {
  AUTH_REGISTRATION_SUCCESS: {
    vi: "Đăng ký thành công",
    en: "Account registered successfully.",
  },
  AUTH_EMAIL_EXISTS: {
    vi: "Email này đã được sử dụng",
    en: "An account with this email already exists.",
  },
  AUTH_ACCOUNT_TAKEN: {
    vi: "Tên tài khoản này đã được sử dụng",
    en: "This account name is already taken.",
  },
  AUTH_ACCOUNT_AVAILABLE: {
    vi: "Tên tài khoản có thể sử dụng",
    en: "This account name is available.",
  },
  AUTH_LOGIN_SUCCESS: {
    vi: "Đăng nhập thành công",
    en: "Signed in successfully.",
  },
  AUTH_INVALID_CREDENTIALS: {
    vi: "Tài khoản hoặc mật khẩu không đúng",
    en: "Invalid username or password.",
  },
  AUTH_ACCOUNT_LOCKED: {
    vi: "Tài khoản đã bị khóa tạm thời. Vui lòng thử lại sau",
    en: "Your account is temporarily locked due to too many failed attempts. Please try again later.",
  },
  AUTH_ACCOUNT_NOT_ACTIVE: {
    vi: "Tài khoản của bạn đã bị vô hiệu hóa. Vui lòng liên hệ bộ phận hỗ trợ",
    en: "Your account has been disabled. Please contact support.",
  },
  AUTH_PASSWORD_NOT_SET: {
    vi: "Tài khoản này không hỗ trợ đăng nhập bằng mật khẩu",
    en: "This account does not support password login.",
  },
  AUTH_UNAUTHORIZED: {
    vi: "Yêu cầu xác thực",
    en: "Authentication required.",
  },
  AUTH_INVALID_TOKEN: {
    vi: "Token không hợp lệ",
    en: "Invalid access token.",
  },
  AUTH_TOKEN_EXPIRED: {
    vi: "Token đã hết hạn, vui lòng đăng nhập lại",
    en: "Your session has expired. Please sign in again.",
  },
  AUTH_REFRESH_SUCCESS: {
    vi: "Làm mới phiên đăng nhập thành công",
    en: "Session refreshed successfully.",
  },
  AUTH_ACCESS_TOKEN_ISSUED: {
    vi: "Cấp access token mới thành công",
    en: "Access token issued successfully.",
  },
  AUTH_REFRESH_TOKEN_INVALID: {
    vi: "Phiên đăng nhập không hợp lệ, vui lòng đăng nhập lại",
    en: "Your session is invalid or has been revoked. Please sign in again.",
  },
  AUTH_REFRESH_TOKEN_EXPIRED: {
    vi: "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại",
    en: "Your session has expired. Please sign in again.",
  },
  AUTH_LOGOUT_SUCCESS: {
    vi: "Đăng xuất thành công",
    en: "Signed out successfully.",
  },
  AUTH_SESSIONS_LISTED: {
    vi: "Lấy danh sách thiết bị đăng nhập thành công",
    en: "Active sessions retrieved successfully.",
  },
  AUTH_SESSION_REVOKED: {
    vi: "Đã đăng xuất thiết bị",
    en: "Device signed out successfully.",
  },
  AUTH_SESSION_ENDED: {
    vi: "Phiên đăng nhập đã kết thúc, vui lòng đăng nhập lại",
    en: "This session has ended. Please sign in again.",
  },
  AUTH_SESSION_NOT_FOUND: {
    vi: "Phiên đăng nhập không tồn tại hoặc đã kết thúc",
    en: "Session not found or already ended.",
  },
  AUTH_SESSIONS_ALL_REVOKED: {
    vi: "Đã đăng xuất trên tất cả thiết bị",
    en: "Signed out from all devices.",
  },
  AUTH_PASSWORD_RESET_OTP_SENT: {
    vi: "Mã xác minh đã được gửi tới email của bạn",
    en: "A verification code has been sent to your email.",
  },
  AUTH_PASSWORD_RESET_EMAIL_NOT_FOUND: {
    vi: "Nếu email này tồn tại, bạn sẽ nhận được mã đặt lại mật khẩu",
    en: "If this email is registered, you will receive a password reset code.",
  },
  AUTH_PASSWORD_RESET_OTP_VERIFIED: {
    vi: "Xác minh mã thành công",
    en: "Verification code confirmed. You may now reset your password.",
  },
  AUTH_PASSWORD_RESET_SUCCESS: {
    vi: "Đặt lại mật khẩu thành công",
    en: "Password reset successfully.",
  },
  AUTH_PASSWORD_SAME_AS_CURRENT: {
    vi: "Mật khẩu mới phải khác mật khẩu hiện tại",
    en: "New password must be different from your current password.",
  },
  AUTH_OTP_INVALID: {
    vi: "Mã xác minh không hợp lệ hoặc đã hết hạn",
    en: "Invalid or expired verification code.",
  },
  AUTH_OTP_MAX_ATTEMPTS: {
    vi: "Đã vượt quá số lần nhập mã, vui lòng yêu cầu mã mới",
    en: "Too many failed attempts. Please request a new verification code.",
  },
  AUTH_OTP_REQUEST_THROTTLED: {
    vi: "Bạn đã yêu cầu mã xác minh quá nhiều lần, vui lòng thử lại sau",
    en: "Too many verification code requests. Please try again later.",
  },
  AUTH_RESET_TOKEN_INVALID: {
    vi: "Liên kết đặt lại mật khẩu không hợp lệ hoặc đã được sử dụng",
    en: "This password reset link is invalid or has already been used.",
  },
  AUTH_RESET_TOKEN_EXPIRED: {
    vi: "Liên kết đặt lại mật khẩu đã hết hạn. Vui lòng yêu cầu liên kết mới",
    en: "This password reset link has expired. Please request a new one.",
  },
  AUTH_SOCIAL_LOGIN_SUCCESS: {
    vi: "Đăng nhập thành công",
    en: "Signed in successfully.",
  },
  AUTH_SOCIAL_TOKEN_INVALID: {
    vi: "Token đăng nhập mạng xã hội không hợp lệ",
    en: "Invalid social sign-in token.",
  },
  AUTH_SOCIAL_EMAIL_REQUIRED: {
    vi: "Cần email để tạo tài khoản lần đầu với Apple",
    en: "Email is required for first-time Apple sign-in.",
  },
  AUTH_LINK_EMAIL_OTP_SENT: {
    vi: "Mã xác minh đã được gửi tới email của bạn",
    en: "A verification code has been sent to your email.",
  },
  AUTH_LINK_EMAIL_SUCCESS: {
    vi: "Email đã được xác minh và liên kết",
    en: "Email verified and linked successfully.",
  },
  AUTH_EMAIL_ALREADY_LINKED: {
    vi: "Email này đã được liên kết và xác minh trên tài khoản của bạn",
    en: "This email is already linked and verified on your account.",
  },
  AUTH_EMAIL_ALREADY_ON_ACCOUNT: {
    vi: "Email này đã có trên tài khoản của bạn. Mã xác minh mới đã được gửi",
    en: "This email is already on your account. A new verification code has been sent.",
  },
  AUTH_EMAIL_NOT_SET: {
    vi: "Tài khoản của bạn chưa có địa chỉ email",
    en: "Your account does not have an email address set.",
  },
  AUTH_OLD_EMAIL_MISMATCH: {
    vi: "Địa chỉ email cung cấp không khớp với email hiện tại của bạn",
    en: "The email address provided does not match your current email.",
  },
  AUTH_NEW_EMAIL_SAME_AS_OLD: {
    vi: "Email mới phải khác email hiện tại",
    en: "New email address must be different from your current email.",
  },
  AUTH_CHANGE_EMAIL_OTP_SENT: {
    vi: "Mã xác minh đã được gửi tới địa chỉ email mới của bạn",
    en: "A verification code has been sent to your new email address.",
  },
  AUTH_CHANGE_EMAIL_SUCCESS: {
    vi: "Đổi email thành công",
    en: "Email address changed successfully.",
  },
  AUTH_CHANGE_PASSWORD_SUCCESS: {
    vi: "Đổi mật khẩu thành công",
    en: "Password changed successfully.",
  },
  AUTH_CURRENT_PASSWORD_INVALID: {
    vi: "Mật khẩu hiện tại không đúng",
    en: "Current password is incorrect.",
  },
  AUTH_SOCIAL_LINK_SUCCESS: {
    vi: "Liên kết đăng nhập mạng xã hội thành công",
    en: "Social sign-in linked successfully.",
  },
  AUTH_SOCIAL_UNLINK_SUCCESS: {
    vi: "Hủy liên kết đăng nhập mạng xã hội thành công",
    en: "Social sign-in unlinked successfully.",
  },
  AUTH_SOCIAL_ALREADY_LINKED: {
    vi: "Tài khoản mạng xã hội này đã được liên kết với bạn",
    en: "This social account is already linked to your account.",
  },
  AUTH_SOCIAL_ACCOUNT_LINKED_ELSEWHERE: {
    vi: "Tài khoản mạng xã hội này đã được liên kết với tài khoản khác",
    en: "This social account is already linked to another account.",
  },
  AUTH_PROVIDER_ALREADY_LINKED: {
    vi: "Bạn đã liên kết nhà cung cấp này",
    en: "You have already linked this sign-in provider.",
  },
  AUTH_SOCIAL_NOT_LINKED: {
    vi: "Nhà cung cấp này chưa được liên kết",
    en: "This sign-in provider is not linked to your account.",
  },
  AUTH_LAST_SIGN_IN_METHOD: {
    vi: "Không thể hủy phương thức đăng nhập cuối cùng",
    en: "Cannot remove your only sign-in method.",
  },
  AUTH_ACCOUNT_FETCHED: {
    vi: "Lấy thông tin tài khoản thành công",
    en: "Account information retrieved successfully.",
  },
  AUTH_DEVICE_LINK_INITIATED: {
    vi: "Đã tạo phiên liên kết thiết bị. Vui lòng phê duyệt trên thiết bị hiện có của bạn",
    en: "Device linking initiated. Please approve on your existing device.",
  },
  AUTH_DEVICE_LINK_STATUS: {
    vi: "Lấy trạng thái liên kết thiết bị thành công",
    en: "Device link status retrieved.",
  },
  AUTH_DEVICE_LINK_APPROVED: {
    vi: "Đã phê duyệt liên kết thiết bị",
    en: "Device linked successfully.",
  },
  AUTH_DEVICE_LINK_NOT_FOUND: {
    vi: "Phiên liên kết thiết bị không tồn tại hoặc đã hết hạn",
    en: "Device link session not found or has expired.",
  },
  AUTH_DEVICE_LINK_ALREADY_APPROVED: {
    vi: "Phiên liên kết thiết bị này đã được phê duyệt",
    en: "This device link session has already been approved.",
  },
  AUTH_ACCOUNT_DELETE_OTP_SENT: {
    vi: "Mã xác minh xóa tài khoản đã được gửi tới email của bạn",
    en: "A verification code to confirm account deletion has been sent to your email.",
  },
  AUTH_ACCOUNT_DELETED: {
    vi: "Tài khoản đã được xóa",
    en: "Your account has been deleted successfully.",
  },
  AUTH_DELETE_CONFIRMATION_REQUIRED: {
    vi: "Vui lòng nhập mật khẩu hiện tại để xác nhận xóa tài khoản",
    en: "Your current password is required to confirm account deletion.",
  },
  AUTH_PASSWORD_REQUIRED: {
    vi: "Vui lòng nhập mật khẩu để xác nhận hành động này",
    en: "Password is required to confirm this action.",
  },
  AUTH_PASSWORD_INCORRECT: {
    vi: "Mật khẩu nhập vào không chính xác",
    en: "The password you entered is incorrect.",
  },
} as const satisfies MessageCatalog;

export type AuthMessageKey = keyof typeof AUTH_MESSAGES;
