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
    th: "เข้าสู่ระบบสำเร็จ",
  },
  ADMIN_TOKEN_REFRESHED: {
    vi: "Làm mới phiên đăng nhập thành công",
    en: "Session refreshed successfully.",
    th: "ต่ออายุเซสชันเรียบร้อยแล้ว",
  },
  ADMIN_LOGOUT_SUCCESS: {
    vi: "Đăng xuất thành công",
    en: "Signed out successfully.",
    th: "ออกจากระบบเรียบร้อยแล้ว",
  },
  ADMIN_OTP_SENT: {
    vi: "Mã xác minh đã được gửi đến email của bạn",
    en: "A verification code has been sent to your email.",
    th: "ส่งรหัสยืนยันไปยังอีเมลของคุณแล้ว",
  },
  ADMIN_OTP_VERIFIED: {
    vi: "Xác thực mã thành công",
    en: "Verification code confirmed.",
    th: "ยืนยันรหัสเรียบร้อยแล้ว",
  },
  ADMIN_PASSWORD_RESET_SUCCESS: {
    vi: "Cập nhật mật khẩu thành công",
    en: "Password updated successfully.",
    th: "อัปเดตรหัสผ่านเรียบร้อยแล้ว",
  },

  // ── Auth / RBAC / routing guards ──────────────────────────────────────────
  // Admin login is email-only, unlike the shared AUTH_INVALID_CREDENTIALS key
  // (used by the regular-user flow, which also accepts a username) — this key
  // gives the admin panel its own accurate wording without touching that one.
  ADMIN_INVALID_CREDENTIALS: {
    vi: "Email hoặc mật khẩu không đúng",
    en: "Invalid email or password.",
    th: "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
  },
  ADMIN_ACCOUNT_NOT_ACTIVE: {
    vi: "Tài khoản quản trị không hoạt động",
    en: "Your account has been disabled. Please contact the super administrator.",
    th: "บัญชีของคุณถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบสูงสุด",
  },
  ADMIN_ACCOUNT_DELETED: {
    vi: "Tài khoản quản trị này không còn tồn tại",
    en: "Your account is no longer available.",
    th: "บัญชีของคุณไม่พร้อมใช้งานอีกต่อไป",
  },
  ADMIN_FORBIDDEN: {
    vi: "Bạn không có quyền thực hiện thao tác này",
    en: "You do not have permission to perform this action.",
    th: "คุณไม่มีสิทธิ์ดำเนินการนี้",
  },
  ROUTE_NOT_FOUND: {
    vi: "Không tìm thấy đường dẫn",
    en: "The requested route was not found.",
    th: "ไม่พบเส้นทางที่ร้องขอ",
  },

  // ── Password-reset / OTP flow ──────────────────────────────────────────────
  OTP_INVALID: {
    vi: "Mã xác minh không hợp lệ hoặc đã hết hạn",
    en: "Invalid or expired verification code.",
    th: "รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว",
  },
  OTP_MAX_ATTEMPTS: {
    vi: "Bạn đã nhập sai quá nhiều lần. Vui lòng yêu cầu mã mới",
    en: "Too many failed attempts. Please request a new verification code.",
    th: "พยายามผิดพลาดหลายครั้งเกินไป กรุณาขอรหัสยืนยันใหม่",
  },
  RESET_TOKEN_INVALID: {
    vi: "Mã đặt lại mật khẩu không hợp lệ hoặc đã được sử dụng",
    en: "This password reset link is invalid or has already been used.",
    th: "ลิงก์รีเซ็ตรหัสผ่านนี้ไม่ถูกต้องหรือถูกใช้ไปแล้ว",
  },
  RESET_TOKEN_EXPIRED: {
    vi: "Mã đặt lại mật khẩu đã hết hạn",
    en: "This password reset link has expired. Please request a new one.",
    th: "ลิงก์รีเซ็ตรหัสผ่านนี้หมดอายุแล้ว กรุณาขอลิงก์ใหม่",
  },
  PASSWORD_SAME_AS_CURRENT: {
    vi: "Mật khẩu mới phải khác mật khẩu hiện tại",
    en: "New password must be different from the current password.",
    th: "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน",
  },

  // ── User moderation ─────────────────────────────────────────────────────────
  USER_NOT_FOUND: {
    vi: "Không tìm thấy người dùng",
    en: "User not found.",
    th: "ไม่พบผู้ใช้",
  },
  USER_DELETED: {
    vi: "Tài khoản người dùng này đã bị xóa",
    en: "This user account has been deleted.",
    th: "บัญชีผู้ใช้นี้ถูกลบไปแล้ว",
  },
  USER_ALREADY_BANNED: {
    vi: "Người dùng này đã bị cấm",
    en: "This user is already banned.",
    th: "ผู้ใช้รายนี้ถูกแบนอยู่แล้ว",
  },
  USER_NOT_BANNED: {
    vi: "Người dùng này chưa bị cấm",
    en: "This user is not currently banned.",
    th: "ผู้ใช้รายนี้ไม่ได้ถูกแบนอยู่",
  },

  USER_NOT_DELETED: {
    vi: "Tài khoản người dùng này chưa bị xóa",
    en: "This user account has not been deleted.",
    th: "บัญชีผู้ใช้นี้ยังไม่ถูกลบ",
  },
  USER_REACTIVATE_NOT_APPLIED: {
    vi: "Không thể kích hoạt lại tài khoản lúc này. Vui lòng thử lại.",
    en: "The account could not be reactivated right now. Please try again.",
    th: "ไม่สามารถเปิดใช้งานบัญชีอีกครั้งได้ในขณะนี้ กรุณาลองใหม่",
  },

  // ── Report moderation ───────────────────────────────────────────────────────
  REPORT_NOT_FOUND: {
    vi: "Không tìm thấy báo cáo",
    en: "Report not found.",
    th: "ไม่พบรายงาน",
  },
  REPORT_ALREADY_RESOLVED: {
    vi: "Báo cáo này đã được xử lý",
    en: "This report has already been resolved.",
    th: "รายงานนี้ได้รับการแก้ไขแล้ว",
  },

  // ── Community moderation ──────────────────────────────────────────────────────
  COMMUNITY_ALREADY_CLOSED: {
    vi: "Cộng đồng đã được đóng",
    en: "This community is already closed.",
    th: "คอมมูนิตี้นี้ถูกปิดอยู่แล้ว",
  },
  COMMUNITY_NOT_CLOSED: {
    vi: "Cộng đồng chưa được đóng",
    en: "This community is not closed.",
    th: "คอมมูนิตี้นี้ไม่ได้ถูกปิด",
  },

  // ── Livestream moderation ─────────────────────────────────────────────────────
  LIVESTREAM_NOT_FOUND: {
    vi: "Không tìm thấy buổi phát trực tiếp",
    en: "Livestream not found.",
    th: "ไม่พบไลฟ์สตรีม",
  },
  LIVESTREAM_ALREADY_ENDED: {
    vi: "Buổi phát trực tiếp này đã kết thúc",
    en: "This livestream has already ended.",
    th: "ไลฟ์สตรีมนี้จบไปแล้ว",
  },
  LIVESTREAM_REPORT_NOT_FOUND: {
    vi: "Không tìm thấy báo cáo phát trực tiếp",
    en: "Livestream report not found.",
    th: "ไม่พบรายงานไลฟ์สตรีม",
  },

  // ── Admin Accounts ──────────────────────────────────────────────────────────
  ADMIN_NOT_FOUND: {
    vi: "Không tìm thấy quản trị viên",
    en: "Admin account not found.",
    th: "ไม่พบบัญชีผู้ดูแลระบบ",
  },
  ADMIN_EMAIL_TAKEN: {
    vi: "Email này đã được sử dụng bởi một quản trị viên khác",
    en: "This email is already used by another admin.",
    th: "อีเมลนี้ถูกใช้โดยผู้ดูแลระบบรายอื่นแล้ว",
  },
  ADMIN_EMAIL_TAKEN_BY_USER: {
    vi: "Email này đã được sử dụng bởi một tài khoản người dùng",
    en: "This email is already used by an app user account.",
    th: "อีเมลนี้ถูกใช้โดยบัญชีผู้ใช้แอปแล้ว",
  },
  ADMIN_ROLE_NOT_FOUND: {
    vi: "Không tìm thấy vai trò",
    en: "Role not found.",
    th: "ไม่พบบทบาท",
  },
  ADMIN_ALREADY_ACTIVE: {
    vi: "Tài khoản quản trị này đã hoạt động",
    en: "This admin account is already active.",
    th: "บัญชีผู้ดูแลระบบนี้เปิดใช้งานอยู่แล้ว",
  },
  ADMIN_ALREADY_INACTIVE: {
    vi: "Tài khoản quản trị này đã bị vô hiệu hóa",
    en: "This admin account is already deactivated.",
    th: "บัญชีผู้ดูแลระบบนี้ถูกปิดใช้งานอยู่แล้ว",
  },
  ADMIN_CANNOT_DEACTIVATE_SELF: {
    vi: "Bạn không thể tự vô hiệu hóa tài khoản của mình",
    en: "You cannot deactivate your own account.",
    th: "คุณไม่สามารถปิดใช้งานบัญชีของตัวเองได้",
  },
  ADMIN_USERNAME_TAKEN: {
    vi: "Tên đăng nhập này đã được sử dụng bởi một quản trị viên khác",
    en: "This username is already used by another admin.",
    th: "ชื่อผู้ใช้นี้ถูกใช้โดยผู้ดูแลระบบรายอื่นแล้ว",
  },
  ADMIN_CANNOT_DEACTIVATE_LAST_SUPER_ADMIN: {
    vi: "Không thể vô hiệu hóa Super Admin cuối cùng",
    en: "Cannot deactivate the last remaining Super Admin.",
    th: "ไม่สามารถปิดใช้งานผู้ดูแลระบบสูงสุดคนสุดท้ายได้",
  },
  ADMIN_MUST_DEACTIVATE_BEFORE_DELETE: {
    vi: "Vui lòng vô hiệu hóa tài khoản trước khi xóa",
    en: "Deactivate the account before deleting it.",
    th: "โปรดปิดใช้งานบัญชีก่อนลบ",
  },

  // ── Success: admin accounts & permissions ────────────────────────────────
  // Backoffice was the one service that never adopted `ApiResponse`: its 86
  // endpoints answered `{ success: true, data }` with no human-readable line,
  // so the admin panel had nothing to show in a toast and had to invent its
  // own copy per screen. These are the missing halves of those responses.
  ADMIN_ACCOUNTS_FETCHED: {
    vi: "Đã tải danh sách tài khoản quản trị",
    en: "Admin accounts fetched",
    th: "ดึงข้อมูลบัญชีผู้ดูแลระบบแล้ว",
  },
  ADMIN_ACCOUNT_CREATED: {
    vi: "Đã tạo tài khoản quản trị",
    en: "Admin account created",
    th: "สร้างบัญชีผู้ดูแลระบบแล้ว",
  },
  ADMIN_ACCOUNT_FETCHED: {
    vi: "Đã tải thông tin tài khoản quản trị",
    en: "Admin account fetched",
    th: "ดึงข้อมูลบัญชีผู้ดูแลระบบแล้ว",
  },
  ADMIN_ACCOUNT_UPDATED: {
    vi: "Đã cập nhật tài khoản quản trị",
    en: "Admin account updated",
    th: "อัปเดตบัญชีผู้ดูแลระบบแล้ว",
  },
  ADMIN_ACCOUNT_ACTIVATED: {
    vi: "Đã kích hoạt tài khoản quản trị",
    en: "Admin account activated",
    th: "เปิดใช้งานบัญชีผู้ดูแลระบบแล้ว",
  },
  ADMIN_ACCOUNT_DEACTIVATED: {
    vi: "Đã vô hiệu hóa tài khoản quản trị",
    en: "Admin account deactivated",
    th: "ปิดใช้งานบัญชีผู้ดูแลระบบแล้ว",
  },
  ADMIN_ACCOUNT_DELETE_SUCCESS: {
    vi: "Đã xóa tài khoản quản trị",
    en: "Admin account deleted",
    th: "ลบบัญชีผู้ดูแลระบบแล้ว",
  },
  ADMIN_ACCOUNT_STATUS_UPDATED: {
    vi: "Đã cập nhật trạng thái tài khoản quản trị",
    en: "Admin account status updated",
    th: "อัปเดตสถานะบัญชีผู้ดูแลระบบแล้ว",
  },
  ADMIN_PERMISSIONS_FETCHED: {
    vi: "Đã tải danh mục quyền",
    en: "Permission catalogue fetched",
    th: "ดึงข้อมูลรายการสิทธิ์แล้ว",
  },
  ADMIN_ACCOUNT_PERMISSIONS_FETCHED: {
    vi: "Đã tải quyền của tài khoản quản trị",
    en: "Admin permissions fetched",
    th: "ดึงข้อมูลสิทธิ์ของผู้ดูแลระบบแล้ว",
  },
  ADMIN_ACCOUNT_PERMISSIONS_UPDATED: {
    vi: "Đã cập nhật quyền của tài khoản quản trị",
    en: "Admin permissions updated",
    th: "อัปเดตสิทธิ์ของผู้ดูแลระบบแล้ว",
  },
  ADMIN_PROFILE_FETCHED: {
    vi: "Đã tải hồ sơ của bạn",
    en: "Profile fetched",
    th: "ดึงข้อมูลโปรไฟล์แล้ว",
  },
  ADMIN_PROFILE_UPDATED: {
    vi: "Đã cập nhật hồ sơ",
    en: "Profile updated",
    th: "อัปเดตโปรไฟล์แล้ว",
  },

  // ── Success: announcements, audit logs, categories ───────────────────────
  ADMIN_ANNOUNCEMENT_CREATED: {
    vi: "Đã tạo thông báo",
    en: "Announcement created",
    th: "สร้างประกาศแล้ว",
  },
  ADMIN_ANNOUNCEMENTS_FETCHED: {
    vi: "Đã tải danh sách thông báo",
    en: "Announcements fetched",
    th: "ดึงข้อมูลประกาศแล้ว",
  },
  ADMIN_ANNOUNCEMENT_FETCHED: {
    vi: "Đã tải thông báo",
    en: "Announcement fetched",
    th: "ดึงข้อมูลประกาศแล้ว",
  },
  ADMIN_AUDIT_LOGS_FETCHED: {
    vi: "Đã tải nhật ký kiểm tra",
    en: "Audit logs fetched",
    th: "ดึงข้อมูลบันทึกการตรวจสอบแล้ว",
  },
  ADMIN_AUDIT_LOG_FETCHED: {
    vi: "Đã tải bản ghi nhật ký kiểm tra",
    en: "Audit log entry fetched",
    th: "ดึงข้อมูลรายการบันทึกการตรวจสอบแล้ว",
  },
  ADMIN_CATEGORIES_FETCHED: {
    vi: "Đã tải danh sách danh mục",
    en: "Categories fetched",
    th: "ดึงข้อมูลหมวดหมู่แล้ว",
  },
  ADMIN_CATEGORY_CREATED: {
    vi: "Đã tạo danh mục",
    en: "Category created",
    th: "สร้างหมวดหมู่แล้ว",
  },
  ADMIN_CATEGORY_UPDATED: {
    vi: "Đã cập nhật danh mục",
    en: "Category updated",
    th: "อัปเดตหมวดหมู่แล้ว",
  },
  ADMIN_CATEGORY_VISIBILITY_UPDATED: {
    vi: "Đã cập nhật hiển thị của danh mục",
    en: "Category visibility updated",
    th: "อัปเดตการมองเห็นของหมวดหมู่แล้ว",
  },
  ADMIN_CATEGORY_DELETED: {
    vi: "Đã xóa danh mục",
    en: "Category deleted",
    th: "ลบหมวดหมู่แล้ว",
  },

  // ── Success: notification categories ─────────────────────────────────────
  ADMIN_NOTIFICATION_CATEGORIES_FETCHED: {
    vi: "Đã tải danh mục thông báo",
    en: "Notification categories fetched",
    th: "ดึงข้อมูลหมวดหมู่การแจ้งเตือนแล้ว",
  },
  ADMIN_NOTIFICATION_CATEGORY_UPDATED: {
    vi: "Đã cập nhật danh mục thông báo",
    en: "Notification category updated",
    th: "อัปเดตหมวดหมู่การแจ้งเตือนแล้ว",
  },
  NOTIFICATION_CATEGORY_NOT_FOUND: {
    vi: "Không tìm thấy danh mục thông báo",
    en: "Notification category not found",
    th: "ไม่พบหมวดหมู่การแจ้งเตือน",
  },

  // ── Success: communities ─────────────────────────────────────────────────
  ADMIN_COMMUNITIES_FETCHED: {
    vi: "Đã tải danh sách cộng đồng",
    en: "Communities fetched",
    th: "ดึงข้อมูลคอมมูนิตี้แล้ว",
  },
  ADMIN_COMMUNITY_FETCHED: {
    vi: "Đã tải thông tin cộng đồng",
    en: "Community fetched",
    th: "ดึงข้อมูลคอมมูนิตี้แล้ว",
  },
  ADMIN_COMMUNITY_MEMBERS_FETCHED: {
    vi: "Đã tải danh sách thành viên cộng đồng",
    en: "Community members fetched",
    th: "ดึงข้อมูลสมาชิกคอมมูนิตี้แล้ว",
  },
  ADMIN_COMMUNITY_MUTED_MEMBERS_FETCHED: {
    vi: "Đã tải danh sách thành viên bị tắt tiếng",
    en: "Muted members fetched",
    th: "ดึงข้อมูลสมาชิกที่ถูกปิดเสียงแล้ว",
  },
  ADMIN_COMMUNITY_MESSAGES_FETCHED: {
    vi: "Đã tải tin nhắn của cộng đồng",
    en: "Community messages fetched",
    th: "ดึงข้อมูลข้อความคอมมูนิตี้แล้ว",
  },
  ADMIN_COMMUNITY_CLOSED: {
    vi: "Đã đóng cộng đồng",
    en: "Community closed",
    th: "ปิดคอมมูนิตี้แล้ว",
  },
  ADMIN_COMMUNITY_REOPENED: {
    vi: "Đã mở lại cộng đồng",
    en: "Community reopened",
    th: "เปิดคอมมูนิตี้อีกครั้งแล้ว",
  },
  ADMIN_COMMUNITIES_BULK_CLOSED: {
    vi: "Đã xử lý yêu cầu đóng hàng loạt",
    en: "Bulk close processed",
    th: "ดำเนินการปิดหลายรายการแล้ว",
  },
  ADMIN_COMMUNITIES_BULK_REOPENED: {
    vi: "Đã xử lý yêu cầu mở lại hàng loạt",
    en: "Bulk reopen processed",
    th: "ดำเนินการเปิดหลายรายการอีกครั้งแล้ว",
  },
  ADMIN_COMMUNITY_MEMBER_REMOVED: {
    vi: "Đã xóa thành viên khỏi cộng đồng",
    en: "Member removed from the community",
    th: "นำสมาชิกออกจากคอมมูนิตี้แล้ว",
  },
  ADMIN_COMMUNITY_MEMBER_BANNED: {
    vi: "Đã cấm thành viên khỏi cộng đồng",
    en: "Member banned from the community",
    th: "แบนสมาชิกออกจากคอมมูนิตี้แล้ว",
  },
  ADMIN_COMMUNITY_MEMBER_UNBANNED: {
    vi: "Đã gỡ cấm thành viên",
    en: "Member unbanned",
    th: "ยกเลิกการแบนสมาชิกแล้ว",
  },
  ADMIN_COMMUNITY_CO_MEMBERS_FETCHED: {
    vi: "Đã tải danh sách thành viên chung",
    en: "Co-members fetched",
    th: "ดึงข้อมูลสมาชิกร่วมแล้ว",
  },

  // ── Success: groups ──────────────────────────────────────────────────────
  ADMIN_GROUPS_FETCHED: {
    vi: "Đã tải danh sách nhóm",
    en: "Groups fetched",
    th: "ดึงข้อมูลกลุ่มแล้ว",
  },
  ADMIN_GROUP_FETCHED: {
    vi: "Đã tải thông tin nhóm",
    en: "Group fetched",
    th: "ดึงข้อมูลกลุ่มแล้ว",
  },
  ADMIN_GROUP_MEMBERS_FETCHED: {
    vi: "Đã tải danh sách thành viên nhóm",
    en: "Group members fetched",
    th: "ดึงข้อมูลสมาชิกกลุ่มแล้ว",
  },
  ADMIN_GROUP_DISBANDED: {
    vi: "Đã giải tán nhóm",
    en: "Group disbanded",
    th: "ยุบกลุ่มแล้ว",
  },
  ADMIN_GROUP_MEMBER_REMOVED: {
    vi: "Đã xóa thành viên khỏi nhóm",
    en: "Member removed from the group",
    th: "นำสมาชิกออกจากกลุ่มแล้ว",
  },

  // ── Success: livestreams ─────────────────────────────────────────────────
  ADMIN_LIVESTREAMS_FETCHED: {
    vi: "Đã tải danh sách buổi phát trực tiếp",
    en: "Livestreams fetched",
    th: "ดึงข้อมูลไลฟ์สตรีมแล้ว",
  },
  ADMIN_LIVESTREAM_FETCHED: {
    vi: "Đã tải thông tin buổi phát trực tiếp",
    en: "Livestream fetched",
    th: "ดึงข้อมูลไลฟ์สตรีมแล้ว",
  },
  ADMIN_LIVESTREAM_REPORTS_FETCHED: {
    vi: "Đã tải báo cáo của buổi phát trực tiếp",
    en: "Livestream reports fetched",
    th: "ดึงข้อมูลรายงานไลฟ์สตรีมแล้ว",
  },
  ADMIN_LIVESTREAM_VIEWERS_FETCHED: {
    vi: "Đã tải danh sách người xem",
    en: "Livestream viewers fetched",
    th: "ดึงข้อมูลผู้ชมไลฟ์สตรีมแล้ว",
  },
  ADMIN_LIVESTREAM_COMMENTS_FETCHED: {
    vi: "Đã tải bình luận của buổi phát trực tiếp",
    en: "Livestream comments fetched",
    th: "ดึงข้อมูลความคิดเห็นไลฟ์สตรีมแล้ว",
  },
  ADMIN_LIVESTREAM_ENDED: {
    vi: "Đã kết thúc buổi phát trực tiếp",
    en: "Livestream ended",
    th: "สิ้นสุดไลฟ์สตรีมแล้ว",
  },
  ADMIN_LIVESTREAMS_BULK_ENDED: {
    vi: "Đã xử lý yêu cầu kết thúc hàng loạt",
    en: "Bulk end processed",
    th: "ดำเนินการสิ้นสุดหลายรายการแล้ว",
  },
  ADMIN_LIVESTREAM_THUMBNAIL_UPLOAD_READY: {
    vi: "Đã tạo liên kết tải ảnh thu nhỏ",
    en: "Thumbnail upload URL issued",
    th: "ออกลิงก์อัปโหลดภาพขนาดย่อแล้ว",
  },
  ADMIN_LIVESTREAM_THUMBNAIL_UPDATED: {
    vi: "Đã cập nhật ảnh thu nhỏ",
    en: "Thumbnail updated",
    th: "อัปเดตภาพขนาดย่อแล้ว",
  },
  ADMIN_LIVESTREAM_REPORTS_BULK_REVIEWED: {
    vi: "Đã xử lý yêu cầu duyệt báo cáo hàng loạt",
    en: "Bulk report review processed",
    th: "ดำเนินการตรวจสอบรายงานหลายรายการแล้ว",
  },

  // ── Success: moderation & reports ────────────────────────────────────────
  ADMIN_REPORTS_FETCHED: {
    vi: "Đã tải danh sách báo cáo",
    en: "Reports fetched",
    th: "ดึงข้อมูลรายงานแล้ว",
  },
  ADMIN_REPORT_FETCHED: {
    vi: "Đã tải chi tiết báo cáo",
    en: "Report fetched",
    th: "ดึงข้อมูลรายงานแล้ว",
  },
  ADMIN_REPORT_USERS_FETCHED: {
    vi: "Đã tải danh sách người dùng liên quan",
    en: "Report users fetched",
    th: "ดึงข้อมูลผู้ใช้ในรายงานแล้ว",
  },
  ADMIN_REPORT_RESOLVED: {
    vi: "Đã xử lý báo cáo",
    en: "Report resolved",
    th: "แก้ไขรายงานแล้ว",
  },
  ADMIN_REPORT_DISMISSED: {
    vi: "Đã bỏ qua báo cáo",
    en: "Report dismissed",
    th: "ยกเลิกรายงานแล้ว",
  },
  ADMIN_REPORTS_BULK_RESOLVED: {
    vi: "Đã xử lý yêu cầu giải quyết báo cáo hàng loạt",
    en: "Bulk resolve processed",
    th: "ดำเนินการแก้ไขหลายรายการแล้ว",
  },
  ADMIN_REPORTS_BULK_DISMISSED: {
    vi: "Đã xử lý yêu cầu bỏ qua báo cáo hàng loạt",
    en: "Bulk dismiss processed",
    th: "ดำเนินการยกเลิกหลายรายการแล้ว",
  },
  ADMIN_REPORT_EVIDENCE_FETCHED: {
    vi: "Đã tải bằng chứng của báo cáo",
    en: "Report evidence fetched",
    th: "ดึงข้อมูลหลักฐานของรายงานแล้ว",
  },
  ADMIN_REPORT_HISTORY_FETCHED: {
    vi: "Đã tải lịch sử của báo cáo",
    en: "Report history fetched",
    th: "ดึงข้อมูลประวัติของรายงานแล้ว",
  },
  ADMIN_REPORT_RELATED_FETCHED: {
    vi: "Đã tải các báo cáo liên quan",
    en: "Related reports fetched",
    th: "ดึงข้อมูลรายงานที่เกี่ยวข้องแล้ว",
  },

  // ── Success: users ───────────────────────────────────────────────────────
  ADMIN_USERS_FETCHED: {
    vi: "Đã tải danh sách người dùng",
    en: "Users fetched",
    th: "ดึงข้อมูลผู้ใช้แล้ว",
  },
  ADMIN_USER_FETCHED: {
    vi: "Đã tải thông tin người dùng",
    en: "User fetched",
    th: "ดึงข้อมูลผู้ใช้แล้ว",
  },
  ADMIN_BAN_REASONS_FETCHED: {
    vi: "Đã tải danh sách lý do cấm",
    en: "Ban reasons fetched",
    th: "ดึงข้อมูลเหตุผลการแบนแล้ว",
  },
  ADMIN_USER_REPORTS_FETCHED: {
    vi: "Đã tải báo cáo về người dùng",
    en: "User reports fetched",
    th: "ดึงข้อมูลรายงานของผู้ใช้แล้ว",
  },
  ADMIN_USER_DEVICES_FETCHED: {
    vi: "Đã tải thiết bị của người dùng",
    en: "User devices fetched",
    th: "ดึงข้อมูลอุปกรณ์ของผู้ใช้แล้ว",
  },
  ADMIN_USER_COMMUNITIES_FETCHED: {
    vi: "Đã tải cộng đồng của người dùng",
    en: "User communities fetched",
    th: "ดึงข้อมูลคอมมูนิตี้ของผู้ใช้แล้ว",
  },
  ADMIN_USER_BANNED: {
    vi: "Đã cấm người dùng",
    en: "User banned",
    th: "แบนผู้ใช้แล้ว",
  },
  ADMIN_USER_SUSPENDED: {
    vi: "Đã tạm khóa người dùng",
    en: "User suspended",
    th: "ระงับผู้ใช้ชั่วคราวแล้ว",
  },
  ADMIN_USER_UNBANNED: {
    vi: "Đã gỡ cấm người dùng",
    en: "User unbanned",
    th: "ยกเลิกการแบนผู้ใช้แล้ว",
  },
  ADMIN_USER_REACTIVATED: {
    vi: "Đã kích hoạt lại người dùng",
    en: "User reactivated",
    th: "เปิดใช้งานผู้ใช้อีกครั้งแล้ว",
  },
  ADMIN_USERS_BULK_BANNED: {
    vi: "Đã xử lý yêu cầu cấm hàng loạt",
    en: "Bulk ban processed",
    th: "ดำเนินการแบนหลายรายการแล้ว",
  },
  ADMIN_USERS_BULK_ACTIVATED: {
    vi: "Đã xử lý yêu cầu kích hoạt hàng loạt",
    en: "Bulk activate processed",
    th: "ดำเนินการเปิดใช้งานหลายรายการแล้ว",
  },

  // ── Success: dashboard & system ──────────────────────────────────────────
  ADMIN_DASHBOARD_OVERVIEW_FETCHED: {
    vi: "Đã tải tổng quan bảng điều khiển",
    en: "Dashboard overview fetched",
    th: "ดึงข้อมูลภาพรวมแดชบอร์ดแล้ว",
  },
  ADMIN_DASHBOARD_CHARTS_FETCHED: {
    vi: "Đã tải biểu đồ bảng điều khiển",
    en: "Dashboard charts fetched",
    th: "ดึงข้อมูลแผนภูมิแดชบอร์ดแล้ว",
  },
  ADMIN_DASHBOARD_SERVICE_STATUS_FETCHED: {
    vi: "Đã tải trạng thái dịch vụ",
    en: "Service status fetched",
    th: "ดึงข้อมูลสถานะบริการแล้ว",
  },
  ADMIN_DASHBOARD_CALL_ANALYTICS_FETCHED: {
    vi: "Đã tải thống kê cuộc gọi",
    en: "Call analytics fetched",
    th: "ดึงข้อมูลสถิติการโทรแล้ว",
  },
  ADMIN_SYSTEM_HEALTH_FETCHED: {
    vi: "Đã tải tình trạng hệ thống",
    en: "System health fetched",
    th: "ดึงข้อมูลสถานะระบบแล้ว",
  },
  ADMIN_FRIENDSHIPS_DISCONNECTED: {
    vi: "Đã ngắt kết nối toàn bộ quan hệ bạn bè",
    en: "All friendships disconnected",
    th: "ตัดการเชื่อมต่อความเป็นเพื่อนทั้งหมดแล้ว",
  },
  ADMIN_CALLING_STATE_FETCHED: {
    vi: "Đã tải trạng thái tính năng gọi",
    en: "Calling state fetched",
    th: "ดึงข้อมูลสถานะการโทรแล้ว",
  },
  ADMIN_CALLING_STATE_UPDATED: {
    vi: "Đã cập nhật trạng thái tính năng gọi",
    en: "Calling state updated",
    th: "อัปเดตสถานะการโทรแล้ว",
  },

  // ── Errors that reached the panel as raw tokens ──────────────────────────
  // Every key below was already being thrown by backoffice-service but had no
  // entry here, so `buildApiError`'s `localize()` fell through to
  // `fallbackMessage` — which for an AppError IS the key. The panel then saw an
  // UPPER_SNAKE token, discarded it as a code (`isErrorToken` in
  // utils/errorHandler.ts) and showed its generic fallback instead. The reason
  // was therefore lost in EVERY language, English included.
  ADMIN_CANNOT_EDIT_OWN_PERMISSIONS: {
    vi: "Bạn không thể tự chỉnh sửa quyền của chính mình",
    en: "You cannot edit your own permissions.",
    th: "คุณไม่สามารถแก้ไขสิทธิ์ของตนเองได้",
  },
  ADMIN_CANNOT_DEMOTE_LAST_SUPER_ADMIN: {
    vi: "Không thể hạ quyền quản trị viên cấp cao cuối cùng",
    en: "The last super administrator cannot be demoted.",
    th: "ไม่สามารถลดสิทธิ์ผู้ดูแลระบบสูงสุดคนสุดท้ายได้",
  },
  ANNOUNCEMENT_NOT_FOUND: {
    vi: "Không tìm thấy thông báo",
    en: "Announcement not found.",
    th: "ไม่พบประกาศ",
  },
  ANNOUNCEMENT_NOT_SCHEDULED: {
    vi: "Chỉ có thể sửa hoặc hủy thông báo đang được lên lịch",
    en: "Only a scheduled announcement can be edited or cancelled.",
    th: "แก้ไขหรือยกเลิกได้เฉพาะประกาศที่ตั้งเวลาไว้เท่านั้น",
  },
  AUDIT_LOG_NOT_FOUND: {
    vi: "Không tìm thấy nhật ký kiểm toán",
    en: "Audit log entry not found.",
    th: "ไม่พบบันทึกการตรวจสอบ",
  },
  GROUP_NOT_FOUND: {
    vi: "Không tìm thấy nhóm",
    en: "Group not found.",
    th: "ไม่พบกลุ่ม",
  },
  GROUP_MEMBER_NOT_ACTIVE: {
    vi: "Người dùng này không còn là thành viên đang hoạt động của nhóm",
    en: "This user is no longer an active member of the group.",
    th: "ผู้ใช้รายนี้ไม่ได้เป็นสมาชิกที่ใช้งานอยู่ของกลุ่มแล้ว",
  },
  USER_BAN_NOT_APPLIED: {
    vi: "Không thể áp dụng lệnh cấm ngay lúc này. Vui lòng thử lại.",
    en: "The ban could not be applied right now. Please try again.",
    th: "ไม่สามารถใช้การแบนได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง",
  },
  USER_UNBAN_NOT_APPLIED: {
    vi: "Không thể gỡ lệnh cấm ngay lúc này. Vui lòng thử lại.",
    en: "The ban could not be lifted right now. Please try again.",
    th: "ไม่สามารถยกเลิกการแบนได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง",
  },
} as const satisfies MessageCatalog;

export type AdminMessageKey = keyof typeof ADMIN_MESSAGES;
