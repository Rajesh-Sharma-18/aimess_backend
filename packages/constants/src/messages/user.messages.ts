import type { MessageCatalog } from "./types.js";

/** User-service API messages. */
export const USER_MESSAGES = {
  USER_PROFILE_UPDATED: {
    vi: "Cập nhật hồ sơ thành công",
    en: "Profile updated successfully.",
    th: "อัปเดตโปรไฟล์เรียบร้อยแล้ว",
  },
  USER_PROFILE_FETCHED: {
    vi: "Lấy hồ sơ thành công",
    en: "Profile retrieved successfully.",
    th: "ดึงข้อมูลโปรไฟล์เรียบร้อยแล้ว",
  },
  USER_FRIENDS_FETCHED: {
    vi: "Lấy danh sách bạn bè thành công",
    en: "Friends list retrieved successfully.",
    th: "ดึงรายชื่อเพื่อนเรียบร้อยแล้ว",
  },
  USER_FRIEND_REQUESTS_FETCHED: {
    vi: "Lấy danh sách lời mời kết bạn thành công",
    en: "Friend requests retrieved successfully.",
    th: "ดึงคำขอเป็นเพื่อนเรียบร้อยแล้ว",
  },
  USER_CONNECTED_ACCOUNTS_FETCHED: {
    vi: "Lấy tài khoản liên kết thành công",
    en: "Connected accounts retrieved successfully.",
    th: "ดึงบัญชีที่เชื่อมต่อเรียบร้อยแล้ว",
  },
  USER_SETTINGS_FETCHED: {
    vi: "Lấy cài đặt thành công",
    en: "Settings retrieved successfully.",
    th: "ดึงการตั้งค่าเรียบร้อยแล้ว",
  },
  USER_SETTINGS_UPDATED: {
    vi: "Cập nhật cài đặt thành công",
    en: "Settings updated successfully.",
    th: "อัปเดตการตั้งค่าเรียบร้อยแล้ว",
  },
  USER_SETTINGS_NOT_FOUND: {
    vi: "Không tìm thấy cài đặt người dùng",
    en: "Settings not found for this account.",
    th: "ไม่พบการตั้งค่าสำหรับบัญชีนี้",
  },
  USER_SETTINGS_INVALID_CALL_ALLOW_LIST: {
    vi: "Danh sách bạn bè được phép gọi không hợp lệ",
    en: "The call allow list contains invalid entries.",
    th: "รายชื่อผู้ที่อนุญาตให้โทรมีข้อมูลไม่ถูกต้อง",
  },
  USER_SETTINGS_INVALID_QUIET_HOURS: {
    vi: "Giờ yên tĩnh cần có cả thời gian bắt đầu và kết thúc",
    en: "Quiet hours need both a start time and an end time.",
    th: "ช่วงเวลาเงียบต้องระบุทั้งเวลาเริ่มต้นและเวลาสิ้นสุด",
  },
  USER_AUTH_SERVICE_UNAVAILABLE: {
    vi: "Dịch vụ xác thực tạm thời không khả dụng",
    en: "Authentication service is temporarily unavailable. Please try again later.",
    th: "ระบบยืนยันตัวตนไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่ภายหลัง",
  },
  USER_PROFILE_NOT_FOUND: {
    vi: "Không tìm thấy hồ sơ người dùng",
    en: "User profile not found.",
    th: "ไม่พบโปรไฟล์ผู้ใช้",
  },
  USER_USERNAME_AVAILABLE: {
    vi: "Tên người dùng này có thể sử dụng",
    en: "This username is available.",
    th: "ชื่อผู้ใช้นี้ใช้งานได้",
  },
  USER_USERNAME_TAKEN: {
    vi: "Tên người dùng này đã được sử dụng",
    en: "This username is already taken.",
    th: "ชื่อผู้ใช้นี้ถูกใช้ไปแล้ว",
  },
  USER_USERNAME_CHANGE_TOO_SOON: {
    vi: "Bạn chỉ có thể đổi tên người dùng mỗi 30 ngày một lần",
    en: "You can only change your username once every 30 days.",
    th: "คุณเปลี่ยนชื่อผู้ใช้ได้เพียง 1 ครั้งทุก 30 วัน",
  },
  USER_PROFILE_UPDATE_EMPTY: {
    vi: "Cần ít nhất một trường để cập nhật",
    en: "Please provide at least one field to update.",
    th: "กรุณาระบุข้อมูลอย่างน้อยหนึ่งรายการที่ต้องการอัปเดต",
  },
  USER_INVALID_DATE_OF_BIRTH: {
    vi: "Ngày sinh không hợp lệ",
    en: "Please enter a valid date of birth.",
    th: "กรุณากรอกวันเกิดให้ถูกต้อง",
  },
  USER_USERNAME_GENERATED: {
    vi: "Đã tạo tên người dùng gợi ý",
    en: "A suggested username has been generated.",
    th: "สร้างชื่อผู้ใช้ที่แนะนำแล้ว",
  },
  USER_USERNAME_VALIDATED: {
    vi: "Đã kiểm tra tên người dùng",
    en: "Username availability checked.",
    th: "ตรวจสอบชื่อผู้ใช้ที่ว่างแล้ว",
  },
  INVALID_USERNAME_FORMAT: {
    vi: "Tên người dùng không hợp lệ",
    en: "Username may only contain lowercase letters, numbers, and underscores.",
    th: "ชื่อผู้ใช้ประกอบด้วยตัวอักษรพิมพ์เล็ก ตัวเลข และขีดล่างเท่านั้น",
  },
  USERNAME_GENERATION_FAILED: {
    vi: "Không thể tạo tên người dùng, vui lòng thử lại",
    en: "Could not generate a username. Please try again.",
    th: "ไม่สามารถสร้างชื่อผู้ใช้ได้ กรุณาลองใหม่",
  },
  USER_AVATAR_UPLOAD_URL_CREATED: {
    vi: "Đã tạo URL tải ảnh đại diện",
    en: "Avatar upload URL created.",
    th: "สร้างลิงก์อัปโหลดรูปโปรไฟล์แล้ว",
  },
  INVALID_AVATAR_OBJECT_KEY: {
    vi: "Ảnh đại diện không hợp lệ",
    en: "Invalid avatar reference.",
    th: "การอ้างอิงรูปโปรไฟล์ไม่ถูกต้อง",
  },
  AVATAR_NOT_UPLOADED: {
    vi: "Chưa tải ảnh lên, vui lòng upload trước khi lưu",
    en: "Please upload your avatar image before saving.",
    th: "กรุณาอัปโหลดรูปโปรไฟล์ก่อนบันทึก",
  },
  AVATAR_FILE_TOO_LARGE: {
    vi: "Ảnh đại diện vượt quá kích thước cho phép",
    en: "Avatar file exceeds the maximum allowed size.",
    th: "ไฟล์รูปโปรไฟล์มีขนาดเกินกว่าที่กำหนด",
  },
  FRIEND_REQUEST_SENT: {
    vi: "Đã gửi lời mời kết bạn",
    en: "Friend request sent.",
    th: "ส่งคำขอเป็นเพื่อนแล้ว",
  },
  FRIEND_REQUEST_ACCEPTED: {
    vi: "Đã chấp nhận lời mời kết bạn",
    en: "Friend request accepted.",
    th: "ตอบรับคำขอเป็นเพื่อนแล้ว",
  },
  FRIEND_REQUEST_REJECTED: {
    vi: "Đã từ chối lời mời kết bạn",
    en: "Friend request declined.",
    th: "ปฏิเสธคำขอเป็นเพื่อนแล้ว",
  },
  FRIEND_REQUEST_CANCELLED: {
    vi: "Đã thu hồi lời mời kết bạn",
    en: "Friend request cancelled.",
    th: "ยกเลิกคำขอเป็นเพื่อนแล้ว",
  },
  FRIEND_REMOVED: {
    vi: "Đã xóa bạn bè",
    en: "Friend removed successfully.",
    th: "ลบเพื่อนเรียบร้อยแล้ว",
  },
  FRIEND_REQUEST_NOT_FOUND: {
    vi: "Không tìm thấy lời mời kết bạn",
    en: "Friend request not found.",
    th: "ไม่พบคำขอเป็นเพื่อน",
  },
  FRIEND_REQUEST_ALREADY_SENT: {
    vi: "Bạn đã gửi lời mời kết bạn cho người dùng này",
    en: "You have already sent a friend request to this user.",
    th: "คุณส่งคำขอเป็นเพื่อนถึงผู้ใช้รายนี้ไปแล้ว",
  },
  FRIEND_ALREADY_FRIENDS: {
    vi: "Bạn đã là bạn bè với người dùng này",
    en: "You are already friends with this user.",
    th: "คุณเป็นเพื่อนกับผู้ใช้รายนี้อยู่แล้ว",
  },
  FRIEND_CANNOT_ADD_SELF: {
    vi: "Bạn không thể kết bạn với chính mình",
    en: "You cannot send a friend request to yourself.",
    th: "คุณไม่สามารถส่งคำขอเป็นเพื่อนถึงตัวเองได้",
  },
  FRIEND_BLOCKED: {
    vi: "Không thể gửi lời mời kết bạn cho người dùng này",
    en: "Unable to send a friend request to this user.",
    th: "ไม่สามารถส่งคำขอเป็นเพื่อนถึงผู้ใช้รายนี้ได้",
  },
  // whoCanSendFriendRequests denied the sender. Deliberately worded the same
  // as FRIEND_BLOCKED so the response can't be used to probe someone's privacy
  // setting (or infer that they blocked you).
  FRIEND_REQUEST_NOT_ALLOWED: {
    vi: "Không thể gửi lời mời kết bạn cho người dùng này",
    en: "Unable to send a friend request to this user.",
    th: "ไม่สามารถส่งคำขอเป็นเพื่อนถึงผู้ใช้รายนี้ได้",
  },
  FRIEND_USER_BLOCKED: {
    vi: "Đã chặn người dùng",
    en: "User blocked.",
    th: "บล็อกผู้ใช้แล้ว",
  },
  FRIEND_USER_UNBLOCKED: {
    vi: "Đã bỏ chặn người dùng",
    en: "User unblocked.",
    th: "ปลดบล็อกผู้ใช้แล้ว",
  },
  FRIEND_ALREADY_BLOCKED: {
    vi: "Bạn đã chặn người dùng này",
    en: "You have already blocked this user.",
    th: "คุณบล็อกผู้ใช้รายนี้ไปแล้ว",
  },
  FRIEND_NOT_BLOCKED: {
    vi: "Bạn chưa chặn người dùng này",
    en: "You have not blocked this user.",
    th: "คุณไม่ได้บล็อกผู้ใช้รายนี้",
  },
  USER_BLOCKED_LIST_FETCHED: {
    vi: "Lấy danh sách người bị chặn thành công",
    en: "Blocked users retrieved successfully.",
    th: "ดึงรายชื่อผู้ใช้ที่ถูกบล็อกเรียบร้อยแล้ว",
  },
  FRIEND_DISCONNECT_ALL_CONFIRMATION_REQUIRED: {
    vi: "Yêu cầu xác nhận để ngắt kết nối tất cả bạn bè trên toàn nền tảng",
    en: "Confirmation is required to disconnect every friendship on the platform.",
    th: "ต้องยืนยันก่อนจึงจะยกเลิกความเป็นเพื่อนทั้งหมดบนแพลตฟอร์มได้",
  },
  USER_FRIENDSHIP_STATUS_FETCHED: {
    vi: "Lấy trạng thái kết bạn thành công",
    en: "Friendship status retrieved successfully.",
    th: "ดึงสถานะความเป็นเพื่อนเรียบร้อยแล้ว",
  },
  USERS_FETCHED: {
    vi: "Lấy danh sách người dùng thành công",
    en: "Users retrieved successfully.",
    th: "ดึงรายชื่อผู้ใช้เรียบร้อยแล้ว",
  },
  FRIENDS_AUTO_CONNECTED: {
    vi: "Đã kết bạn tự động thành công",
    en: "Auto-connect completed.",
    th: "เชื่อมต่อเพื่อนอัตโนมัติเรียบร้อยแล้ว",
  },
  FRIENDS_AUTO_DISCONNECTED: {
    vi: "Đã hủy kết bạn tất cả bạn bè thành công",
    en: "Auto-disconnect completed.",
    th: "ยกเลิกการเชื่อมต่อเพื่อนอัตโนมัติเรียบร้อยแล้ว",
  },
  USER_RECENT_SEARCH_RECORDED: {
    vi: "Đã lưu mục vừa xem",
    en: "Recently viewed item saved.",
    th: "บันทึกรายการที่เพิ่งดูแล้ว",
  },
  RECENT_SEARCH_LIST_FETCHED: {
    vi: "Lấy danh sách tìm kiếm gần đây thành công",
    en: "Recent searches retrieved successfully.",
    th: "ดึงประวัติการค้นหาล่าสุดเรียบร้อยแล้ว",
  },
  RECENT_SEARCH_RECORDED: {
    vi: "Đã lưu tìm kiếm",
    en: "Search recorded.",
    th: "บันทึกการค้นหาแล้ว",
  },
  RECENT_SEARCH_DELETED: {
    vi: "Đã xóa tìm kiếm",
    en: "Search deleted.",
    th: "ลบการค้นหาแล้ว",
  },
  RECENT_SEARCH_NOT_FOUND: {
    vi: "Không tìm thấy tìm kiếm này",
    en: "Recent search not found.",
    th: "ไม่พบการค้นหาล่าสุด",
  },
  RECENT_SEARCH_CLEARED: {
    vi: "Đã xóa toàn bộ lịch sử tìm kiếm",
    en: "Recent search history cleared.",
    th: "ล้างประวัติการค้นหาล่าสุดแล้ว",
  },
} as const satisfies MessageCatalog;

export type UserMessageKey = keyof typeof USER_MESSAGES;
