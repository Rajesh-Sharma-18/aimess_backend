import type { MessageCatalog } from "./types.js";

/** Chat-service API messages (private, group, community, media, friendship gate). */
export const CHAT_MESSAGES = {
  // --- GET success ---
  CHAT_CONVERSATIONS_FETCHED: {
    vi: "Lấy danh sách cuộc trò chuyện thành công",
    en: "Conversations fetched successfully",
    th: "ดึงรายการสนทนาเรียบร้อยแล้ว",
  },
  CHAT_ROOM_DETAILS_FETCHED: {
    vi: "Lấy thông tin cuộc trò chuyện thành công",
    en: "Private room details fetched successfully.",
    th: "ดึงรายละเอียดห้องแชทส่วนตัวเรียบร้อยแล้ว",
  },
  CHAT_INBOX_FETCHED: {
    vi: "Lấy danh sách hộp thư thành công",
    en: "Inbox fetched successfully",
    th: "ดึงกล่องข้อความเรียบร้อยแล้ว",
  },
  CHAT_MESSAGES_FETCHED: {
    vi: "Lấy tin nhắn thành công",
    en: "Messages fetched successfully",
    th: "ดึงข้อความเรียบร้อยแล้ว",
  },
  CHAT_MESSAGES_SEARCHED: {
    vi: "Tìm kiếm tin nhắn thành công",
    en: "Messages searched successfully",
    th: "ค้นหาข้อความเรียบร้อยแล้ว",
  },
  CHAT_PINS_FETCHED: {
    vi: "Lấy danh sách ghim thành công",
    en: "Pins fetched successfully",
    th: "ดึงข้อความที่ปักหมุดเรียบร้อยแล้ว",
  },
  CHAT_GROUPS_FETCHED: {
    vi: "Lấy danh sách nhóm thành công",
    en: "Groups fetched successfully",
    th: "ดึงรายการกลุ่มเรียบร้อยแล้ว",
  },
  CHAT_GROUP_FETCHED: {
    vi: "Lấy thông tin nhóm thành công",
    en: "Group fetched successfully",
    th: "ดึงข้อมูลกลุ่มเรียบร้อยแล้ว",
  },
  CHAT_MEMBERS_FETCHED: {
    vi: "Lấy danh sách thành viên thành công",
    en: "Members fetched successfully",
    th: "ดึงรายชื่อสมาชิกเรียบร้อยแล้ว",
  },
  CHAT_INVITE_LINK_PREVIEW_FETCHED: {
    vi: "Lấy thông tin liên kết mời thành công",
    en: "Invite link preview fetched successfully",
    th: "ดึงตัวอย่างลิงก์เชิญเรียบร้อยแล้ว",
  },
  CHAT_INVITE_LINKS_FETCHED: {
    vi: "Lấy danh sách liên kết mời thành công",
    en: "Invite links fetched successfully",
    th: "ดึงรายการลิงก์เชิญเรียบร้อยแล้ว",
  },
  CHAT_NOTIFICATIONS_FETCHED: {
    vi: "Lấy thông báo thành công",
    en: "Notifications fetched successfully",
    th: "ดึงการแจ้งเตือนเรียบร้อยแล้ว",
  },
  CHAT_UNREAD_COUNT_FETCHED: {
    vi: "Lấy số lượng chưa đọc thành công",
    en: "Unread count fetched successfully",
    th: "ดึงจำนวนข้อความที่ยังไม่อ่านเรียบร้อยแล้ว",
  },
  CHAT_NOTIFICATIONS_MARKED_READ: {
    vi: "Đánh dấu thông báo đã đọc thành công",
    en: "Notifications marked as read",
    th: "ทำเครื่องหมายว่าอ่านการแจ้งเตือนแล้ว",
  },
  CHAT_NOTIFICATION_DELETED: {
    vi: "Đã xóa thông báo",
    en: "Notification deleted",
    th: "ลบการแจ้งเตือนแล้ว",
  },
  CHAT_COMMUNITY_ROOMS_FETCHED: {
    vi: "Lấy danh sách phòng cộng đồng thành công",
    en: "Community rooms fetched successfully",
    th: "ดึงห้องคอมมูนิตี้เรียบร้อยแล้ว",
  },
  CHAT_COMMUNITY_ROOMS_SEARCHED: {
    vi: "Tìm kiếm phòng cộng đồng thành công",
    en: "Community rooms searched successfully",
    th: "ค้นหาห้องคอมมูนิตี้เรียบร้อยแล้ว",
  },
  CHAT_COMMUNITY_MESSAGES_FETCHED: {
    vi: "Lấy tin nhắn cộng đồng thành công",
    en: "Community messages fetched successfully",
    th: "ดึงข้อความในคอมมูนิตี้เรียบร้อยแล้ว",
  },

  // --- GET empty data ---
  CHAT_NO_CONVERSATIONS_FOUND: {
    vi: "Không tìm thấy cuộc trò chuyện nào",
    en: "No conversations found",
    th: "ไม่พบการสนทนา",
  },
  CHAT_NO_INBOX_FOUND: {
    vi: "Không tìm thấy cuộc trò chuyện hoặc nhóm nào",
    en: "No conversations or groups found",
    th: "ไม่พบการสนทนาหรือกลุ่ม",
  },
  CHAT_NO_MESSAGES_FOUND: {
    vi: "Không tìm thấy tin nhắn nào",
    en: "No messages found",
    th: "ไม่พบข้อความ",
  },
  CHAT_NO_PINS_FOUND: {
    vi: "Không tìm thấy ghim nào",
    en: "No pins found",
    th: "ไม่พบข้อความที่ปักหมุด",
  },
  CHAT_NO_GROUPS_FOUND: {
    vi: "Không tìm thấy nhóm nào",
    en: "No groups found",
    th: "ไม่พบกลุ่ม",
  },
  CHAT_NO_MEMBERS_FOUND: {
    vi: "Không tìm thấy thành viên nào",
    en: "No members found",
    th: "ไม่พบสมาชิก",
  },
  CHAT_NO_COMMUNITY_ROOMS_FOUND: {
    vi: "Không tìm thấy phòng cộng đồng nào",
    en: "No community rooms found",
    th: "ไม่พบห้องคอมมูนิตี้",
  },
  CHAT_NO_COMMUNITY_MESSAGES_FOUND: {
    vi: "Không tìm thấy tin nhắn cộng đồng nào",
    en: "No community messages found",
    th: "ไม่พบข้อความในคอมมูนิตี้",
  },
  CHAT_NO_INVITE_LINKS_FOUND: {
    vi: "Không tìm thấy liên kết mời nào",
    en: "No invite links found",
    th: "ไม่พบลิงก์เชิญ",
  },
  CHAT_NO_NOTIFICATIONS_FOUND: {
    vi: "Không tìm thấy thông báo nào",
    en: "No notifications found",
    th: "ไม่พบการแจ้งเตือน",
  },

  // --- Mutation success ---
  CHAT_MESSAGE_SENT: {
    vi: "Đã gửi tin nhắn",
    en: "Message sent",
    th: "ส่งข้อความแล้ว",
  },
  CHAT_MESSAGE_FORWARDED: {
    vi: "Đã chuyển tiếp tin nhắn",
    en: "Message forwarded",
    th: "ส่งต่อข้อความแล้ว",
  },
  CHAT_MESSAGE_EDITED: {
    vi: "Đã chỉnh sửa tin nhắn",
    en: "Message edited",
    th: "แก้ไขข้อความแล้ว",
  },
  CHAT_MESSAGE_REACTED: {
    vi: "Đã thả cảm xúc",
    en: "Reaction updated",
    th: "อัปเดตรีแอคชันแล้ว",
  },
  CHAT_MESSAGE_PINNED: {
    vi: "Đã ghim tin nhắn",
    en: "Message pinned",
    th: "ปักหมุดข้อความแล้ว",
  },
  CHAT_MESSAGE_UNPINNED: {
    vi: "Đã bỏ ghim tin nhắn",
    en: "Message unpinned",
    th: "เลิกปักหมุดข้อความแล้ว",
  },
  CHAT_MESSAGE_REPORTED: {
    vi: "Đã báo cáo tin nhắn",
    en: "Message reported",
    th: "รายงานข้อความแล้ว",
  },
  CHAT_ROOM_MUTED: {
    vi: "Đã tắt thông báo cuộc trò chuyện",
    en: "Conversation muted",
    th: "ปิดเสียงการสนทนาแล้ว",
  },
  CHAT_ROOM_UNMUTED: {
    vi: "Đã bật thông báo cuộc trò chuyện",
    en: "Conversation unmuted",
    th: "เปิดเสียงการสนทนาแล้ว",
  },
  CHAT_CONVERSATIONS_BULK_LEFT: {
    vi: "Đã xử lý xong yêu cầu rời/xóa nhiều cuộc trò chuyện",
    en: "Bulk conversation leave processed",
    th: "ดำเนินการออกจากการสนทนาหลายรายการแล้ว",
  },
  CHAT_CONVERSATIONS_BULK_READ: {
    vi: "Đã đánh dấu các cuộc trò chuyện là đã đọc",
    en: "Conversations marked as read",
    th: "ทำเครื่องหมายว่าอ่านการสนทนาแล้ว",
  },
  CHAT_ROOM_ARCHIVED: {
    vi: "Đã lưu trữ cuộc trò chuyện",
    en: "Conversation archived",
    th: "เก็บการสนทนาเข้าคลังแล้ว",
  },
  CHAT_AUTO_DELETE_FETCHED: {
    vi: "Lấy cài đặt tự động xóa tin nhắn thành công",
    en: "Auto-delete setting fetched successfully",
    th: "ดึงการตั้งค่าลบข้อความอัตโนมัติเรียบร้อยแล้ว",
  },
  CHAT_AUTO_DELETE_UPDATED: {
    vi: "Đã cập nhật cài đặt tự động xóa tin nhắn",
    en: "Auto-delete setting updated",
    th: "อัปเดตการตั้งค่าลบข้อความอัตโนมัติแล้ว",
  },
  CHAT_AUTO_DELETE_INVALID_MODE: {
    vi: "Chế độ tự động xóa không hợp lệ",
    en: "Invalid auto-delete mode",
    th: "โหมดลบข้อความอัตโนมัติไม่ถูกต้อง",
  },
  CHAT_AUTO_DELETE_INVALID_TTL: {
    vi: "Thời gian tự động xóa không hợp lệ",
    en: "Invalid auto-delete duration",
    th: "ระยะเวลาลบข้อความอัตโนมัติไม่ถูกต้อง",
  },
  CHAT_ROOM_UNARCHIVED: {
    vi: "Đã bỏ lưu trữ cuộc trò chuyện",
    en: "Conversation unarchived",
    th: "นำการสนทนาออกจากคลังแล้ว",
  },
  CHAT_REACTIONS_FETCHED: {
    vi: "Lấy danh sách cảm xúc thành công",
    en: "Reactions fetched successfully",
    th: "ดึงรีแอคชันเรียบร้อยแล้ว",
  },
  CHAT_CONVERSATION_DELETED: {
    vi: "Đã xóa cuộc trò chuyện",
    en: "Conversation deleted",
    th: "ลบการสนทนาแล้ว",
  },
  CHAT_CLEARED: {
    vi: "Đã xóa nội dung trò chuyện",
    en: "Chat cleared",
    th: "ล้างแชทแล้ว",
  },
  CHAT_MESSAGE_DELETED_FOR_YOU: {
    vi: "Đã xóa tin nhắn cho bạn",
    en: "Message deleted for you",
    th: "ลบข้อความสำหรับคุณแล้ว",
  },
  CHAT_NOTIFICATIONS_ALL_READ: {
    vi: "Đã đánh dấu tất cả là đã đọc",
    en: "All notifications marked as read",
    th: "ทำเครื่องหมายว่าอ่านการแจ้งเตือนทั้งหมดแล้ว",
  },
  CHAT_GROUP_DISBANDED: {
    vi: "Đã giải tán nhóm",
    en: "Group disbanded",
    th: "ยุบกลุ่มแล้ว",
  },
  // Banner copy + write denial for a group closed because its admin/owner was
  // permanently system-banned. Unlike a disband the room is NOT hidden: it
  // stays in every member's list and stays readable, but nobody can write.
  CHAT_GROUP_CLOSED_ADMIN_BANNED: {
    vi: "Quản trị viên của nhóm này đã bị cấm. Nhóm này không còn khả dụng",
    en: "The admin of this group has been banned. This group is no longer available.",
    th: "ผู้ดูแลกลุ่มนี้ถูกแบน กลุ่มนี้ไม่พร้อมใช้งานอีกต่อไป",
  },
  // Write denial in a 1:1 conversation where either party is system-banned.
  // The conversation itself stays visible with its full history — only new
  // interaction is blocked.
  CHAT_PEER_BANNED: {
    vi: "Người dùng này đã bị cấm và không thể tham gia hội thoại",
    en: "This user has been banned and can no longer participate in conversations.",
    th: "ผู้ใช้รายนี้ถูกแบนและไม่สามารถร่วมสนทนาได้อีกต่อไป",
  },
  CHAT_GROUP_LEFT: {
    vi: "Đã rời nhóm",
    en: "Left the group",
    th: "ออกจากกลุ่มแล้ว",
  },
  CHAT_ROOM_JOINED: {
    vi: "Đã tham gia phòng",
    en: "Joined the room",
    th: "เข้าร่วมห้องแล้ว",
  },
  CHAT_ROOM_LEFT: {
    vi: "Đã rời phòng",
    en: "Left the room",
    th: "ออกจากห้องแล้ว",
  },

  // --- Rooms / messages ---
  CHAT_ROOM_NOT_FOUND: {
    vi: "Không tìm thấy phòng",
    en: "Room not found",
    th: "ไม่พบห้อง",
  },
  CHAT_MESSAGE_NOT_FOUND: {
    vi: "Không tìm thấy tin nhắn",
    en: "Message not found",
    th: "ไม่พบข้อความ",
  },
  CHAT_INVALID_CONVERSATION_TYPE: {
    vi: "Loại cuộc trò chuyện không hợp lệ",
    en: "Invalid conversation type",
    th: "ประเภทการสนทนาไม่ถูกต้อง",
  },
  CHAT_DELETE_OWN_MESSAGES_ONLY: {
    vi: "Bạn chỉ có thể xóa tin nhắn của mình",
    en: "You can only delete your own messages",
    th: "คุณลบได้เฉพาะข้อความของตัวเองเท่านั้น",
  },
  CHAT_EDIT_OWN_MESSAGES_ONLY: {
    vi: "Bạn chỉ có thể chỉnh sửa tin nhắn của mình",
    en: "You can only edit your own messages",
    th: "คุณแก้ไขได้เฉพาะข้อความของตัวเองเท่านั้น",
  },
  CHAT_EDIT_TEXT_ONLY: {
    vi: "Chỉ có thể chỉnh sửa tin nhắn văn bản",
    en: "Only text messages can be edited",
    th: "แก้ไขได้เฉพาะข้อความตัวอักษรเท่านั้น",
  },
  CHAT_MESSAGE_ALREADY_DELETED: {
    vi: "Tin nhắn đã bị xóa",
    en: "Message already deleted",
    th: "ข้อความนี้ถูกลบไปแล้ว",
  },
  CHAT_SYSTEM_MESSAGE_IMMUTABLE: {
    vi: "Không thể xóa tin nhắn hệ thống",
    en: "System messages cannot be deleted",
    th: "ไม่สามารถลบข้อความระบบได้",
  },
  CHAT_INVALID_MESSAGE_TYPE: {
    vi: "Loại tin nhắn không hợp lệ",
    en: "Invalid message type",
    th: "ประเภทข้อความไม่ถูกต้อง",
  },
  CHAT_REACTION_CONFLICT: {
    vi: "Không thể cập nhật cảm xúc do xung đột, vui lòng thử lại",
    en: "Couldn't update reaction due to a conflict, please try again",
    th: "ไม่สามารถอัปเดตรีแอคชันได้เนื่องจากข้อมูลขัดแย้งกัน กรุณาลองใหม่",
  },
  CHAT_REPORT_NOT_PARTICIPANT: {
    vi: "Bạn không phải là thành viên của cuộc trò chuyện này",
    en: "You are not a participant in this conversation",
    th: "คุณไม่ได้อยู่ในการสนทนานี้",
  },
  CHAT_REPORT_OWN_MESSAGE: {
    vi: "Bạn không thể báo cáo tin nhắn của chính mình",
    en: "You cannot report your own message",
    th: "คุณไม่สามารถรายงานข้อความของตัวเองได้",
  },
  CHAT_ALREADY_REPORTED: {
    vi: "Bạn đã báo cáo tin nhắn này rồi",
    en: "You have already reported this message",
    th: "คุณรายงานข้อความนี้ไปแล้ว",
  },
  CHAT_NOT_A_PARTICIPANT: {
    vi: "Bạn không phải là thành viên của cuộc trò chuyện này",
    en: "You are not a participant in this conversation",
    th: "คุณไม่ได้อยู่ในการสนทนานี้",
  },
  CHAT_BANNED_FROM_ROOM: {
    vi: "Bạn đã bị cấm khỏi phòng này",
    en: "You are banned from this room",
    th: "คุณถูกแบนจากห้องนี้",
  },
  CHAT_MUTED_IN_COMMUNITY: {
    vi: "Bạn đang bị tắt tiếng trong cộng đồng này và không thể gửi tin nhắn",
    en: "You are muted in this community and cannot post messages",
    th: "คุณถูกปิดสิทธิ์พูดในคอมมูนิตี้นี้ จึงไม่สามารถส่งข้อความได้",
  },
  CHAT_MUTED_IN_GROUP: {
    vi: "Bạn đang bị tắt tiếng trong nhóm này và không thể gửi tin nhắn",
    en: "You are muted in this group and cannot post messages",
    th: "คุณถูกปิดสิทธิ์พูดในกลุ่มนี้ จึงไม่สามารถส่งข้อความได้",
  },
  CHAT_MEMBER_NOT_MUTED: {
    vi: "Thành viên này hiện không bị tắt tiếng",
    en: "This member is not currently muted",
    th: "สมาชิกรายนี้ไม่ได้ถูกปิดสิทธิ์พูดอยู่",
  },
  CHAT_CANNOT_MUTE_SELF: {
    vi: "Bạn không thể tự tắt tiếng chính mình",
    en: "You cannot mute yourself",
    th: "คุณไม่สามารถปิดสิทธิ์พูดของตัวเองได้",
  },

  // --- Friendship gate ---
  CHAT_FRIENDSHIP_REQUIRED: {
    vi: "Bạn phải là bạn bè để nhắn tin cho người dùng này",
    en: "You must be friends to message this user",
    th: "คุณต้องเป็นเพื่อนกันก่อนจึงจะส่งข้อความหาผู้ใช้รายนี้ได้",
  },
  CHAT_BLOCKED: {
    vi: "Không thể gửi tin nhắn cho người dùng bị chặn",
    en: "Cannot send messages to a blocked user",
    th: "ไม่สามารถส่งข้อความถึงผู้ใช้ที่ถูกบล็อกได้",
  },

  // --- Call permission gate ---
  // Keys match the `AppError.messageKey` thrown by chat-service's call
  // authorization verbatim: the gateway forwards that key as the gRPC detail and
  // `ackError` resolves it here, so a refused call reaches the client as a
  // finished sentence instead of the generic "forbidden" fallback.
  FRIENDSHIP_REQUIRED: {
    vi: "Chỉ có thể gọi giữa những người bạn bè",
    en: "Calls are only available between friends.",
    th: "การโทรใช้ได้เฉพาะระหว่างเพื่อนเท่านั้น",
  },
  PRIVACY_BLOCKED: {
    vi: "Người dùng này không nhận cuộc gọi từ bạn",
    en: "This user is not accepting calls from you.",
    th: "ผู้ใช้รายนี้ไม่รับสายจากคุณ",
  },
  CALL_BLOCKED: {
    vi: "Không thể gọi cho người dùng bị chặn",
    en: "You cannot call a blocked user.",
    th: "คุณไม่สามารถโทรหาผู้ใช้ที่ถูกบล็อกได้",
  },
  CALLING_DISABLED: {
    vi: "Tính năng gọi hiện không khả dụng",
    en: "Calling is currently unavailable.",
    th: "ขณะนี้ไม่สามารถใช้งานการโทรได้",
  },
  CALL_USER_UNAVAILABLE: {
    vi: "Tài khoản này không còn tồn tại",
    en: "This account is no longer available.",
    th: "บัญชีนี้ไม่พร้อมใช้งานอีกต่อไป",
  },
  CALL_SELF_NOT_ALLOWED: {
    vi: "Bạn không thể tự gọi cho chính mình",
    en: "You cannot call yourself.",
    th: "คุณไม่สามารถโทรหาตัวเองได้",
  },
  CALL_TARGET_REQUIRED: {
    vi: "Thiếu người nhận cuộc gọi",
    en: "A call recipient is required.",
    th: "ต้องระบุผู้รับสาย",
  },

  // --- Pins ---
  CHAT_PIN_LIMIT_REACHED: {
    vi: "Đã đạt giới hạn ghim cho phòng này",
    en: "Pin limit reached for this room",
    th: "ปักหมุดในห้องนี้ครบจำนวนสูงสุดแล้ว",
  },
  CHAT_PIN_NOT_FOUND: {
    vi: "Không tìm thấy ghim",
    en: "Pin not found",
    th: "ไม่พบข้อความที่ปักหมุด",
  },
  CHAT_UNPIN_OWN_ONLY: {
    vi: "Bạn chỉ có thể bỏ ghim các ghim do bạn tạo",
    en: "You can only unpin pins created by you",
    th: "คุณเลิกปักหมุดได้เฉพาะหมุดที่คุณสร้างเองเท่านั้น",
  },
  // --- Groups ---
  CHAT_GROUP_NOT_FOUND: {
    vi: "Không tìm thấy nhóm",
    en: "Group not found",
    th: "ไม่พบกลุ่ม",
  },
  CHAT_GROUP_NO_LONGER_EXISTS: {
    vi: "Nhóm không còn tồn tại",
    en: "Group no longer exists",
    th: "กลุ่มนี้ไม่มีอยู่แล้ว",
  },
  CHAT_NOT_A_MEMBER: {
    vi: "Bạn không phải là thành viên của nhóm này",
    en: "You are not a member of this group",
    th: "คุณไม่ได้เป็นสมาชิกของกลุ่มนี้",
  },
  CHAT_ALREADY_MEMBER: {
    vi: "Đã là thành viên",
    en: "Already a member",
    th: "เป็นสมาชิกอยู่แล้ว",
  },
  CHAT_GROUP_MEMBER_LIMIT_REACHED: {
    vi: "Đã đạt giới hạn thành viên của nhóm",
    en: "Group member limit reached",
    th: "กลุ่มมีสมาชิกครบจำนวนสูงสุดแล้ว",
  },
  CHAT_OWNER_CANNOT_LEAVE: {
    vi: "Quản trị viên không thể rời đi. Hãy chỉ định quản trị viên khác hoặc giải tán nhóm.",
    en: "Admin cannot leave. Make someone else admin or disband the group.",
    th: "ผู้ดูแลไม่สามารถออกจากกลุ่มได้ กรุณาตั้งสมาชิกคนอื่นเป็นผู้ดูแลหรือยุบกลุ่ม",
  },
  CHAT_CANNOT_KICK_HIGHER_ROLE: {
    vi: "Không thể loại thành viên có vai trò bằng hoặc cao hơn",
    en: "Cannot remove a member with an equal or higher role",
    th: "ไม่สามารถนำสมาชิกที่มีบทบาทเท่ากันหรือสูงกว่าออกได้",
  },
  CHAT_CANNOT_CHANGE_OWN_ROLE: {
    vi: "Bạn không thể tự thay đổi vai trò của mình",
    en: "You cannot change your own role",
    th: "คุณไม่สามารถเปลี่ยนบทบาทของตัวเองได้",
  },
  CHAT_INSUFFICIENT_PERMISSIONS: {
    vi: "Bạn không có đủ quyền để thực hiện hành động này",
    en: "Insufficient permissions to perform this action",
    th: "สิทธิ์ไม่เพียงพอสำหรับการดำเนินการนี้",
  },
  CHAT_ONLY_OWNER_ADMIN_UPDATE: {
    vi: "Chỉ quản trị viên mới có thể cập nhật nhóm",
    en: "Only the admin can update the group",
    th: "เฉพาะผู้ดูแลเท่านั้นที่แก้ไขข้อมูลกลุ่มได้",
  },
  CHAT_ONLY_OWNER_DISBAND: {
    vi: "Chỉ quản trị viên mới có thể giải tán nhóm",
    en: "Only the admin can disband the group",
    th: "เฉพาะผู้ดูแลเท่านั้นที่ยุบกลุ่มได้",
  },

  // --- Invite links ---
  CHAT_INVITE_LINK_NOT_FOUND: {
    vi: "Không tìm thấy liên kết mời hoặc đã hết hạn",
    en: "Invite link not found or expired",
    th: "ไม่พบลิงก์เชิญหรือลิงก์หมดอายุแล้ว",
  },
  CHAT_INVITE_LINK_EXPIRED: {
    vi: "Liên kết mời đã hết hạn",
    // Product-fixed copy — the client shows this verbatim on the invite screen.
    en: "Invitation link expired",
    th: "ลิงก์เชิญหมดอายุแล้ว",
  },
  /**
   * A user removed (kicked) or banned by group staff who tries to come back
   * through an invite link. Deliberately distinct from
   * CHAT_GROUP_MEMBER_LIMIT_REACHED and CHAT_INVITE_LINK_EXPIRED — the three
   * refusals must never be confusable on the button or in a toast.
   */
  CHAT_JOIN_BLOCKED: {
    vi: "Bạn không thể tham gia nhóm này",
    en: "You can't join this group",
    th: "คุณไม่สามารถเข้าร่วมกลุ่มนี้ได้",
  },
  CHAT_INVITE_LINK_USAGE_LIMIT: {
    vi: "Liên kết mời đã đạt giới hạn sử dụng",
    en: "Invite link usage limit reached",
    th: "ลิงก์เชิญถูกใช้ครบจำนวนแล้ว",
  },
  /**
   * Thrown by `group-invite-link.service.ts` as a `TooManyRequestsError`. The
   * key had no catalog entry, so `t()` echoed it back and the user was shown
   * the literal string "CHAT_GROUP_INVITE_RATE_LIMITED".
   */
  CHAT_GROUP_INVITE_RATE_LIMITED: {
    vi: "Bạn đang tạo liên kết mời nhóm quá nhanh. Vui lòng thử lại sau.",
    en: "You are creating group invite links too quickly. Please try again later.",
    th: "คุณสร้างลิงก์เชิญกลุ่มเร็วเกินไป กรุณาลองใหม่ภายหลัง",
  },
  CHAT_MEMBERS_CANNOT_CREATE_LINKS: {
    vi: "Thành viên không được phép tạo liên kết mời",
    en: "Members are not allowed to create invite links",
    th: "สมาชิกทั่วไปไม่ได้รับอนุญาตให้สร้างลิงก์เชิญ",
  },

  // --- Media ---
  CHAT_UPLOAD_REQUEST_INVALID: {
    vi: "Yêu cầu không hợp lệ: cần filename (chuỗi) và contentType (loại MIME được phép)",
    en: "Invalid request: filename (string) and contentType (allowed MIME type) are required",
    th: "คำขอไม่ถูกต้อง: ต้องระบุ filename (ข้อความ) และ contentType (ชนิด MIME ที่อนุญาต)",
  },
  CHAT_DOWNLOAD_REQUEST_INVALID: {
    vi: "Yêu cầu không hợp lệ: cần objectKey (chuỗi)",
    en: "Invalid request: objectKey (string) is required",
    th: "คำขอไม่ถูกต้อง: ต้องระบุ objectKey (ข้อความ)",
  },
  CHAT_INVALID_OBJECT_KEY: {
    vi: "Khóa đối tượng không hợp lệ",
    en: "Invalid object key",
    th: "คีย์ไฟล์ไม่ถูกต้อง",
  },

  // --- Media attachment limits (private / group / community send) ---
  CHAT_IMAGE_COUNT_EXCEEDED: {
    vi: "Chỉ được gửi tối đa 10 ảnh",
    en: "Maximum 10 images allowed",
    th: "แนบรูปภาพได้สูงสุด 10 รูป",
  },
  CHAT_IMAGE_TOO_LARGE: {
    vi: "Ảnh vượt quá dung lượng cho phép (25 MB)",
    en: "Image exceeds 25 MB",
    th: "รูปภาพมีขนาดเกิน 25 MB",
  },
  CHAT_VIDEO_TOO_LARGE: {
    vi: "Video vượt quá dung lượng cho phép (100 MB)",
    en: "Video exceeds 100 MB",
    th: "วิดีโอมีขนาดเกิน 100 MB",
  },
  CHAT_AUDIO_TOO_LARGE: {
    vi: "Tệp âm thanh vượt quá dung lượng cho phép (25 MB)",
    en: "Audio exceeds 25 MB",
    th: "ไฟล์เสียงมีขนาดเกิน 25 MB",
  },
  CHAT_DOCUMENT_TOO_LARGE: {
    vi: "Tài liệu vượt quá dung lượng cho phép (25 MB)",
    en: "Document exceeds 25 MB",
    th: "เอกสารมีขนาดเกิน 25 MB",
  },
  CHAT_FILE_TOO_LARGE: {
    vi: "Tệp vượt quá dung lượng cho phép",
    en: "File exceeds the maximum allowed size",
    th: "ไฟล์มีขนาดเกินกว่าที่กำหนด",
  },
  CHAT_UNSUPPORTED_CONTENT_TYPE: {
    vi: "Loại tệp không được hỗ trợ",
    en: "Unsupported file type",
    th: "ไม่รองรับไฟล์ประเภทนี้",
  },

  // --- Generic / error-handler ---
  CHAT_INVALID_ID_FORMAT: {
    vi: "Định dạng ID không hợp lệ",
    en: "Invalid ID format",
    th: "รูปแบบรหัสไม่ถูกต้อง",
  },
  CHAT_INVALID_REFERENCE: {
    vi: "Tài nguyên được tham chiếu không tồn tại",
    en: "Referenced resource does not exist",
    th: "ไม่พบข้อมูลที่อ้างอิงถึง",
  },
  CHAT_RESOURCE_CONFLICT: {
    vi: "Đã tồn tại bản ghi với thông tin này",
    en: "A record with these details already exists",
    th: "มีข้อมูลที่ตรงกันนี้อยู่แล้ว",
  },
  CHAT_NOT_FOUND: {
    vi: "Không tìm thấy tài nguyên yêu cầu",
    en: "Requested resource was not found",
    th: "ไม่พบข้อมูลที่ร้องขอ",
  },
  CHAT_REQUEST_FAILED: {
    vi: "Không thể xử lý yêu cầu",
    en: "The request could not be processed",
    th: "ไม่สามารถดำเนินการตามคำขอได้",
  },
  CHAT_INVALID_REQUEST: {
    vi: "Dữ liệu yêu cầu không hợp lệ",
    en: "Invalid request data",
    th: "ข้อมูลคำขอไม่ถูกต้อง",
  },
  CHAT_INVALID_JSON_BODY: {
    vi: "Nội dung JSON không hợp lệ",
    en: "Invalid JSON body",
    th: "เนื้อหา JSON ไม่ถูกต้อง",
  },
  CHAT_INTERNAL_ERROR: {
    vi: "Lỗi máy chủ nội bộ",
    en: "Internal server error",
    th: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์",
  },
} as const satisfies MessageCatalog;

export type ChatMessageKey = keyof typeof CHAT_MESSAGES;
