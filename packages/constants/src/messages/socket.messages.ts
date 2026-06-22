import type { MessageCatalog } from "./types.js";

/**
 * Socket.IO acknowledgement messages (api-gateway namespaces /chat, /community,
 * /notify). Every request/response socket event answers its ack callback with a
 * localized, human-readable `message` — mirroring the REST `t()` envelope so a
 * mobile client can surface one consistent sentence whether it called HTTP or a
 * socket event.
 *
 * Kept in a dedicated catalog (not reusing CHAT_/COMMUNITY_ keys) because the
 * real-time ack copy is its own contract surface and may evolve independently of
 * the REST wording; any overlap in phrasing is incidental.
 */
export const SOCKET_MESSAGES = {
  // ── /chat — rooms ───────────────────────────────────────────────────────
  SOCKET_CONVERSATION_JOINED: {
    vi: "Đã tham gia cuộc trò chuyện",
    en: "Joined the conversation successfully",
  },
  SOCKET_CONVERSATION_LEFT: {
    vi: "Đã rời cuộc trò chuyện",
    en: "Left the conversation successfully",
  },

  // ── /chat — messages ────────────────────────────────────────────────────
  SOCKET_MESSAGE_SENT: {
    vi: "Đã gửi tin nhắn",
    en: "Message sent successfully",
  },
  SOCKET_MESSAGE_READ: {
    vi: "Đã đánh dấu tin nhắn là đã đọc",
    en: "Messages marked as read",
  },
  SOCKET_MESSAGE_REACTED: {
    vi: "Đã thêm cảm xúc",
    en: "Reaction added successfully",
  },
  SOCKET_MESSAGES_FETCHED: {
    vi: "Lấy tin nhắn thành công",
    en: "Messages fetched successfully",
  },
  SOCKET_CATCHUP_COMPLETED: {
    vi: "Đã đồng bộ tin nhắn",
    en: "Caught up successfully",
  },
  SOCKET_MESSAGE_EDITED: {
    vi: "Đã chỉnh sửa tin nhắn",
    en: "Message edited successfully",
  },
  SOCKET_MESSAGE_DELIVERED: {
    vi: "Đã đánh dấu tin nhắn là đã nhận",
    en: "Messages marked as delivered",
  },
  SOCKET_MESSAGE_FORWARDED: {
    vi: "Đã chuyển tiếp tin nhắn",
    en: "Message forwarded successfully",
  },
  SOCKET_REACTIONS_FETCHED: {
    vi: "Lấy danh sách cảm xúc thành công",
    en: "Reactions fetched successfully",
  },

  // ── /chat — presence ────────────────────────────────────────────────────
  SOCKET_PRESENCE_SUBSCRIBED: {
    vi: "Đã đăng ký nhận trạng thái hoạt động",
    en: "Subscribed to presence updates",
  },
  SOCKET_PRESENCE_UNSUBSCRIBED: {
    vi: "Đã hủy đăng ký trạng thái hoạt động",
    en: "Unsubscribed from presence updates",
  },
  SOCKET_PRESENCE_UNSUBSCRIBED_ALL: {
    vi: "Đã hủy đăng ký tất cả trạng thái hoạt động",
    en: "Unsubscribed from all presence updates",
  },
  SOCKET_PRESENCE_LIST_FETCHED: {
    vi: "Lấy danh sách theo dõi trạng thái thành công",
    en: "Presence subscription list fetched successfully",
  },

  // ── /chat — friends ─────────────────────────────────────────────────────
  SOCKET_FRIEND_REQUEST_SENT: {
    vi: "Đã gửi lời mời kết bạn",
    en: "Friend request sent",
  },
  SOCKET_FRIEND_REQUEST_ACCEPTED: {
    vi: "Đã chấp nhận lời mời kết bạn",
    en: "Friend request accepted",
  },
  SOCKET_FRIEND_REQUEST_REJECTED: {
    vi: "Đã từ chối lời mời kết bạn",
    en: "Friend request rejected",
  },
  SOCKET_FRIEND_REMOVED: {
    vi: "Đã hủy kết bạn",
    en: "Friend removed successfully",
  },
  SOCKET_FRIEND_REQUEST_CANCELLED: {
    vi: "Đã hủy lời mời kết bạn",
    en: "Friend request cancelled",
  },

  // ── /chat — auth ────────────────────────────────────────────────────────
  SOCKET_AUTH_REFRESHED: {
    vi: "Làm mới token thành công",
    en: "Token refreshed successfully",
  },

  // ── /chat — calls ───────────────────────────────────────────────────────
  SOCKET_CALL_INITIATED: {
    vi: "Đã bắt đầu cuộc gọi",
    en: "Call initiated successfully",
  },
  SOCKET_CALL_ANSWERED: {
    vi: "Đã trả lời cuộc gọi",
    en: "Call answered successfully",
  },
  SOCKET_CALL_DECLINED: {
    vi: "Đã từ chối cuộc gọi",
    en: "Call declined",
  },
  SOCKET_CALL_ENDED: {
    vi: "Đã kết thúc cuộc gọi",
    en: "Call ended",
  },

  // ── /community ──────────────────────────────────────────────────────────
  SOCKET_COMMUNITY_JOINED: {
    vi: "Đã tham gia cộng đồng",
    en: "Joined the community successfully",
  },
  SOCKET_COMMUNITY_LEFT: {
    vi: "Đã rời khỏi cộng đồng",
    en: "Left the community successfully",
  },
  SOCKET_COMMUNITY_MESSAGE_SENT: {
    vi: "Đã gửi tin nhắn",
    en: "Message sent successfully",
  },
  SOCKET_COMMUNITY_MESSAGES_FETCHED: {
    vi: "Lấy tin nhắn cộng đồng thành công",
    en: "Community messages fetched successfully",
  },
  SOCKET_COMMUNITY_MESSAGE_REACTED: {
    vi: "Đã thêm cảm xúc",
    en: "Reaction added successfully",
  },
  SOCKET_COMMUNITY_CATCHUP_COMPLETED: {
    vi: "Đã đồng bộ tin nhắn",
    en: "Caught up successfully",
  },
  SOCKET_COMMUNITY_MESSAGE_EDITED: {
    vi: "Đã chỉnh sửa tin nhắn",
    en: "Message edited successfully",
  },
  SOCKET_COMMUNITY_MESSAGE_DELETED: {
    vi: "Đã xóa tin nhắn",
    en: "Message deleted successfully",
  },
  SOCKET_COMMUNITY_MESSAGE_PINNED: {
    vi: "Đã ghim tin nhắn",
    en: "Message pinned successfully",
  },
  SOCKET_COMMUNITY_MESSAGE_UNPINNED: {
    vi: "Đã bỏ ghim tin nhắn",
    en: "Message unpinned successfully",
  },
  SOCKET_COMMUNITY_MESSAGE_READ: {
    vi: "Đã đánh dấu tin nhắn cộng đồng là đã đọc",
    en: "Messages marked as read",
  },
  SOCKET_COMMUNITY_REACTIONS_FETCHED: {
    vi: "Lấy danh sách cảm xúc cộng đồng thành công",
    en: "Reactions fetched successfully",
  },
  SOCKET_COMMUNITY_MESSAGE_FORWARDED: {
    vi: "Đã chuyển tiếp tin nhắn cộng đồng",
    en: "Message forwarded successfully",
  },
  SOCKET_COMMUNITY_MESSAGE_DELIVERED: {
    vi: "Đã đánh dấu tin nhắn cộng đồng là đã gửi",
    en: "Message delivery receipt recorded",
  },

  // ── /community — moderation ─────────────────────────────────────────────
  SOCKET_COMMUNITY_MEMBER_KICKED: {
    vi: "Thành viên đã bị đuổi khỏi cộng đồng",
    en: "Member kicked from the community",
  },
  SOCKET_COMMUNITY_MEMBER_BANNED: {
    vi: "Thành viên đã bị cấm",
    en: "Member banned from the community",
  },
  SOCKET_COMMUNITY_MEMBER_UNBANNED: {
    vi: "Thành viên đã được bỏ lệnh cấm",
    en: "Member unbanned successfully",
  },
  SOCKET_COMMUNITY_ADMIN_TRANSFERRED: {
    vi: "Quyền quản trị đã được chuyển",
    en: "Admin rights transferred successfully",
  },
  SOCKET_COMMUNITY_ROLE_CHANGED: {
    vi: "Vai trò thành viên đã được thay đổi",
    en: "Member role changed successfully",
  },
  SOCKET_COMMUNITY_REPORT_CREATED: {
    vi: "Báo cáo đã được gửi",
    en: "Report submitted successfully",
  },
  SOCKET_COMMUNITY_DELETED: {
    vi: "Cộng đồng đã bị xóa",
    en: "Community deleted successfully",
  },

  // ── /stream — livestream ────────────────────────────────────────────────
  SOCKET_STREAM_JOINED: {
    vi: "Đã tham gia buổi phát trực tiếp",
    en: "Joined the livestream successfully",
  },
  SOCKET_STREAM_LEFT: {
    vi: "Đã rời buổi phát trực tiếp",
    en: "Left the livestream successfully",
  },
  SOCKET_STREAM_COMMENT_POSTED: {
    vi: "Đã gửi bình luận",
    en: "Comment posted successfully",
  },
  SOCKET_STREAM_REACTED: {
    vi: "Đã thêm cảm xúc",
    en: "Reaction added successfully",
  },
  SOCKET_STREAM_LOAD_MORE: {
    vi: "Đã tải thêm bình luận",
    en: "Loaded more comments",
  },
  SOCKET_STREAM_COMMENT_DELETED: {
    vi: "Đã xóa bình luận",
    en: "Comment deleted successfully",
  },

  // ── /notify ─────────────────────────────────────────────────────────────
  SOCKET_NOTIFICATIONS_FETCHED: {
    vi: "Lấy thông báo thành công",
    en: "Notifications fetched successfully",
  },
  SOCKET_NOTIFICATIONS_MARKED_READ: {
    vi: "Đã đánh dấu thông báo là đã đọc",
    en: "Notifications marked as read",
  },
  SOCKET_NOTIFICATIONS_DELETED: {
    vi: "Đã xóa thông báo",
    en: "Notification deleted",
  },

  // ── Error acks — one default sentence per AckErrorCode ───────────────────
  SOCKET_ERR_INVALID_PAYLOAD: {
    vi: "Dữ liệu yêu cầu không hợp lệ",
    en: "The request data is invalid",
  },
  SOCKET_ERR_SERVICE: {
    vi: "Đã xảy ra lỗi, vui lòng thử lại",
    en: "Something went wrong, please try again",
  },
  SOCKET_ERR_FORBIDDEN: {
    vi: "Bạn không có quyền thực hiện hành động này",
    en: "You are not allowed to perform this action",
  },
  SOCKET_ERR_NOT_FOUND: {
    vi: "Không tìm thấy tài nguyên yêu cầu",
    en: "The requested resource was not found",
  },
  SOCKET_ERR_RATE_LIMITED: {
    vi: "Bạn thao tác quá nhanh, vui lòng chậm lại",
    en: "You are doing that too fast, please slow down",
  },
  SOCKET_ERR_CONFLICT: {
    vi: "Hành động này đã được thực hiện",
    en: "This action has already been applied",
  },
} as const satisfies MessageCatalog;

export type SocketMessageKey = keyof typeof SOCKET_MESSAGES;
