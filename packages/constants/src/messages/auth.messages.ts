import type { MessageCatalog } from "./types.js";

/** Auth-service API messages (register, login, sessions, …). */
export const AUTH_MESSAGES = {
  AUTH_REGISTRATION_SUCCESS: {
    vi: "Đăng ký thành công",
    en: "Account registered successfully.",
    th: "สมัครบัญชีเรียบร้อยแล้ว",
  },
  AUTH_EMAIL_EXISTS: {
    vi: "Email này đã được sử dụng",
    en: "An account with this email already exists.",
    th: "มีบัญชีที่ใช้อีเมลนี้อยู่แล้ว",
  },
  AUTH_ACCOUNT_TAKEN: {
    vi: "Tên tài khoản này đã được sử dụng",
    en: "This account name is already taken.",
    th: "ชื่อบัญชีนี้ถูกใช้ไปแล้ว",
  },
  AUTH_ACCOUNT_AVAILABLE: {
    vi: "Tên tài khoản có thể sử dụng",
    en: "This account name is available.",
    th: "ชื่อบัญชีนี้ใช้งานได้",
  },
  AUTH_LOGIN_SUCCESS: {
    vi: "Đăng nhập thành công",
    en: "Signed in successfully.",
    th: "เข้าสู่ระบบเรียบร้อยแล้ว",
  },
  AUTH_INVALID_CREDENTIALS: {
    vi: "Tài khoản hoặc mật khẩu không đúng",
    en: "Invalid username or password.",
    th: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง",
  },
  AUTH_ACCOUNT_LOCKED: {
    vi: "Tài khoản đã bị khóa tạm thời. Vui lòng thử lại sau",
    en: "Your account is temporarily locked due to too many failed attempts. Please try again later.",
    th: "บัญชีของคุณถูกล็อกชั่วคราวเนื่องจากพยายามเข้าสู่ระบบผิดพลาดหลายครั้งเกินไป กรุณาลองใหม่ภายหลัง",
  },
  AUTH_ACCOUNT_NOT_ACTIVE: {
    vi: "Tài khoản của bạn đã bị vô hiệu hóa. Vui lòng liên hệ bộ phận hỗ trợ",
    en: "Your account has been disabled. Please contact support.",
    th: "บัญชีของคุณถูกปิดใช้งาน กรุณาติดต่อฝ่ายสนับสนุน",
  },
  // Permanent Super Admin system ban. Deliberately NOT the community-scoped
  // USER_BANNED key (community.messages.ts), which reads "You are banned from
  // this community" and would be the wrong sentence on a login screen.
  // Returned as HTTP 403 with error.code === "ACCOUNT_BANNED" by every
  // authentication surface (password, Google, Apple, refresh, forgot-password,
  // password reset, QR device link) and by the shared authenticated-route guard.
  ACCOUNT_BANNED: {
    vi: "Tài khoản của bạn đã bị Quản trị viên cấp cao cấm. Bạn không thể truy cập AIMess trừ khi lệnh cấm được gỡ bỏ",
    en: "Your account has been banned by a Super Admin. You cannot access AIMess unless the ban is removed.",
    th: "บัญชีของคุณถูกแบนโดยผู้ดูแลระบบระดับสูง คุณจะไม่สามารถเข้าใช้ AIMess ได้จนกว่าจะมีการปลดแบน",
  },
  AUTH_PASSWORD_NOT_SET: {
    vi: "Tài khoản này không hỗ trợ đăng nhập bằng mật khẩu",
    en: "This account does not support password login.",
    th: "บัญชีนี้ไม่รองรับการเข้าสู่ระบบด้วยรหัสผ่าน",
  },
  AUTH_UNAUTHORIZED: {
    vi: "Yêu cầu xác thực",
    en: "Authentication token is required.",
    th: "จำเป็นต้องมีโทเค็นการยืนยันตัวตน",
  },
  AUTH_INVALID_TOKEN: {
    vi: "Token không hợp lệ",
    en: "Invalid authentication token.",
    th: "โทเค็นการยืนยันตัวตนไม่ถูกต้อง",
  },
  AUTH_TOKEN_EXPIRED: {
    vi: "Token đã hết hạn, vui lòng đăng nhập lại",
    en: "Authentication token has expired.",
    th: "โทเค็นการยืนยันตัวตนหมดอายุแล้ว",
  },
  AUTH_REFRESH_SUCCESS: {
    vi: "Làm mới phiên đăng nhập thành công",
    en: "Session refreshed successfully.",
    th: "ต่ออายุเซสชันเรียบร้อยแล้ว",
  },
  AUTH_ACCESS_TOKEN_ISSUED: {
    vi: "Cấp access token mới thành công",
    en: "Access token issued successfully.",
    th: "ออกโทเค็นการเข้าถึงเรียบร้อยแล้ว",
  },
  AUTH_REFRESH_TOKEN_INVALID: {
    vi: "Phiên đăng nhập không hợp lệ, vui lòng đăng nhập lại",
    en: "Your session is invalid or has been revoked. Please sign in again.",
    th: "เซสชันของคุณไม่ถูกต้องหรือถูกเพิกถอนแล้ว กรุณาเข้าสู่ระบบอีกครั้ง",
  },
  AUTH_REFRESH_TOKEN_EXPIRED: {
    vi: "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại",
    en: "Your session has expired. Please sign in again.",
    th: "เซสชันของคุณหมดอายุแล้ว กรุณาเข้าสู่ระบบอีกครั้ง",
  },
  AUTH_LOGOUT_SUCCESS: {
    vi: "Đăng xuất thành công",
    en: "Signed out successfully.",
    th: "ออกจากระบบเรียบร้อยแล้ว",
  },
  AUTH_SESSIONS_LISTED: {
    vi: "Lấy danh sách thiết bị đăng nhập thành công",
    en: "Active sessions retrieved successfully.",
    th: "ดึงรายการเซสชันที่ใช้งานอยู่เรียบร้อยแล้ว",
  },
  AUTH_SESSION_REVOKED: {
    vi: "Đã đăng xuất thiết bị",
    en: "Device signed out successfully.",
    th: "ออกจากระบบบนอุปกรณ์นี้เรียบร้อยแล้ว",
  },
  AUTH_SESSION_ENDED: {
    vi: "Phiên đăng nhập đã kết thúc, vui lòng đăng nhập lại",
    en: "This session has ended. Please sign in again.",
    th: "เซสชันนี้สิ้นสุดแล้ว กรุณาเข้าสู่ระบบอีกครั้ง",
  },
  AUTH_SESSION_NOT_FOUND: {
    vi: "Phiên đăng nhập không tồn tại hoặc đã kết thúc",
    en: "Session not found or already ended.",
    th: "ไม่พบเซสชันหรือเซสชันสิ้นสุดไปแล้ว",
  },
  AUTH_SESSION_TRUSTED: {
    vi: "Đã xác nhận đăng nhập",
    en: "Login verified.",
    th: "ยืนยันการเข้าสู่ระบบแล้ว",
  },
  AUTH_SESSIONS_ALL_REVOKED: {
    vi: "Đã đăng xuất trên tất cả thiết bị",
    en: "Signed out from all devices.",
    th: "ออกจากระบบทุกอุปกรณ์แล้ว",
  },
  AUTH_PASSWORD_RESET_OTP_SENT: {
    vi: "Mã xác minh đã được gửi tới email của bạn",
    en: "A verification code has been sent to your email.",
    th: "ส่งรหัสยืนยันไปยังอีเมลของคุณแล้ว",
  },
  AUTH_PASSWORD_RESET_EMAIL_NOT_FOUND: {
    vi: "Nếu email này tồn tại, bạn sẽ nhận được mã đặt lại mật khẩu",
    en: "If this email is registered, you will receive a password reset code.",
    th: "หากอีเมลนี้ลงทะเบียนไว้ คุณจะได้รับรหัสสำหรับรีเซ็ตรหัสผ่าน",
  },
  AUTH_PASSWORD_RESET_OTP_VERIFIED: {
    vi: "Xác minh mã thành công",
    en: "Verification code confirmed. You may now reset your password.",
    th: "ยืนยันรหัสเรียบร้อยแล้ว คุณสามารถตั้งรหัสผ่านใหม่ได้",
  },
  AUTH_PASSWORD_RESET_SUCCESS: {
    vi: "Đặt lại mật khẩu thành công",
    en: "Password reset successfully.",
    th: "รีเซ็ตรหัสผ่านเรียบร้อยแล้ว",
  },
  AUTH_PASSWORD_SAME_AS_CURRENT: {
    vi: "Mật khẩu mới phải khác mật khẩu hiện tại",
    en: "New password must be different from your current password.",
    th: "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบันของคุณ",
  },
  // Signup proof-of-work. Registration and the handle-availability check were
  // both free to call, so creating accounts and enumerating handles cost only
  // HTTP requests. Solving a challenge costs the caller CPU, once per attempt.
  AUTH_CHALLENGE_ISSUED: {
    vi: "Đã tạo mã xác minh",
    en: "Verification challenge issued.",
    th: "ออกคำท้าการยืนยันแล้ว",
  },
  AUTH_CHALLENGE_REQUIRED: {
    vi: "Vui lòng thử lại từ ứng dụng",
    en: "Please retry from the app.",
    th: "กรุณาลองใหม่จากแอป",
  },
  AUTH_CHALLENGE_INVALID: {
    vi: "Xác minh không hợp lệ. Vui lòng thử lại",
    en: "Verification failed. Please try again.",
    th: "การยืนยันไม่ถูกต้อง กรุณาลองใหม่",
  },
  AUTH_CHALLENGE_ALREADY_USED: {
    vi: "Xác minh đã được sử dụng. Vui lòng thử lại",
    en: "That verification was already used. Please try again.",
    th: "การยืนยันนี้ถูกใช้ไปแล้ว กรุณาลองใหม่",
  },
  // Creation-policy failures. Applied when a password is SET (register, reset,
  // change) and never at login, so accounts created under the older rule keep
  // signing in and are asked for something stronger only when they next change
  // it. Each is a distinct key so the client can say what to fix.
  AUTH_PASSWORD_TOO_SHORT: {
    vi: "Mật khẩu phải có ít nhất 8 ký tự",
    en: "Password must be at least 8 characters.",
    th: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร",
  },
  AUTH_PASSWORD_TOO_LONG: {
    vi: "Mật khẩu quá dài (tối đa 50 ký tự)",
    en: "Password is too long (maximum 50 characters).",
    th: "รหัสผ่านยาวเกินไป (สูงสุด 50 ตัวอักษร)",
  },
  AUTH_PASSWORD_CONTAINS_SPACE: {
    vi: "Mật khẩu không được chứa khoảng trắng",
    en: "Password must not contain spaces.",
    th: "รหัสผ่านต้องไม่มีช่องว่าง",
  },
  AUTH_PASSWORD_NEEDS_UPPERCASE: {
    vi: "Mật khẩu phải có ít nhất một chữ cái in hoa",
    en: "Password must contain at least one uppercase letter.",
    th: "รหัสผ่านต้องมีอักษรพิมพ์ใหญ่อย่างน้อยหนึ่งตัว",
  },
  AUTH_PASSWORD_NEEDS_LOWERCASE: {
    vi: "Mật khẩu phải có ít nhất một chữ cái thường",
    en: "Password must contain at least one lowercase letter.",
    th: "รหัสผ่านต้องมีอักษรพิมพ์เล็กอย่างน้อยหนึ่งตัว",
  },
  AUTH_PASSWORD_NEEDS_NUMBER: {
    vi: "Mật khẩu phải có ít nhất một chữ số",
    en: "Password must contain at least one number.",
    th: "รหัสผ่านต้องมีตัวเลขอย่างน้อยหนึ่งตัว",
  },
  AUTH_PASSWORD_NEEDS_SYMBOL: {
    vi: "Mật khẩu phải có ít nhất một ký tự đặc biệt",
    en: "Password must contain at least one special character.",
    th: "รหัสผ่านต้องมีอักขระพิเศษอย่างน้อยหนึ่งตัว",
  },
  AUTH_PASSWORD_TOO_COMMON: {
    vi: "Mật khẩu này quá phổ biến. Vui lòng chọn mật khẩu khác",
    en: "This password is too common. Please choose a different one.",
    th: "รหัสผ่านนี้ใช้กันทั่วไปเกินไป กรุณาเลือกรหัสผ่านอื่น",
  },
  AUTH_PASSWORD_CONTAINS_IDENTIFIER: {
    vi: "Mật khẩu không được chứa tên tài khoản hoặc email của bạn",
    en: "Password must not contain your account name or email.",
    th: "รหัสผ่านต้องไม่มีชื่อบัญชีหรืออีเมลของคุณ",
  },
  AUTH_OTP_INVALID: {
    vi: "Mã xác minh không hợp lệ hoặc đã hết hạn",
    en: "Invalid or expired verification code.",
    th: "รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว",
  },
  AUTH_OTP_MAX_ATTEMPTS: {
    vi: "Đã vượt quá số lần nhập mã, vui lòng yêu cầu mã mới",
    en: "Too many failed attempts. Please request a new verification code.",
    th: "พยายามผิดพลาดหลายครั้งเกินไป กรุณาขอรหัสยืนยันใหม่",
  },
  AUTH_OTP_REQUEST_THROTTLED: {
    vi: "Bạn đã yêu cầu mã xác minh quá nhiều lần, vui lòng thử lại sau",
    en: "Too many verification code requests. Please try again later.",
    th: "ขอรหัสยืนยันบ่อยเกินไป กรุณาลองใหม่ภายหลัง",
  },
  AUTH_RESET_TOKEN_INVALID: {
    vi: "Liên kết đặt lại mật khẩu không hợp lệ hoặc đã được sử dụng",
    en: "This password reset link is invalid or has already been used.",
    th: "ลิงก์รีเซ็ตรหัสผ่านนี้ไม่ถูกต้องหรือถูกใช้ไปแล้ว",
  },
  AUTH_RESET_TOKEN_EXPIRED: {
    vi: "Liên kết đặt lại mật khẩu đã hết hạn. Vui lòng yêu cầu liên kết mới",
    en: "This password reset link has expired. Please request a new one.",
    th: "ลิงก์รีเซ็ตรหัสผ่านนี้หมดอายุแล้ว กรุณาขอลิงก์ใหม่",
  },
  AUTH_SOCIAL_LOGIN_SUCCESS: {
    vi: "Đăng nhập thành công",
    en: "Signed in successfully.",
    th: "เข้าสู่ระบบเรียบร้อยแล้ว",
  },
  AUTH_SOCIAL_TOKEN_INVALID: {
    vi: "Token đăng nhập mạng xã hội không hợp lệ",
    en: "Invalid social sign-in token.",
    th: "โทเค็นการเข้าสู่ระบบผ่านโซเชียลไม่ถูกต้อง",
  },
  AUTH_SOCIAL_EMAIL_REQUIRED: {
    vi: "Cần email để tạo tài khoản lần đầu với Apple",
    en: "Email is required for first-time Apple sign-in.",
    th: "จำเป็นต้องระบุอีเมลสำหรับการเข้าสู่ระบบด้วย Apple ครั้งแรก",
  },
  AUTH_LINK_EMAIL_OTP_SENT: {
    vi: "Mã xác minh đã được gửi tới email của bạn",
    en: "A verification code has been sent to your email.",
    th: "ส่งรหัสยืนยันไปยังอีเมลของคุณแล้ว",
  },
  AUTH_LINK_EMAIL_SUCCESS: {
    vi: "Email đã được xác minh và liên kết",
    en: "Email verified and linked successfully.",
    th: "ยืนยันและเชื่อมอีเมลเรียบร้อยแล้ว",
  },
  AUTH_EMAIL_ALREADY_LINKED: {
    vi: "Email này đã được liên kết và xác minh trên tài khoản của bạn",
    en: "This email is already linked and verified on your account.",
    th: "อีเมลนี้ถูกเชื่อมและยืนยันกับบัญชีของคุณแล้ว",
  },
  AUTH_EMAIL_ALREADY_ON_ACCOUNT: {
    vi: "Email này đã có trên tài khoản của bạn. Mã xác minh mới đã được gửi",
    en: "This email is already on your account. A new verification code has been sent.",
    th: "อีเมลนี้อยู่ในบัญชีของคุณแล้ว ระบบได้ส่งรหัสยืนยันใหม่ให้แล้ว",
  },
  AUTH_EMAIL_NOT_SET: {
    vi: "Tài khoản của bạn chưa có địa chỉ email",
    en: "Your account does not have an email address set.",
    th: "บัญชีของคุณยังไม่ได้ตั้งค่าอีเมล",
  },
  AUTH_OLD_EMAIL_MISMATCH: {
    vi: "Địa chỉ email cung cấp không khớp với email hiện tại của bạn",
    en: "The email address provided does not match your current email.",
    th: "อีเมลที่ระบุไม่ตรงกับอีเมลปัจจุบันของคุณ",
  },
  AUTH_NEW_EMAIL_SAME_AS_OLD: {
    vi: "Email mới phải khác email hiện tại",
    en: "New email address must be different from your current email.",
    th: "อีเมลใหม่ต้องไม่ซ้ำกับอีเมลปัจจุบันของคุณ",
  },
  AUTH_CHANGE_EMAIL_OTP_SENT: {
    vi: "Mã xác minh đã được gửi tới địa chỉ email mới của bạn",
    en: "A verification code has been sent to your new email address.",
    th: "ส่งรหัสยืนยันไปยังอีเมลใหม่ของคุณแล้ว",
  },
  AUTH_CHANGE_EMAIL_SUCCESS: {
    vi: "Đổi email thành công",
    en: "Email address changed successfully.",
    th: "เปลี่ยนอีเมลเรียบร้อยแล้ว",
  },
  AUTH_CHANGE_PASSWORD_SUCCESS: {
    vi: "Đổi mật khẩu thành công",
    en: "Password changed successfully.",
    th: "เปลี่ยนรหัสผ่านเรียบร้อยแล้ว",
  },
  AUTH_CURRENT_PASSWORD_INVALID: {
    vi: "Mật khẩu hiện tại không đúng",
    en: "Current password is incorrect.",
    th: "รหัสผ่านปัจจุบันไม่ถูกต้อง",
  },
  AUTH_SOCIAL_LINK_SUCCESS: {
    vi: "Liên kết đăng nhập mạng xã hội thành công",
    en: "Social sign-in linked successfully.",
    th: "เชื่อมการเข้าสู่ระบบผ่านโซเชียลเรียบร้อยแล้ว",
  },
  AUTH_SOCIAL_UNLINK_SUCCESS: {
    vi: "Hủy liên kết đăng nhập mạng xã hội thành công",
    en: "Social sign-in unlinked successfully.",
    th: "ยกเลิกการเชื่อมการเข้าสู่ระบบผ่านโซเชียลเรียบร้อยแล้ว",
  },
  AUTH_SOCIAL_ALREADY_LINKED: {
    vi: "Tài khoản mạng xã hội này đã được liên kết với bạn",
    en: "This social account is already linked to your account.",
    th: "บัญชีโซเชียลนี้เชื่อมกับบัญชีของคุณอยู่แล้ว",
  },
  AUTH_SOCIAL_ACCOUNT_LINKED_ELSEWHERE: {
    vi: "Tài khoản mạng xã hội này đã được liên kết với tài khoản khác",
    en: "This social account is already linked to another account.",
    th: "บัญชีโซเชียลนี้เชื่อมกับบัญชีอื่นอยู่แล้ว",
  },
  AUTH_PROVIDER_ALREADY_LINKED: {
    vi: "Bạn đã liên kết nhà cung cấp này",
    en: "You have already linked this sign-in provider.",
    th: "คุณเชื่อมผู้ให้บริการเข้าสู่ระบบนี้ไว้แล้ว",
  },
  AUTH_SOCIAL_NOT_LINKED: {
    vi: "Nhà cung cấp này chưa được liên kết",
    en: "This sign-in provider is not linked to your account.",
    th: "ผู้ให้บริการเข้าสู่ระบบนี้ไม่ได้เชื่อมกับบัญชีของคุณ",
  },
  AUTH_LAST_SIGN_IN_METHOD: {
    vi: "Không thể hủy phương thức đăng nhập cuối cùng",
    en: "Cannot remove your only sign-in method.",
    th: "ไม่สามารถลบวิธีเข้าสู่ระบบวิธีเดียวที่คุณมีได้",
  },
  AUTH_ACCOUNT_FETCHED: {
    vi: "Lấy thông tin tài khoản thành công",
    en: "Account information retrieved successfully.",
    th: "ดึงข้อมูลบัญชีเรียบร้อยแล้ว",
  },
  AUTH_DEVICE_LINK_INITIATED: {
    vi: "Đã tạo phiên liên kết thiết bị. Vui lòng phê duyệt trên thiết bị hiện có của bạn",
    en: "Device linking initiated. Please approve on your existing device.",
    th: "เริ่มการเชื่อมอุปกรณ์แล้ว กรุณาอนุมัติบนอุปกรณ์เดิมของคุณ",
  },
  AUTH_DEVICE_LINK_STATUS: {
    vi: "Lấy trạng thái liên kết thiết bị thành công",
    en: "Device link status retrieved.",
    th: "ดึงสถานะการเชื่อมอุปกรณ์แล้ว",
  },
  AUTH_DEVICE_LINK_APPROVED: {
    vi: "Đã phê duyệt liên kết thiết bị",
    en: "Device linked successfully.",
    th: "เชื่อมอุปกรณ์เรียบร้อยแล้ว",
  },
  AUTH_DEVICE_LINK_NOT_FOUND: {
    vi: "Phiên liên kết thiết bị không tồn tại hoặc đã hết hạn",
    en: "Device link session not found or has expired.",
    th: "ไม่พบเซสชันการเชื่อมอุปกรณ์หรือเซสชันหมดอายุแล้ว",
  },
  AUTH_DEVICE_LINK_ALREADY_APPROVED: {
    vi: "Phiên liên kết thiết bị này đã được phê duyệt",
    en: "This device link session has already been approved.",
    th: "เซสชันการเชื่อมอุปกรณ์นี้ได้รับการอนุมัติแล้ว",
  },
  AUTH_DEVICE_LINK_SCANNED: {
    vi: "Đã quét mã QR liên kết thiết bị",
    en: "QR code scanned. Approve or reject the login on this device.",
    th: "สแกนคิวอาร์โค้ดแล้ว กรุณาอนุมัติหรือปฏิเสธการเข้าสู่ระบบบนอุปกรณ์นี้",
  },
  AUTH_DEVICE_LINK_REJECTED: {
    vi: "Đã từ chối liên kết thiết bị",
    en: "Device link request rejected.",
    th: "ปฏิเสธคำขอเชื่อมอุปกรณ์แล้ว",
  },
  AUTH_DEVICE_LINK_ALREADY_SCANNED: {
    vi: "Mã QR này đã được quét",
    en: "This QR code has already been scanned.",
    th: "คิวอาร์โค้ดนี้ถูกสแกนไปแล้ว",
  },
  AUTH_DEVICE_LINK_NOT_SCANNED: {
    vi: "Mã QR này cần được quét trước khi phê duyệt hoặc từ chối",
    en: "This QR code must be scanned before it can be approved or rejected.",
    th: "ต้องสแกนคิวอาร์โค้ดนี้ก่อนจึงจะอนุมัติหรือปฏิเสธได้",
  },
  AUTH_DEVICE_LINK_WRONG_USER: {
    vi: "Chỉ người dùng đã quét mã QR mới có thể phê duyệt hoặc từ chối",
    en: "Only the user who scanned this QR code can approve or reject it.",
    th: "เฉพาะผู้ใช้ที่สแกนคิวอาร์โค้ดนี้เท่านั้นที่อนุมัติหรือปฏิเสธได้",
  },
  AUTH_DEVICE_LINK_EXPIRED: {
    vi: "Mã QR này đã hết hạn",
    en: "This QR code has expired.",
    th: "คิวอาร์โค้ดนี้หมดอายุแล้ว",
  },
  AUTH_ACCOUNT_DELETE_OTP_SENT: {
    vi: "Mã xác minh xóa tài khoản đã được gửi tới email của bạn",
    en: "A verification code to confirm account deletion has been sent to your email.",
    th: "ส่งรหัสยืนยันการลบบัญชีไปยังอีเมลของคุณแล้ว",
  },
  AUTH_ACCOUNT_DELETED: {
    vi: "Tài khoản đã được xóa",
    en: "Your account has been deleted successfully.",
    th: "ลบบัญชีของคุณเรียบร้อยแล้ว",
  },
  AUTH_DELETE_CONFIRMATION_REQUIRED: {
    vi: "Vui lòng nhập mật khẩu hiện tại để xác nhận xóa tài khoản",
    en: "Your current password is required to confirm account deletion.",
    th: "ต้องใช้รหัสผ่านปัจจุบันของคุณเพื่อยืนยันการลบบัญชี",
  },
  AUTH_PASSWORD_REQUIRED: {
    vi: "Vui lòng nhập mật khẩu để xác nhận hành động này",
    en: "Password is required to confirm this action.",
    th: "ต้องใช้รหัสผ่านเพื่อยืนยันการดำเนินการนี้",
  },
  AUTH_PASSWORD_INCORRECT: {
    vi: "Mật khẩu nhập vào không chính xác",
    en: "The password you entered is incorrect.",
    th: "รหัสผ่านที่คุณกรอกไม่ถูกต้อง",
  },
} as const satisfies MessageCatalog;

export type AuthMessageKey = keyof typeof AUTH_MESSAGES;
