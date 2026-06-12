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
  COMMUNITY_NAME_AVAILABLE: {
    vi: "Tên cộng đồng này có thể sử dụng",
    en: "This community name is available.",
  },
  COMMUNITY_HANDLE_AVAILABLE: {
    vi: "Định danh cộng đồng này có thể sử dụng",
    en: "This community handle is available.",
  },
  COMMUNITY_CATEGORIES_FETCHED: {
    vi: "Lấy danh mục cộng đồng thành công",
    en: "Community categories fetched successfully",
  },
  COMMUNITY_LIST_FETCHED: {
    vi: "Lấy danh sách cộng đồng thành công",
    en: "Communities fetched successfully",
  },
  COMMUNITY_DISCOVER_FETCHED: {
    vi: "Khám phá cộng đồng thành công",
    en: "Communities discovered successfully",
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
  COMMUNITY_JOINED: {
    vi: "Đã tham gia cộng đồng",
    en: "Joined the community",
  },
  COMMUNITY_JOIN_REQUIRES_INVITE: {
    vi: "Cộng đồng riêng tư yêu cầu lời mời",
    en: "This community is private and requires an invite",
  },
  COMMUNITY_JOIN_BANNED: {
    vi: "Bạn đã bị cấm khỏi cộng đồng này",
    en: "You are banned from this community",
  },
  COMMUNITY_ADMIN_TRANSFERRED: {
    vi: "Đã chuyển quyền quản trị viên",
    en: "Community admin transferred",
  },
  COMMUNITY_DELETED: {
    vi: "Đã xóa cộng đồng",
    en: "Community deleted",
  },
  COMMUNITY_JOIN_REQUEST_CREATED: {
    vi: "Đã gửi yêu cầu tham gia",
    en: "Join request submitted",
  },
  COMMUNITY_JOIN_REQUESTS_FETCHED: {
    vi: "Lấy danh sách yêu cầu tham gia thành công",
    en: "Join requests fetched successfully",
  },
  COMMUNITY_MY_JOIN_REQUESTS_FETCHED: {
    vi: "Lấy yêu cầu tham gia của bạn thành công",
    en: "Your join requests fetched successfully",
  },
  COMMUNITY_JOIN_REQUEST_APPROVED: {
    vi: "Đã duyệt yêu cầu tham gia",
    en: "Join request approved",
  },
  COMMUNITY_JOIN_REQUEST_REJECTED: {
    vi: "Đã từ chối yêu cầu tham gia",
    en: "Join request rejected",
  },
  COMMUNITY_JOIN_REQUESTS_BULK_APPROVED: {
    vi: "Đã duyệt hàng loạt yêu cầu tham gia",
    en: "Join requests bulk approved",
  },
  COMMUNITY_JOIN_REQUESTS_BULK_REJECTED: {
    vi: "Đã từ chối hàng loạt yêu cầu tham gia",
    en: "Join requests bulk rejected",
  },
  COMMUNITY_JOIN_REQUEST_CANCELLED: {
    vi: "Đã hủy yêu cầu tham gia",
    en: "Join request cancelled",
  },
  COMMUNITY_JOIN_REQUEST_NOT_FOUND: {
    vi: "Không tìm thấy yêu cầu tham gia",
    en: "Join request not found",
  },
  COMMUNITY_JOIN_REQUEST_NOT_PENDING: {
    vi: "Yêu cầu tham gia không còn ở trạng thái chờ",
    en: "Join request is not pending",
  },
  COMMUNITY_JOIN_REQUEST_PUBLIC_NOT_ALLOWED: {
    vi: "Cộng đồng công khai không yêu cầu duyệt tham gia",
    en: "Public communities do not require join requests",
  },
  COMMUNITY_JOIN_REQUEST_NOT_OWNER: {
    vi: "Bạn không thể hủy yêu cầu của người khác",
    en: "You cannot cancel another user's join request",
  },
  COMMUNITY_ALREADY_MEMBER: {
    vi: "Người dùng đã là thành viên của cộng đồng",
    en: "User is already a member of the community",
  },
  COMMUNITY_INVITE_CREATED: {
    vi: "Đã gửi lời mời",
    en: "Invite sent",
  },
  COMMUNITY_INVITES_FETCHED: {
    vi: "Lấy danh sách lời mời thành công",
    en: "Invites fetched successfully",
  },
  COMMUNITY_MY_INVITES_FETCHED: {
    vi: "Lấy lời mời của bạn thành công",
    en: "Your invites fetched successfully",
  },
  COMMUNITY_INVITE_ACCEPTED: {
    vi: "Đã chấp nhận lời mời",
    en: "Invite accepted",
  },
  COMMUNITY_INVITE_DECLINED: {
    vi: "Đã từ chối lời mời",
    en: "Invite declined",
  },
  COMMUNITY_INVITE_NOT_FOUND: {
    vi: "Không tìm thấy lời mời",
    en: "Invite not found",
  },
  COMMUNITY_INVITE_NOT_PENDING: {
    vi: "Lời mời không còn ở trạng thái chờ",
    en: "Invite is not pending",
  },
  COMMUNITY_INVITE_USER_BANNED: {
    vi: "Không thể mời người dùng đã bị cấm",
    en: "Cannot invite a banned user",
  },
  COMMUNITY_INVITE_NOT_INVITEE: {
    vi: "Bạn không phải là người được mời",
    en: "You are not the invitee",
  },
  COMMUNITY_REPORT_CREATED: {
    vi: "Đã gửi báo cáo",
    en: "Report submitted",
  },
  COMMUNITY_REPORTS_FETCHED: {
    vi: "Lấy danh sách báo cáo thành công",
    en: "Reports fetched successfully",
  },
  COMMUNITY_MY_REPORTS_FETCHED: {
    vi: "Lấy báo cáo của bạn thành công",
    en: "Your reports fetched successfully",
  },
  COMMUNITY_REPORT_REVIEWED: {
    vi: "Đã đánh dấu báo cáo là đã xem xét",
    en: "Report marked as reviewed",
  },
  COMMUNITY_REPORT_ACTIONED: {
    vi: "Đã xử lý báo cáo",
    en: "Report actioned",
  },
  COMMUNITY_REPORT_DISMISSED: {
    vi: "Đã bỏ qua báo cáo",
    en: "Report dismissed",
  },
  COMMUNITY_REPORT_WITHDRAWN: {
    vi: "Đã rút báo cáo",
    en: "Report withdrawn",
  },
  COMMUNITY_REPORT_NOT_FOUND: {
    vi: "Không tìm thấy báo cáo",
    en: "Report not found",
  },
  COMMUNITY_REPORT_NOT_OPEN: {
    vi: "Báo cáo không còn ở trạng thái mở",
    en: "Report is no longer open",
  },
  COMMUNITY_REPORT_NOT_OWNER: {
    vi: "Bạn không thể rút báo cáo của người khác",
    en: "You cannot withdraw another user's report",
  },
  COMMUNITY_REPORT_CANNOT_TARGET_SELF: {
    vi: "Bạn không thể báo cáo chính mình",
    en: "You cannot report yourself",
  },
  COMMUNITY_REPORT_INVALID_TRANSITION: {
    vi: "Không thể chuyển trạng thái báo cáo này",
    en: "Invalid report status transition",
  },
  COMMUNITY_REPORT_DELETED: {
    vi: "Đã xóa báo cáo",
    en: "Report deleted",
  },

  // --- Member moderation mute / warn --------------------------------------
  COMMUNITY_MEMBER_MUTED: {
    vi: "Đã tắt tiếng thành viên",
    en: "Member muted",
  },
  COMMUNITY_MEMBER_UNMUTED: {
    vi: "Đã bỏ tắt tiếng thành viên",
    en: "Member unmuted",
  },
  COMMUNITY_MEMBER_NOT_MUTED: {
    vi: "Thành viên này hiện không bị tắt tiếng",
    en: "This member is not muted",
  },
  COMMUNITY_MUTED_MEMBERS_FETCHED: {
    vi: "Lấy danh sách thành viên bị tắt tiếng thành công",
    en: "Muted members fetched successfully",
  },
  COMMUNITY_MEMBER_WARNED: {
    vi: "Đã cảnh cáo thành viên",
    en: "Member warned",
  },
  COMMUNITY_MEMBER_WARNINGS_FETCHED: {
    vi: "Lấy danh sách cảnh cáo thành viên thành công",
    en: "Member warnings fetched successfully",
  },

  // --- Notification preferences -------------------------------------------
  COMMUNITY_NOTIFICATION_PREFERENCES_FETCHED: {
    vi: "Lấy tùy chọn thông báo thành công",
    en: "Notification preferences fetched successfully",
  },
  COMMUNITY_NOTIFICATION_PREFERENCES_UPDATED: {
    vi: "Đã cập nhật tùy chọn thông báo",
    en: "Notification preferences updated",
  },

  // --- Mute ---------------------------------------------------------------
  COMMUNITY_MUTE_UPDATED: {
    vi: "Đã cập nhật cài đặt tắt thông báo",
    en: "Mute setting updated",
  },
  COMMUNITY_MUTE_CLEARED: {
    vi: "Đã bật lại thông báo",
    en: "Mute cleared",
  },
  COMMUNITY_MUTE_FETCHED: {
    vi: "Lấy cài đặt tắt thông báo thành công",
    en: "Mute setting fetched",
  },
  COMMUNITY_NOT_MUTED: {
    vi: "Cộng đồng này hiện không bị tắt thông báo",
    en: "Community is not muted",
  },
  COMMUNITY_MARK_READ_UPDATED: {
    vi: "Đã đánh dấu đọc thành công",
    en: "Marked as read",
  },

  // --- Invite links --------------------------------------------------------
  COMMUNITY_INVITE_LINK_CREATED: {
    vi: "Đã tạo liên kết mời",
    en: "Invite link created",
  },
  COMMUNITY_INVITE_LINKS_FETCHED: {
    vi: "Lấy danh sách liên kết mời thành công",
    en: "Invite links fetched",
  },
  COMMUNITY_INVITE_LINK_REVOKED: {
    vi: "Đã thu hồi liên kết mời",
    en: "Invite link revoked",
  },
  COMMUNITY_INVITE_LINK_REDEEMED: {
    vi: "Đã tham gia cộng đồng qua liên kết mời",
    en: "Joined community via invite link",
  },
  COMMUNITY_INVITE_LINK_NOT_FOUND: {
    vi: "Không tìm thấy liên kết mời",
    en: "Invite link not found",
  },
  COMMUNITY_INVITE_LINK_REVOKED_ERROR: {
    vi: "Liên kết mời này đã bị thu hồi",
    en: "This invite link has been revoked",
  },
  COMMUNITY_INVITE_LINK_EXPIRED: {
    vi: "Liên kết mời đã hết hạn",
    en: "Invite link has expired",
  },
  COMMUNITY_INVITE_LINK_EXHAUSTED: {
    vi: "Liên kết mời đã đạt giới hạn sử dụng",
    en: "Invite link usage limit reached",
  },
  COMMUNITY_INVITE_LINK_BULK_SENT: {
    vi: "Đã gửi liên kết mời hàng loạt",
    en: "Invite links sent",
  },
  COMMUNITY_INVITE_LINK_INACTIVE: {
    vi: "Liên kết mời này không còn hoạt động",
    en: "Invite link is no longer active",
  },
} as const satisfies MessageCatalog;

export type CommunityMessageKey = keyof typeof COMMUNITY_MESSAGES;
