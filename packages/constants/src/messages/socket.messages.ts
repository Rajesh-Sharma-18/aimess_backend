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
    th: "เข้าร่วมการสนทนาเรียบร้อยแล้ว",
  },
  SOCKET_CONVERSATION_LEFT: {
    vi: "Đã rời cuộc trò chuyện",
    en: "Left the conversation successfully",
    th: "ออกจากการสนทนาเรียบร้อยแล้ว",
  },

  // ── /chat — messages ────────────────────────────────────────────────────
  SOCKET_MESSAGE_SENT: {
    vi: "Đã gửi tin nhắn",
    en: "Message sent successfully",
    th: "ส่งข้อความเรียบร้อยแล้ว",
  },
  SOCKET_MESSAGE_READ: {
    vi: "Đã đánh dấu tin nhắn là đã đọc",
    en: "Messages marked as read",
    th: "ทำเครื่องหมายว่าอ่านข้อความแล้ว",
  },
  SOCKET_MESSAGE_REACTED: {
    vi: "Đã thêm cảm xúc",
    en: "Reaction added successfully",
    th: "เพิ่มรีแอคชันเรียบร้อยแล้ว",
  },
  SOCKET_MESSAGES_FETCHED: {
    vi: "Lấy tin nhắn thành công",
    en: "Messages fetched successfully",
    th: "ดึงข้อความเรียบร้อยแล้ว",
  },
  SOCKET_CATCHUP_COMPLETED: {
    vi: "Đã đồng bộ tin nhắn",
    en: "Caught up successfully",
    th: "ซิงค์ข้อมูลล่าสุดเรียบร้อยแล้ว",
  },
  SOCKET_MESSAGE_EDITED: {
    vi: "Đã chỉnh sửa tin nhắn",
    en: "Message edited successfully",
    th: "แก้ไขข้อความเรียบร้อยแล้ว",
  },
  SOCKET_MESSAGE_DELIVERED: {
    vi: "Đã đánh dấu tin nhắn là đã nhận",
    en: "Messages marked as delivered",
    th: "ทำเครื่องหมายว่าส่งถึงแล้ว",
  },
  SOCKET_MESSAGE_FORWARDED: {
    vi: "Đã chuyển tiếp tin nhắn",
    en: "Message forwarded successfully",
    th: "ส่งต่อข้อความเรียบร้อยแล้ว",
  },
  SOCKET_MESSAGE_DELETED: {
    vi: "Đã xóa tin nhắn",
    en: "Message deleted",
    th: "ลบข้อความแล้ว",
  },
  SOCKET_MESSAGE_PINNED: {
    vi: "Đã ghim tin nhắn",
    en: "Message pinned",
    th: "ปักหมุดข้อความแล้ว",
  },
  SOCKET_MESSAGE_UNPINNED: {
    vi: "Đã bỏ ghim tin nhắn",
    en: "Message unpinned",
    th: "เลิกปักหมุดข้อความแล้ว",
  },
  SOCKET_REACTIONS_FETCHED: {
    vi: "Lấy danh sách cảm xúc thành công",
    en: "Reactions fetched successfully",
    th: "ดึงรีแอคชันเรียบร้อยแล้ว",
  },

  // ── /chat — presence ────────────────────────────────────────────────────
  SOCKET_PRESENCE_SUBSCRIBED: {
    vi: "Đã đăng ký nhận trạng thái hoạt động",
    en: "Subscribed to presence updates",
    th: "ติดตามสถานะออนไลน์แล้ว",
  },
  SOCKET_PRESENCE_UNSUBSCRIBED: {
    vi: "Đã hủy đăng ký trạng thái hoạt động",
    en: "Unsubscribed from presence updates",
    th: "เลิกติดตามสถานะออนไลน์แล้ว",
  },
  SOCKET_PRESENCE_UNSUBSCRIBED_ALL: {
    vi: "Đã hủy đăng ký tất cả trạng thái hoạt động",
    en: "Unsubscribed from all presence updates",
    th: "เลิกติดตามสถานะออนไลน์ทั้งหมดแล้ว",
  },
  SOCKET_PRESENCE_LIST_FETCHED: {
    vi: "Lấy danh sách theo dõi trạng thái thành công",
    en: "Presence subscription list fetched successfully",
    th: "ดึงรายการติดตามสถานะออนไลน์เรียบร้อยแล้ว",
  },

  // ── /chat — friends ─────────────────────────────────────────────────────
  SOCKET_FRIEND_REQUEST_SENT: {
    vi: "Đã gửi lời mời kết bạn",
    en: "Friend request sent",
    th: "ส่งคำขอเป็นเพื่อนแล้ว",
  },
  SOCKET_FRIEND_REQUEST_ACCEPTED: {
    vi: "Đã chấp nhận lời mời kết bạn",
    en: "Friend request accepted",
    th: "ตอบรับคำขอเป็นเพื่อนแล้ว",
  },
  SOCKET_FRIEND_REQUEST_REJECTED: {
    vi: "Đã từ chối lời mời kết bạn",
    en: "Friend request rejected",
    th: "ปฏิเสธคำขอเป็นเพื่อนแล้ว",
  },
  SOCKET_FRIEND_REMOVED: {
    vi: "Đã hủy kết bạn",
    en: "Friend removed successfully",
    th: "ลบเพื่อนเรียบร้อยแล้ว",
  },
  SOCKET_FRIEND_REQUEST_CANCELLED: {
    vi: "Đã hủy lời mời kết bạn",
    en: "Friend request cancelled",
    th: "ยกเลิกคำขอเป็นเพื่อนแล้ว",
  },

  // ── /chat — auth ────────────────────────────────────────────────────────
  SOCKET_AUTH_REFRESHED: {
    vi: "Làm mới token thành công",
    en: "Token refreshed successfully",
    th: "ต่ออายุโทเค็นเรียบร้อยแล้ว",
  },

  // ── /chat — calls ───────────────────────────────────────────────────────
  SOCKET_CALL_INITIATED: {
    vi: "Đã bắt đầu cuộc gọi",
    en: "Call initiated successfully",
    th: "เริ่มการโทรเรียบร้อยแล้ว",
  },
  SOCKET_CALL_ANSWERED: {
    vi: "Đã trả lời cuộc gọi",
    en: "Call answered successfully",
    th: "รับสายเรียบร้อยแล้ว",
  },
  SOCKET_CALL_REJOINED: {
    vi: "Đã tham gia lại cuộc gọi",
    en: "Rejoined the call successfully",
    th: "กลับเข้าร่วมการโทรเรียบร้อยแล้ว",
  },
  SOCKET_CALL_DECLINED: {
    vi: "Đã từ chối cuộc gọi",
    en: "Call declined",
    th: "ปฏิเสธสายแล้ว",
  },
  SOCKET_CALL_ENDED: {
    vi: "Đã kết thúc cuộc gọi",
    en: "Call ended",
    th: "วางสายแล้ว",
  },

  // ── /community ──────────────────────────────────────────────────────────
  SOCKET_COMMUNITY_JOINED: {
    vi: "Đã tham gia cộng đồng",
    en: "Joined the community successfully",
    th: "เข้าร่วมคอมมูนิตี้เรียบร้อยแล้ว",
  },
  SOCKET_COMMUNITY_LEFT: {
    vi: "Đã rời khỏi cộng đồng",
    en: "Left the community successfully",
    th: "ออกจากคอมมูนิตี้เรียบร้อยแล้ว",
  },
  SOCKET_COMMUNITY_MESSAGE_SENT: {
    vi: "Đã gửi tin nhắn",
    en: "Message sent successfully",
    th: "ส่งข้อความเรียบร้อยแล้ว",
  },
  SOCKET_COMMUNITY_MESSAGES_FETCHED: {
    vi: "Lấy tin nhắn cộng đồng thành công",
    en: "Community messages fetched successfully",
    th: "ดึงข้อความในคอมมูนิตี้เรียบร้อยแล้ว",
  },
  SOCKET_COMMUNITY_MESSAGE_REACTED: {
    vi: "Đã thêm cảm xúc",
    en: "Reaction added successfully",
    th: "เพิ่มรีแอคชันเรียบร้อยแล้ว",
  },
  SOCKET_COMMUNITY_CATCHUP_COMPLETED: {
    vi: "Đã đồng bộ tin nhắn",
    en: "Caught up successfully",
    th: "ซิงค์ข้อมูลล่าสุดเรียบร้อยแล้ว",
  },
  SOCKET_COMMUNITY_MESSAGE_EDITED: {
    vi: "Đã chỉnh sửa tin nhắn",
    en: "Message edited successfully",
    th: "แก้ไขข้อความเรียบร้อยแล้ว",
  },
  SOCKET_COMMUNITY_MESSAGE_DELETED: {
    vi: "Đã xóa tin nhắn",
    en: "Message deleted successfully",
    th: "ลบข้อความเรียบร้อยแล้ว",
  },
  SOCKET_COMMUNITY_MESSAGE_PINNED: {
    vi: "Đã ghim tin nhắn",
    en: "Message pinned successfully",
    th: "ปักหมุดข้อความเรียบร้อยแล้ว",
  },
  SOCKET_COMMUNITY_MESSAGE_UNPINNED: {
    vi: "Đã bỏ ghim tin nhắn",
    en: "Message unpinned successfully",
    th: "เลิกปักหมุดข้อความเรียบร้อยแล้ว",
  },
  SOCKET_COMMUNITY_MESSAGE_READ: {
    vi: "Đã đánh dấu tin nhắn cộng đồng là đã đọc",
    en: "Messages marked as read",
    th: "ทำเครื่องหมายว่าอ่านข้อความแล้ว",
  },
  SOCKET_COMMUNITY_REACTIONS_FETCHED: {
    vi: "Lấy danh sách cảm xúc cộng đồng thành công",
    en: "Reactions fetched successfully",
    th: "ดึงรีแอคชันเรียบร้อยแล้ว",
  },
  SOCKET_COMMUNITY_MESSAGE_FORWARDED: {
    vi: "Đã chuyển tiếp tin nhắn cộng đồng",
    en: "Message forwarded successfully",
    th: "ส่งต่อข้อความเรียบร้อยแล้ว",
  },
  SOCKET_COMMUNITY_MESSAGE_DELIVERED: {
    vi: "Đã đánh dấu tin nhắn cộng đồng là đã gửi",
    en: "Message delivery receipt recorded",
    th: "บันทึกการส่งถึงข้อความแล้ว",
  },

  // ── /community — moderation ─────────────────────────────────────────────
  SOCKET_COMMUNITY_MEMBER_KICKED: {
    vi: "Thành viên đã bị đuổi khỏi cộng đồng",
    en: "Member kicked from the community",
    th: "นำสมาชิกออกจากคอมมูนิตี้แล้ว",
  },
  SOCKET_COMMUNITY_MEMBER_BANNED: {
    vi: "Thành viên đã bị cấm",
    en: "Member banned from the community",
    th: "แบนสมาชิกออกจากคอมมูนิตี้แล้ว",
  },
  SOCKET_COMMUNITY_MEMBER_UNBANNED: {
    vi: "Thành viên đã được bỏ lệnh cấm",
    en: "Member unbanned successfully",
    th: "ปลดแบนสมาชิกเรียบร้อยแล้ว",
  },
  SOCKET_COMMUNITY_ADMIN_TRANSFERRED: {
    vi: "Quyền quản trị đã được chuyển",
    en: "Admin rights transferred successfully",
    th: "โอนสิทธิ์ผู้ดูแลเรียบร้อยแล้ว",
  },
  SOCKET_COMMUNITY_ROLE_CHANGED: {
    vi: "Vai trò thành viên đã được thay đổi",
    en: "Member role changed successfully",
    th: "เปลี่ยนบทบาทสมาชิกเรียบร้อยแล้ว",
  },
  SOCKET_COMMUNITY_REPORT_CREATED: {
    vi: "Báo cáo đã được gửi",
    en: "Report submitted successfully",
    th: "ส่งรายงานเรียบร้อยแล้ว",
  },
  SOCKET_COMMUNITY_DELETED: {
    vi: "Cộng đồng đã bị xóa",
    en: "Community deleted successfully",
    th: "ลบคอมมูนิตี้เรียบร้อยแล้ว",
  },

  // ── /stream — livestream ────────────────────────────────────────────────
  SOCKET_STREAM_JOINED: {
    vi: "Đã tham gia buổi phát trực tiếp",
    en: "Joined the livestream successfully",
    th: "เข้าร่วมไลฟ์สตรีมเรียบร้อยแล้ว",
  },
  SOCKET_STREAM_LEFT: {
    vi: "Đã rời buổi phát trực tiếp",
    en: "Left the livestream successfully",
    th: "ออกจากไลฟ์สตรีมเรียบร้อยแล้ว",
  },
  SOCKET_STREAM_COMMENT_POSTED: {
    vi: "Đã gửi bình luận",
    en: "Comment posted successfully",
    th: "ส่งความคิดเห็นเรียบร้อยแล้ว",
  },
  SOCKET_STREAM_REACTED: {
    vi: "Đã thêm cảm xúc",
    en: "Reaction added successfully",
    th: "เพิ่มรีแอคชันเรียบร้อยแล้ว",
  },
  SOCKET_STREAM_LOAD_MORE: {
    vi: "Đã tải thêm bình luận",
    en: "Loaded more comments",
    th: "โหลดความคิดเห็นเพิ่มเติมแล้ว",
  },
  SOCKET_STREAM_COMMENT_DELETED: {
    vi: "Đã xóa bình luận",
    en: "Comment deleted successfully",
    th: "ลบความคิดเห็นเรียบร้อยแล้ว",
  },

  // ── /notify ─────────────────────────────────────────────────────────────
  SOCKET_NOTIFICATIONS_FETCHED: {
    vi: "Lấy thông báo thành công",
    en: "Notifications fetched successfully",
    th: "ดึงการแจ้งเตือนเรียบร้อยแล้ว",
  },
  SOCKET_NOTIFICATIONS_MARKED_READ: {
    vi: "Đã đánh dấu thông báo là đã đọc",
    en: "Notifications marked as read",
    th: "ทำเครื่องหมายว่าอ่านการแจ้งเตือนแล้ว",
  },
  SOCKET_NOTIFICATIONS_DELETED: {
    vi: "Đã xóa thông báo",
    en: "Notification deleted",
    th: "ลบการแจ้งเตือนแล้ว",
  },

  // ── Error acks — one default sentence per AckErrorCode ───────────────────
  SOCKET_ERR_INVALID_PAYLOAD: {
    vi: "Dữ liệu yêu cầu không hợp lệ",
    en: "The request data is invalid",
    th: "ข้อมูลคำขอไม่ถูกต้อง",
  },
  SOCKET_ERR_SERVICE: {
    vi: "Đã xảy ra lỗi, vui lòng thử lại",
    en: "Something went wrong, please try again",
    th: "เกิดข้อผิดพลาดบางอย่าง กรุณาลองใหม่",
  },
  SOCKET_ERR_FORBIDDEN: {
    vi: "Bạn không có quyền thực hiện hành động này",
    en: "You are not allowed to perform this action",
    th: "คุณไม่ได้รับอนุญาตให้ดำเนินการนี้",
  },
  SOCKET_ERR_NOT_FOUND: {
    vi: "Không tìm thấy tài nguyên yêu cầu",
    en: "The requested resource was not found",
    th: "ไม่พบข้อมูลที่ร้องขอ",
  },
  SOCKET_ERR_RATE_LIMITED: {
    vi: "Bạn thao tác quá nhanh, vui lòng chậm lại",
    en: "You are doing that too fast, please slow down",
    th: "คุณดำเนินการเร็วเกินไป กรุณาชะลอลง",
  },
  SOCKET_ERR_CONFLICT: {
    vi: "Hành động này đã được thực hiện",
    en: "This action has already been applied",
    th: "การดำเนินการนี้ถูกทำไปแล้ว",
  },
} as const satisfies MessageCatalog;

export type SocketMessageKey = keyof typeof SOCKET_MESSAGES;
