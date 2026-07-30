import type { MessageCatalog } from "./types.js";

/** Chat-service API messages (private, group, community, media, friendship gate). */
export const CHAT_MESSAGES = {
  // --- GET success ---
  CHAT_CONVERSATIONS_FETCHED: {
    vi: "Lấy danh sách cuộc trò chuyện thành công",
    en: "Conversations fetched successfully",
  },
  CHAT_ROOM_DETAILS_FETCHED: {
    vi: "Lấy thông tin cuộc trò chuyện thành công",
    en: "Private room details fetched successfully.",
  },
  CHAT_INBOX_FETCHED: {
    vi: "Lấy danh sách hộp thư thành công",
    en: "Inbox fetched successfully",
  },
  CHAT_MESSAGES_FETCHED: {
    vi: "Lấy tin nhắn thành công",
    en: "Messages fetched successfully",
  },
  CHAT_MESSAGES_SEARCHED: {
    vi: "Tìm kiếm tin nhắn thành công",
    en: "Messages searched successfully",
  },
  CHAT_PINS_FETCHED: {
    vi: "Lấy danh sách ghim thành công",
    en: "Pins fetched successfully",
  },
  CHAT_GROUPS_FETCHED: {
    vi: "Lấy danh sách nhóm thành công",
    en: "Groups fetched successfully",
  },
  CHAT_GROUP_FETCHED: {
    vi: "Lấy thông tin nhóm thành công",
    en: "Group fetched successfully",
  },
  CHAT_MEMBERS_FETCHED: {
    vi: "Lấy danh sách thành viên thành công",
    en: "Members fetched successfully",
  },
  CHAT_INVITE_LINK_PREVIEW_FETCHED: {
    vi: "Lấy thông tin liên kết mời thành công",
    en: "Invite link preview fetched successfully",
  },
  CHAT_INVITE_LINKS_FETCHED: {
    vi: "Lấy danh sách liên kết mời thành công",
    en: "Invite links fetched successfully",
  },
  CHAT_NOTIFICATIONS_FETCHED: {
    vi: "Lấy thông báo thành công",
    en: "Notifications fetched successfully",
  },
  CHAT_UNREAD_COUNT_FETCHED: {
    vi: "Lấy số lượng chưa đọc thành công",
    en: "Unread count fetched successfully",
  },
  CHAT_NOTIFICATIONS_MARKED_READ: {
    vi: "Đánh dấu thông báo đã đọc thành công",
    en: "Notifications marked as read",
  },
  CHAT_COMMUNITY_ROOMS_FETCHED: {
    vi: "Lấy danh sách phòng cộng đồng thành công",
    en: "Community rooms fetched successfully",
  },
  CHAT_COMMUNITY_ROOMS_SEARCHED: {
    vi: "Tìm kiếm phòng cộng đồng thành công",
    en: "Community rooms searched successfully",
  },
  CHAT_COMMUNITY_MESSAGES_FETCHED: {
    vi: "Lấy tin nhắn cộng đồng thành công",
    en: "Community messages fetched successfully",
  },

  // --- GET empty data ---
  CHAT_NO_CONVERSATIONS_FOUND: {
    vi: "Không tìm thấy cuộc trò chuyện nào",
    en: "No conversations found",
  },
  CHAT_NO_INBOX_FOUND: {
    vi: "Không tìm thấy cuộc trò chuyện hoặc nhóm nào",
    en: "No conversations or groups found",
  },
  CHAT_NO_MESSAGES_FOUND: {
    vi: "Không tìm thấy tin nhắn nào",
    en: "No messages found",
  },
  CHAT_NO_PINS_FOUND: {
    vi: "Không tìm thấy ghim nào",
    en: "No pins found",
  },
  CHAT_NO_GROUPS_FOUND: {
    vi: "Không tìm thấy nhóm nào",
    en: "No groups found",
  },
  CHAT_NO_MEMBERS_FOUND: {
    vi: "Không tìm thấy thành viên nào",
    en: "No members found",
  },
  CHAT_NO_COMMUNITY_ROOMS_FOUND: {
    vi: "Không tìm thấy phòng cộng đồng nào",
    en: "No community rooms found",
  },
  CHAT_NO_COMMUNITY_MESSAGES_FOUND: {
    vi: "Không tìm thấy tin nhắn cộng đồng nào",
    en: "No community messages found",
  },
  CHAT_NO_INVITE_LINKS_FOUND: {
    vi: "Không tìm thấy liên kết mời nào",
    en: "No invite links found",
  },
  CHAT_NO_NOTIFICATIONS_FOUND: {
    vi: "Không tìm thấy thông báo nào",
    en: "No notifications found",
  },

  // --- Mutation success ---
  CHAT_MESSAGE_SENT: {
    vi: "Đã gửi tin nhắn",
    en: "Message sent",
  },
  CHAT_MESSAGE_FORWARDED: {
    vi: "Đã chuyển tiếp tin nhắn",
    en: "Message forwarded",
  },
  CHAT_MESSAGE_EDITED: {
    vi: "Đã chỉnh sửa tin nhắn",
    en: "Message edited",
  },
  CHAT_MESSAGE_REACTED: {
    vi: "Đã thả cảm xúc",
    en: "Reaction updated",
  },
  CHAT_MESSAGE_PINNED: {
    vi: "Đã ghim tin nhắn",
    en: "Message pinned",
  },
  CHAT_MESSAGE_UNPINNED: {
    vi: "Đã bỏ ghim tin nhắn",
    en: "Message unpinned",
  },
  CHAT_MESSAGE_REPORTED: {
    vi: "Đã báo cáo tin nhắn",
    en: "Message reported",
  },
  CHAT_ROOM_MUTED: {
    vi: "Đã tắt thông báo cuộc trò chuyện",
    en: "Conversation muted",
  },
  CHAT_ROOM_UNMUTED: {
    vi: "Đã bật thông báo cuộc trò chuyện",
    en: "Conversation unmuted",
  },
  CHAT_ROOM_ARCHIVED: {
    vi: "Đã lưu trữ cuộc trò chuyện",
    en: "Conversation archived",
  },
  CHAT_ROOM_UNARCHIVED: {
    vi: "Đã bỏ lưu trữ cuộc trò chuyện",
    en: "Conversation unarchived",
  },
  CHAT_REACTIONS_FETCHED: {
    vi: "Lấy danh sách cảm xúc thành công",
    en: "Reactions fetched successfully",
  },
  CHAT_CONVERSATION_DELETED: {
    vi: "Đã xóa cuộc trò chuyện",
    en: "Conversation deleted",
  },
  CHAT_MESSAGE_DELETED_FOR_YOU: {
    vi: "Đã xóa tin nhắn cho bạn",
    en: "Message deleted for you",
  },
  CHAT_NOTIFICATIONS_ALL_READ: {
    vi: "Đã đánh dấu tất cả là đã đọc",
    en: "All notifications marked as read",
  },
  CHAT_GROUP_DISBANDED: {
    vi: "Đã giải tán nhóm",
    en: "Group disbanded",
  },
  CHAT_GROUP_LEFT: {
    vi: "Đã rời nhóm",
    en: "Left the group",
  },
  CHAT_ROOM_JOINED: {
    vi: "Đã tham gia phòng",
    en: "Joined the room",
  },
  CHAT_ROOM_LEFT: {
    vi: "Đã rời phòng",
    en: "Left the room",
  },

  // --- Rooms / messages ---
  CHAT_ROOM_NOT_FOUND: {
    vi: "Không tìm thấy phòng",
    en: "Room not found",
  },
  CHAT_MESSAGE_NOT_FOUND: {
    vi: "Không tìm thấy tin nhắn",
    en: "Message not found",
  },
  CHAT_INVALID_CONVERSATION_TYPE: {
    vi: "Loại cuộc trò chuyện không hợp lệ",
    en: "Invalid conversation type",
  },
  CHAT_DELETE_OWN_MESSAGES_ONLY: {
    vi: "Bạn chỉ có thể xóa tin nhắn của mình",
    en: "You can only delete your own messages",
  },
  CHAT_EDIT_OWN_MESSAGES_ONLY: {
    vi: "Bạn chỉ có thể chỉnh sửa tin nhắn của mình",
    en: "You can only edit your own messages",
  },
  CHAT_EDIT_TEXT_ONLY: {
    vi: "Chỉ có thể chỉnh sửa tin nhắn văn bản",
    en: "Only text messages can be edited",
  },
  CHAT_MESSAGE_ALREADY_DELETED: {
    vi: "Tin nhắn đã bị xóa",
    en: "Message already deleted",
  },
  CHAT_SYSTEM_MESSAGE_IMMUTABLE: {
    vi: "Không thể xóa tin nhắn hệ thống",
    en: "System messages cannot be deleted",
  },
  CHAT_REACTION_CONFLICT: {
    vi: "Không thể cập nhật cảm xúc do xung đột, vui lòng thử lại",
    en: "Couldn't update reaction due to a conflict, please try again",
  },
  CHAT_REPORT_NOT_PARTICIPANT: {
    vi: "Bạn không phải là thành viên của cuộc trò chuyện này",
    en: "You are not a participant in this conversation",
  },
  CHAT_REPORT_OWN_MESSAGE: {
    vi: "Bạn không thể báo cáo tin nhắn của chính mình",
    en: "You cannot report your own message",
  },
  CHAT_ALREADY_REPORTED: {
    vi: "Bạn đã báo cáo tin nhắn này rồi",
    en: "You have already reported this message",
  },
  CHAT_NOT_A_PARTICIPANT: {
    vi: "Bạn không phải là thành viên của cuộc trò chuyện này",
    en: "You are not a participant in this conversation",
  },
  CHAT_BANNED_FROM_ROOM: {
    vi: "Bạn đã bị cấm khỏi phòng này",
    en: "You are banned from this room",
  },
  CHAT_MUTED_IN_COMMUNITY: {
    vi: "Bạn đang bị tắt tiếng trong cộng đồng này và không thể gửi tin nhắn",
    en: "You are muted in this community and cannot post messages",
  },

  // --- Friendship gate ---
  CHAT_FRIENDSHIP_REQUIRED: {
    vi: "Bạn phải là bạn bè để nhắn tin cho người dùng này",
    en: "You must be friends to message this user",
  },
  CHAT_BLOCKED: {
    vi: "Không thể gửi tin nhắn cho người dùng bị chặn",
    en: "Cannot send messages to a blocked user",
  },

  // --- Pins ---
  CHAT_PIN_LIMIT_REACHED: {
    vi: "Đã đạt giới hạn ghim cho phòng này",
    en: "Pin limit reached for this room",
  },
  CHAT_PIN_NOT_FOUND: {
    vi: "Không tìm thấy ghim",
    en: "Pin not found",
  },
  CHAT_UNPIN_OWN_ONLY: {
    vi: "Bạn chỉ có thể bỏ ghim các ghim do bạn tạo",
    en: "You can only unpin pins created by you",
  },
  // --- Groups ---
  CHAT_GROUP_NOT_FOUND: {
    vi: "Không tìm thấy nhóm",
    en: "Group not found",
  },
  CHAT_GROUP_NO_LONGER_EXISTS: {
    vi: "Nhóm không còn tồn tại",
    en: "Group no longer exists",
  },
  CHAT_NOT_A_MEMBER: {
    vi: "Bạn không phải là thành viên của nhóm này",
    en: "You are not a member of this group",
  },
  CHAT_ALREADY_MEMBER: {
    vi: "Đã là thành viên",
    en: "Already a member",
  },
  CHAT_GROUP_MEMBER_LIMIT_REACHED: {
    vi: "Đã đạt giới hạn thành viên của nhóm",
    en: "Group member limit reached",
  },
  CHAT_OWNER_CANNOT_LEAVE: {
    vi: "Chủ nhóm không thể rời đi. Hãy chuyển quyền hoặc giải tán nhóm.",
    en: "Owner cannot leave. Transfer ownership or disband the group.",
  },
  CHAT_CANNOT_KICK_HIGHER_ROLE: {
    vi: "Không thể loại thành viên có vai trò bằng hoặc cao hơn",
    en: "Cannot remove a member with an equal or higher role",
  },
  CHAT_INSUFFICIENT_PERMISSIONS: {
    vi: "Bạn không có đủ quyền để thực hiện hành động này",
    en: "Insufficient permissions to perform this action",
  },
  CHAT_ONLY_OWNER_ADMIN_UPDATE: {
    vi: "Chỉ chủ nhóm hoặc quản trị viên mới có thể cập nhật nhóm",
    en: "Only the owner or an admin can update the group",
  },
  CHAT_ONLY_OWNER_DISBAND: {
    vi: "Chỉ chủ nhóm mới có thể giải tán nhóm",
    en: "Only the owner can disband the group",
  },

  // --- Invite links ---
  CHAT_INVITE_LINK_NOT_FOUND: {
    vi: "Không tìm thấy liên kết mời hoặc đã hết hạn",
    en: "Invite link not found or expired",
  },
  CHAT_INVITE_LINK_EXPIRED: {
    vi: "Liên kết mời đã hết hạn",
    en: "Invite link has expired",
  },
  CHAT_INVITE_LINK_USAGE_LIMIT: {
    vi: "Liên kết mời đã đạt giới hạn sử dụng",
    en: "Invite link usage limit reached",
  },
  CHAT_MEMBERS_CANNOT_CREATE_LINKS: {
    vi: "Thành viên không được phép tạo liên kết mời",
    en: "Members are not allowed to create invite links",
  },

  // --- Media ---
  CHAT_UPLOAD_REQUEST_INVALID: {
    vi: "Yêu cầu không hợp lệ: cần filename (chuỗi) và contentType (loại MIME được phép)",
    en: "Invalid request: filename (string) and contentType (allowed MIME type) are required",
  },
  CHAT_DOWNLOAD_REQUEST_INVALID: {
    vi: "Yêu cầu không hợp lệ: cần objectKey (chuỗi)",
    en: "Invalid request: objectKey (string) is required",
  },
  CHAT_INVALID_OBJECT_KEY: {
    vi: "Khóa đối tượng không hợp lệ",
    en: "Invalid object key",
  },

  // --- Media attachment limits (private / group / community send) ---
  CHAT_IMAGE_COUNT_EXCEEDED: {
    vi: "Chỉ được gửi tối đa 10 ảnh",
    en: "Maximum 10 images allowed",
  },
  CHAT_IMAGE_TOO_LARGE: {
    vi: "Ảnh vượt quá dung lượng cho phép (25 MB)",
    en: "Image exceeds 25 MB",
  },
  CHAT_VIDEO_TOO_LARGE: {
    vi: "Video vượt quá dung lượng cho phép (100 MB)",
    en: "Video exceeds 100 MB",
  },
  CHAT_VIDEO_TOO_LONG: {
    vi: "Video vượt quá thời lượng cho phép",
    en: "Video exceeds the maximum allowed duration",
  },
  CHAT_VOICE_TOO_LONG: {
    vi: "Tin nhắn thoại vượt quá thời lượng cho phép",
    en: "Voice note exceeds the maximum allowed duration",
  },
  CHAT_AUDIO_TOO_LARGE: {
    vi: "Tệp âm thanh vượt quá dung lượng cho phép (25 MB)",
    en: "Audio exceeds 25 MB",
  },
  CHAT_DOCUMENT_TOO_LARGE: {
    vi: "Tài liệu vượt quá dung lượng cho phép (25 MB)",
    en: "Document exceeds 25 MB",
  },
  CHAT_FILE_TOO_LARGE: {
    vi: "Tệp vượt quá dung lượng cho phép",
    en: "File exceeds the maximum allowed size",
  },
  CHAT_UNSUPPORTED_CONTENT_TYPE: {
    vi: "Loại tệp không được hỗ trợ",
    en: "Unsupported file type",
  },

  // --- Generic / error-handler ---
  CHAT_INVALID_ID_FORMAT: {
    vi: "Định dạng ID không hợp lệ",
    en: "Invalid ID format",
  },
  CHAT_INVALID_REFERENCE: {
    vi: "Tài nguyên được tham chiếu không tồn tại",
    en: "Referenced resource does not exist",
  },
  CHAT_RESOURCE_CONFLICT: {
    vi: "Đã tồn tại bản ghi với thông tin này",
    en: "A record with these details already exists",
  },
  CHAT_NOT_FOUND: {
    vi: "Không tìm thấy tài nguyên yêu cầu",
    en: "Requested resource was not found",
  },
  CHAT_REQUEST_FAILED: {
    vi: "Không thể xử lý yêu cầu",
    en: "The request could not be processed",
  },
  CHAT_INVALID_REQUEST: {
    vi: "Dữ liệu yêu cầu không hợp lệ",
    en: "Invalid request data",
  },
  CHAT_INVALID_JSON_BODY: {
    vi: "Nội dung JSON không hợp lệ",
    en: "Invalid JSON body",
  },
  CHAT_INTERNAL_ERROR: {
    vi: "Lỗi máy chủ nội bộ",
    en: "Internal server error",
  },
} as const satisfies MessageCatalog;

export type ChatMessageKey = keyof typeof CHAT_MESSAGES;
