import type { MessageCatalog } from "./types.js";

/** Community-service API messages. */
export const COMMUNITY_MESSAGES = {
  COMMUNITY_CREATED: {
    vi: "Tạo cộng đồng thành công",
    en: "Community created successfully",
  },
  COMMUNITY_UPDATED: {
    vi: "Cập nhật cộng đồng thành công",
    en: "Community updated successfully",
  },
  COMMUNITY_FETCHED: {
    vi: "Lấy thông tin cộng đồng thành công",
    en: "Community fetched successfully",
  },
  COMMUNITY_NAME_AVAILABILITY: {
    vi: "Đã kiểm tra tên cộng đồng",
    en: "Community name availability checked",
  },
  COMMUNITY_HANDLE_AVAILABILITY: {
    vi: "Đã kiểm tra định danh cộng đồng",
    en: "Community handle availability checked",
  },
  COMMUNITY_CATEGORIES_FETCHED: {
    vi: "Lấy danh mục cộng đồng thành công",
    en: "Community categories fetched successfully",
  },
  COMMUNITY_LIST_FETCHED: {
    vi: "Lấy danh sách cộng đồng thành công",
    en: "Communities fetched successfully",
  },
  COMMUNITY_IMAGE_UPLOAD_URL_CREATED: {
    vi: "Đã tạo URL tải ảnh cộng đồng",
    en: "Community image upload URL created",
  },
  COMMUNITY_NAME_TAKEN: {
    vi: "Tên cộng đồng này đã được sử dụng",
    en: "This community name is already taken",
  },
  COMMUNITY_HANDLE_TAKEN: {
    vi: "Định danh cộng đồng này đã được sử dụng",
    en: "This community handle is already taken",
  },
  COMMUNITY_NOT_FOUND: {
    vi: "Không tìm thấy cộng đồng",
    en: "Community not found",
  },
  COMMUNITY_FORBIDDEN: {
    vi: "Bạn không có quyền thực hiện hành động này",
    en: "You do not have permission to perform this action",
  },
  COMMUNITY_CATEGORY_INVALID: {
    vi: "Danh mục cộng đồng không hợp lệ",
    en: "Invalid community category",
  },
  COMMUNITY_IMAGE_NOT_UPLOADED: {
    vi: "Chưa tải ảnh lên, vui lòng upload trước khi lưu",
    en: "Community image not uploaded yet",
  },
  COMMUNITY_IMAGE_INVALID_OBJECT_KEY: {
    vi: "Ảnh cộng đồng không hợp lệ",
    en: "Invalid community image reference",
  },
  COMMUNITY_IMAGE_FILE_TOO_LARGE: {
    vi: "Ảnh cộng đồng vượt quá kích thước cho phép",
    en: "Community image exceeds the maximum allowed size",
  },
  COMMUNITY_MEMBERS_FETCHED: {
    vi: "Lấy danh sách thành viên thành công",
    en: "Community members fetched successfully",
  },
  COMMUNITY_MEMBER_ROLE_UPDATED: {
    vi: "Cập nhật vai trò thành viên thành công",
    en: "Member role updated successfully",
  },
  COMMUNITY_MEMBER_NOT_FOUND: {
    vi: "Không tìm thấy thành viên",
    en: "Community member not found",
  },
  COMMUNITY_MEMBER_CANNOT_MODIFY_SELF: {
    vi: "Bạn không thể thay đổi vai trò của chính mình",
    en: "You cannot change your own role",
  },
  COMMUNITY_MEMBER_CANNOT_MODIFY_ADMIN: {
    vi: "Không thể thay đổi vai trò của quản trị viên cộng đồng",
    en: "Cannot change the role of the community admin",
  },
  COMMUNITY_MEMBER_KICKED: {
    vi: "Đã xóa thành viên khỏi cộng đồng",
    en: "Member removed from the community",
  },
  COMMUNITY_MEMBER_BANNED: {
    vi: "Đã cấm thành viên khỏi cộng đồng",
    en: "Member banned from the community",
  },
  COMMUNITY_MEMBERS_ADDED: {
    vi: "Đã thêm thành viên vào cộng đồng",
    en: "Members added to the community",
  },
  COMMUNITY_LEFT: {
    vi: "Đã rời khỏi cộng đồng",
    en: "Left the community",
  },
  COMMUNITY_MEMBER_UNBANNED: {
    vi: "Đã bỏ cấm thành viên",
    en: "Member unbanned",
  },
  COMMUNITY_ADMIN_CANNOT_LEAVE: {
    vi: "Quản trị viên không thể rời khỏi cộng đồng",
    en: "The community admin cannot leave the community",
  },
  COMMUNITY_MEMBER_NOT_BANNED: {
    vi: "Thành viên này hiện không bị cấm",
    en: "This member is not banned",
  },
  COMMUNITY_AUDIT_LOGS_FETCHED: {
    vi: "Lấy nhật ký kiểm duyệt thành công",
    en: "Community audit logs fetched successfully",
  },
} as const satisfies MessageCatalog;

export type CommunityMessageKey = keyof typeof COMMUNITY_MESSAGES;
