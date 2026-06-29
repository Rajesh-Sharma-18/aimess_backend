import type { MessageCatalog } from "./types.js";

/** Stream-service API messages — lifecycle, comments, bans, and reports. */
export const STREAM_MESSAGES = {
  // ── Success ────────────────────────────────────────────────────────────────
  STREAM_CREATED: {
    en: "Stream created successfully.",
    vi: "Tạo buổi phát trực tiếp thành công.",
  },
  STREAM_LIST_FETCHED: {
    en: "Streams fetched successfully.",
    vi: "Lấy danh sách buổi phát trực tiếp thành công.",
  },
  STREAM_FETCHED: {
    en: "Stream fetched successfully.",
    vi: "Lấy thông tin buổi phát trực tiếp thành công.",
  },
  STREAM_UPDATED: {
    en: "Stream updated successfully.",
    vi: "Cập nhật buổi phát trực tiếp thành công.",
  },
  STREAM_DELETED: {
    en: "Stream deleted successfully.",
    vi: "Xóa buổi phát trực tiếp thành công.",
  },
  STREAM_STOPPED: {
    en: "Stream stopped successfully.",
    vi: "Dừng buổi phát trực tiếp thành công.",
  },
  STREAM_WENT_LIVE: {
    en: "Stream is now live.",
    vi: "Buổi phát trực tiếp đang bắt đầu.",
  },
  STREAM_COMMENTS_FETCHED: {
    en: "Comments fetched successfully.",
    vi: "Lấy danh sách bình luận thành công.",
  },
  STREAM_VIEWERS_FETCHED: {
    en: "Viewers fetched successfully.",
    vi: "Lấy danh sách người xem thành công.",
  },
  STREAM_COMMENT_STATUS_UPDATED: {
    en: "Comment status updated.",
    vi: "Cập nhật trạng thái bình luận thành công.",
  },
  STREAM_USER_BANNED: {
    en: "User banned from stream.",
    vi: "Cấm người dùng khỏi buổi phát trực tiếp thành công.",
  },
  STREAM_USER_UNBANNED: {
    en: "User ban lifted.",
    vi: "Gỡ lệnh cấm người dùng thành công.",
  },
  STREAM_BANS_FETCHED: {
    en: "Banned users fetched successfully.",
    vi: "Lấy danh sách người dùng bị cấm thành công.",
  },
  STREAM_COMMENT_REPORTED: {
    en: "Comment reported successfully.",
    vi: "Báo cáo bình luận thành công.",
  },
  STREAM_COMMENT_REPORTS_FETCHED: {
    en: "Comment reports fetched successfully.",
    vi: "Lấy danh sách báo cáo bình luận thành công.",
  },

  // ── Validation / bad request ────────────────────────────────────────────────
  STREAM_REQUEST_INVALID: {
    en: "Invalid request parameters.",
    vi: "Tham số yêu cầu không hợp lệ.",
  },
  STREAM_SOURCE_URL_REQUIRED: {
    en: "A source URL is required for this stream type.",
    vi: "URL nguồn là bắt buộc cho loại phát trực tiếp này.",
  },
  STREAM_ALREADY_ENDED: {
    en: "This stream has already ended.",
    vi: "Buổi phát trực tiếp này đã kết thúc.",
  },
  STREAM_CANNOT_BAN_OWNER: {
    en: "You cannot ban the stream owner.",
    vi: "Không thể cấm chủ sở hữu buổi phát trực tiếp.",
  },

  // ── Not found ─────────────────────────────────────────────────────────────
  STREAM_NOT_FOUND: {
    en: "Stream not found.",
    vi: "Không tìm thấy buổi phát trực tiếp.",
  },
  COMMENT_NOT_FOUND: {
    en: "Comment not found.",
    vi: "Không tìm thấy bình luận.",
  },

  // ── Forbidden / access ─────────────────────────────────────────────────────
  STREAM_NOT_OWNER: {
    en: "You are not the owner of this stream.",
    vi: "Bạn không phải là chủ sở hữu buổi phát trực tiếp này.",
  },
  STREAM_NOT_A_COMMUNITY_MEMBER: {
    en: "You must be a member of this community to start a stream.",
    vi: "Bạn phải là thành viên của cộng đồng này để phát trực tiếp.",
  },
  STREAM_BANNED: {
    en: "You have been banned from this stream.",
    vi: "Bạn đã bị cấm khỏi buổi phát trực tiếp này.",
  },
  COMMENTS_BANNED: {
    en: "You have been banned from commenting on this stream.",
    vi: "Bạn đã bị cấm bình luận trong buổi phát trực tiếp này.",
  },
  COMMENTS_DISABLED: {
    en: "Comments are disabled for this stream.",
    vi: "Bình luận đã bị tắt trong buổi phát trực tiếp này.",
  },
  COMMENT_DELETE_FORBIDDEN: {
    en: "You are not allowed to delete this comment.",
    vi: "Bạn không được phép xóa bình luận này.",
  },
  REPORTS_VIEW_FORBIDDEN: {
    en: "You do not have permission to view these reports.",
    vi: "Bạn không có quyền xem các báo cáo này.",
  },

  // ── Conflict ───────────────────────────────────────────────────────────────
  STREAM_COMMUNITY_CONCURRENCY_LIMIT: {
    en: "This community already has an active stream.",
    vi: "Cộng đồng này đã có một buổi phát trực tiếp đang hoạt động.",
  },
  STREAM_IS_LIVE: {
    en: "This stream is already live.",
    vi: "Buổi phát trực tiếp này đã đang diễn ra.",
  },
} as const satisfies MessageCatalog;

export type StreamMessageKey = keyof typeof STREAM_MESSAGES;
