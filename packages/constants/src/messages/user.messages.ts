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
} as const satisfies MessageCatalog;

export type UserMessageKey = keyof typeof USER_MESSAGES;
