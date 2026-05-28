import type { MessageCatalog } from "./types.js";

/** User-service API messages. */
export const USER_MESSAGES = {
  USER_PROFILE_UPDATED: {
    vi: "Cập nhật hồ sơ thành công",
    en: "Profile updated successfully",
  },
  USER_PROFILE_FETCHED: {
    vi: "Lấy hồ sơ thành công",
    en: "Profile fetched successfully",
  },
  USER_FRIENDS_FETCHED: {
    vi: "Lấy danh sách bạn bè thành công",
    en: "Friends list fetched successfully",
  },
  USER_CONNECTED_ACCOUNTS_FETCHED: {
    vi: "Lấy tài khoản liên kết thành công",
    en: "Connected accounts fetched successfully",
  },
  USER_SETTINGS_FETCHED: {
    vi: "Lấy cài đặt thành công",
    en: "Settings fetched successfully",
  },
  USER_SETTINGS_UPDATED: {
    vi: "Cập nhật cài đặt thành công",
    en: "Settings updated successfully",
  },
  USER_SETTINGS_NOT_FOUND: {
    vi: "Không tìm thấy cài đặt người dùng",
    en: "User settings not found",
  },
  USER_SETTINGS_INVALID_CALL_ALLOW_LIST: {
    vi: "Danh sách bạn bè được phép gọi không hợp lệ",
    en: "Invalid call allow list",
  },
  USER_AUTH_SERVICE_UNAVAILABLE: {
    vi: "Dịch vụ xác thực tạm thời không khả dụng",
    en: "Authentication service is temporarily unavailable",
  },
  USER_PROFILE_NOT_FOUND: {
    vi: "Không tìm thấy hồ sơ người dùng",
    en: "User profile not found",
  },
  USER_USERNAME_TAKEN: {
    vi: "Tên người dùng này đã được sử dụng",
    en: "This username is already taken",
  },
  USER_USERNAME_CHANGE_TOO_SOON: {
    vi: "Bạn chỉ có thể đổi tên người dùng mỗi 30 ngày một lần",
    en: "You can only change your username once every 30 days",
  },
  USER_PROFILE_UPDATE_EMPTY: {
    vi: "Cần ít nhất một trường để cập nhật",
    en: "At least one field is required to update",
  },
  USER_INVALID_DATE_OF_BIRTH: {
    vi: "Ngày sinh không hợp lệ",
    en: "Invalid date of birth",
  },
  USER_USERNAME_GENERATED: {
    vi: "Đã tạo tên người dùng gợi ý",
    en: "Suggested username generated",
  },
  USER_USERNAME_VALIDATED: {
    vi: "Đã kiểm tra tên người dùng",
    en: "Username availability checked",
  },
  INVALID_USERNAME_FORMAT: {
    vi: "Tên người dùng không hợp lệ",
    en: "Invalid username format",
  },
  USERNAME_GENERATION_FAILED: {
    vi: "Không thể tạo tên người dùng, vui lòng thử lại",
    en: "Could not generate a username, please try again",
  },
  USER_AVATAR_UPLOAD_URL_CREATED: {
    vi: "Đã tạo URL tải ảnh đại diện",
    en: "Avatar upload URL created",
  },
  INVALID_AVATAR_OBJECT_KEY: {
    vi: "Ảnh đại diện không hợp lệ",
    en: "Invalid avatar reference",
  },
  AVATAR_NOT_UPLOADED: {
    vi: "Chưa tải ảnh lên, vui lòng upload trước khi lưu",
    en: "Avatar file not uploaded yet",
  },
  AVATAR_FILE_TOO_LARGE: {
    vi: "Ảnh đại diện vượt quá kích thước cho phép",
    en: "Avatar file exceeds the maximum allowed size",
  },
  FRIEND_REQUEST_SENT: {
    vi: "Đã gửi lời mời kết bạn",
    en: "Friend request sent",
  },
  FRIEND_REQUEST_ACCEPTED: {
    vi: "Đã chấp nhận lời mời kết bạn",
    en: "Friend request accepted",
  },
  FRIEND_REQUEST_REJECTED: {
    vi: "Đã từ chối lời mời kết bạn",
    en: "Friend request declined",
  },
  FRIEND_REQUEST_CANCELLED: {
    vi: "Đã thu hồi lời mời kết bạn",
    en: "Friend request cancelled",
  },
  FRIEND_REMOVED: {
    vi: "Đã xóa bạn bè",
    en: "Friend removed",
  },
  FRIEND_REQUEST_NOT_FOUND: {
    vi: "Không tìm thấy lời mời kết bạn",
    en: "Friend request not found",
  },
  FRIEND_REQUEST_ALREADY_SENT: {
    vi: "Bạn đã gửi lời mời kết bạn cho người dùng này",
    en: "You have already sent a friend request to this user",
  },
  FRIEND_ALREADY_FRIENDS: {
    vi: "Bạn đã là bạn bè với người dùng này",
    en: "You are already friends with this user",
  },
  FRIEND_CANNOT_ADD_SELF: {
    vi: "Bạn không thể kết bạn với chính mình",
    en: "You cannot send a friend request to yourself",
  },
  FRIEND_BLOCKED: {
    vi: "Không thể gửi lời mời kết bạn cho người dùng này",
    en: "Cannot send a friend request to this user",
  },
  USERS_FETCHED: {
    vi: "Lấy danh sách người dùng thành công",
    en: "Users fetched successfully",
  },
} as const satisfies MessageCatalog;

export type UserMessageKey = keyof typeof USER_MESSAGES;
