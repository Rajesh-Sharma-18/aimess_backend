import type { MessageCatalog } from "./types.js";

/**
 * Push / Notification-Center copy. Rendered ONCE PER RECIPIENT in that
 * recipient's own language (`pushToUser` resolves it from the user's
 * AppSettings.language via the cached user-settings gRPC call) — never in the
 * actor's language, and never once for a whole fan-out.
 *
 * Titles that are just a person's or community's name are not in this catalog;
 * they are data, not copy.
 */
export const NOTIFICATION_MESSAGES = {
  NOTIF_UNNAMED_COMMUNITY: {
    vi: "Cộng đồng của bạn",
    en: "Your community",
    th: "คอมมูนิตี้ของคุณ",
  },

  // ── Friend requests ─────────────────────────────────────────────────────
  NOTIF_FRIEND_REQUESTED: {
    vi: "{{name}} đã gửi cho bạn lời mời kết bạn",
    en: "{{name}} sent you a friend request",
    th: "{{name}}ส่งคำขอเป็นเพื่อนถึงคุณ",
  },
  NOTIF_FRIEND_ACCEPTED_FOR_REQUESTER: {
    vi: "{{name}} đã chấp nhận lời mời kết bạn của bạn",
    en: "{{name}} accepted your friend request",
    th: "{{name}}ตอบรับคำขอเป็นเพื่อนของคุณ",
  },
  NOTIF_FRIEND_ACCEPTED_FOR_ADDRESSEE: {
    vi: "Bạn và {{name}} hiện là bạn bè",
    en: "You and {{name}} are now friends",
    th: "คุณและ{{name}}เป็นเพื่อนกันแล้ว",
  },
  NOTIF_FRIEND_REJECTED: {
    vi: "{{name}} đã từ chối lời mời kết bạn của bạn",
    en: "{{name}} declined your friend request",
    th: "{{name}}ปฏิเสธคำขอเป็นเพื่อนของคุณ",
  },
  NOTIF_FRIEND_REJECTED_SELF: {
    vi: "Bạn đã từ chối lời mời kết bạn của {{name}}",
    en: "You declined {{name}}'s friend request",
    th: "คุณปฏิเสธคำขอเป็นเพื่อนของ{{name}}",
  },
  NOTIF_FRIEND_CANCELLED: {
    vi: "{{name}} đã hủy lời mời kết bạn",
    en: "{{name}} cancelled their friend request",
    th: "{{name}}ยกเลิกคำขอเป็นเพื่อน",
  },

  // Short resolution lines shown on an already-answered friend-request card.
  NOTIF_FRIEND_RESOLUTION_ACCEPTED: {
    vi: "{{name}} đã chấp nhận lời mời kết bạn của bạn.",
    en: "{{name}} accepted your friend request.",
    th: "{{name}}ตอบรับคำขอเป็นเพื่อนของคุณแล้ว",
  },
  NOTIF_FRIEND_RESOLUTION_NOW_FRIENDS: {
    vi: "Hai bạn đã là bạn bè!",
    en: "You are now friends!",
    th: "คุณทั้งสองเป็นเพื่อนกันแล้ว!",
  },
  NOTIF_FRIEND_RESOLUTION_DECLINED: {
    vi: "Đã từ chối lời mời kết bạn của bạn",
    en: "Declined your friend request",
    th: "ปฏิเสธคำขอเป็นเพื่อนของคุณ",
  },
  NOTIF_FRIEND_RESOLUTION_DECLINED_SELF: {
    vi: "Bạn đã từ chối lời mời kết bạn này",
    en: "You declined this friend request",
    th: "คุณปฏิเสธคำขอเป็นเพื่อนนี้",
  },
  NOTIF_FRIEND_RESOLUTION_CANCELLED: {
    vi: "Người gửi đã hủy lời mời kết bạn này",
    en: "The sender cancelled this friend request",
    th: "ผู้ส่งยกเลิกคำขอเป็นเพื่อนนี้แล้ว",
  },

  // ── Community ───────────────────────────────────────────────────────────
  NOTIF_COMMUNITY_JOIN_REQUESTED: {
    vi: "{{name}} đã xin tham gia {{community}}",
    en: "{{name}} asked to join {{community}}",
    th: "{{name}}ขอเข้าร่วม{{community}}",
  },
  NOTIF_COMMUNITY_LIVESTREAM_STARTED: {
    vi: "{{name}} đang phát trực tiếp trong {{community}}",
    en: "{{name}} is live in {{community}}",
    th: "{{name}}กำลังไลฟ์อยู่ใน{{community}}",
  },
  NOTIF_COMMUNITY_LIVESTREAM_ENDED: {
    vi: "{{name}} đã kết thúc buổi phát trực tiếp trong {{community}}",
    en: "{{name}} ended the livestream in {{community}}",
    th: "{{name}}จบไลฟ์สตรีมใน{{community}}แล้ว",
  },
  NOTIF_COMMUNITY_LIVESTREAM_ENDED_DURATION: {
    vi: "{{name}} đã kết thúc buổi phát trực tiếp trong {{community}} sau {{duration}}",
    en: "{{name}} ended the livestream in {{community}} after {{duration}}",
    th: "{{name}}จบไลฟ์สตรีมใน{{community}}หลังจาก {{duration}}",
  },
  NOTIF_COMMUNITY_JOIN_REQUEST_APPROVED: {
    vi: "{{name}} đã chấp thuận yêu cầu tham gia {{community}} của bạn",
    en: "{{name}} approved your request to join {{community}}",
    th: "{{name}}อนุมัติคำขอเข้าร่วม{{community}}ของคุณ",
  },
  NOTIF_COMMUNITY_JOIN_REQUEST_REJECTED: {
    vi: "Yêu cầu tham gia {{community}} của bạn không được chấp thuận",
    en: "Your request to join {{community}} wasn't approved",
    th: "คำขอเข้าร่วม{{community}}ของคุณไม่ได้รับการอนุมัติ",
  },
  NOTIF_COMMUNITY_MEMBER_JOINED: {
    vi: "Bạn hiện là thành viên của {{community}}",
    en: "You're now a member of {{community}}",
    th: "คุณเป็นสมาชิกของ{{community}}แล้ว",
  },
  NOTIF_COMMUNITY_MEMBER_ADDED: {
    vi: "Bạn đã được thêm vào {{community}}",
    en: "You were added to {{community}}",
    th: "คุณถูกเพิ่มเข้า{{community}}",
  },
  NOTIF_COMMUNITY_MEMBER_ADDED_FOR_MODERATORS: {
    vi: "Một thành viên mới đã tham gia {{community}}",
    en: "A new member joined {{community}}",
    th: "มีสมาชิกใหม่เข้าร่วม{{community}}",
  },
  NOTIF_COMMUNITY_ADMIN_TRANSFERRED: {
    vi: "Bạn hiện là quản trị viên của {{community}}",
    en: "You're now the admin of {{community}}",
    th: "คุณเป็นผู้ดูแลของ{{community}}แล้ว",
  },
  NOTIF_COMMUNITY_ROLE_CHANGED: {
    vi: "Bạn hiện là {{role}} trong {{community}}",
    en: "You're now {{role}} in {{community}}",
    th: "คุณเป็น{{role}}ใน{{community}}แล้ว",
  },
  NOTIF_COMMUNITY_MEMBER_KICKED: {
    vi: "Bạn đã bị xóa khỏi {{community}}",
    en: "You were removed from {{community}}",
    th: "คุณถูกนำออกจาก{{community}}",
  },
  NOTIF_COMMUNITY_MEMBER_BANNED: {
    vi: "Bạn đã bị cấm khỏi {{community}}",
    en: "You were banned from {{community}}",
    th: "คุณถูกแบนจาก{{community}}",
  },
  // The community name is the notification TITLE (and its avatar the image), so
  // repeating it in the body read as "Your community: Your ban in Your community…".
  NOTIF_COMMUNITY_MEMBER_UNBANNED: {
    vi: "Lệnh cấm của bạn đã được gỡ bỏ.",
    en: "Your ban has been lifted.",
    th: "การแบนของคุณถูกยกเลิกแล้ว",
  },
  NOTIF_COMMUNITY_MEMBER_MUTED_UNTIL: {
    vi: "Bạn bị cấm nói trong {{community}} đến {{until}}",
    en: "You're muted in {{community}} until {{until}}",
    th: "คุณถูกปิดสิทธิ์พูดใน{{community}}จนถึง {{until}}",
  },
  NOTIF_COMMUNITY_MEMBER_MUTED: {
    vi: "Bạn bị cấm nói trong {{community}}",
    en: "You're muted in {{community}}",
    th: "คุณถูกปิดสิทธิ์พูดใน{{community}}",
  },
  NOTIF_COMMUNITY_MEMBER_UNMUTED: {
    vi: "Bạn có thể đăng bài trong {{community}} trở lại",
    en: "You can post in {{community}} again",
    th: "คุณสามารถส่งข้อความใน{{community}}ได้อีกครั้ง",
  },
  NOTIF_COMMUNITY_MEMBER_WARNED: {
    vi: "Người kiểm duyệt đã cảnh cáo bạn trong {{community}}",
    en: "A moderator warned you in {{community}}",
    th: "ผู้ช่วยดูแลตักเตือนคุณใน{{community}}",
  },
  NOTIF_COMMUNITY_INVITE_SENT: {
    vi: "Bạn đã được mời tham gia {{community}}",
    en: "You've been invited to join {{community}}",
    th: "คุณได้รับคำเชิญให้เข้าร่วม{{community}}",
  },
  NOTIF_COMMUNITY_INVITE_ACCEPTED: {
    vi: "Lời mời tham gia {{community}} của bạn đã được chấp nhận",
    en: "Your invite to {{community}} was accepted",
    th: "คำเชิญเข้าร่วม{{community}}ของคุณได้รับการตอบรับแล้ว",
  },
  NOTIF_COMMUNITY_REPORT_CREATED: {
    vi: "Có báo cáo mới cần xem xét.",
    en: "A new report needs review.",
    th: "มีรายงานใหม่ที่ต้องตรวจสอบ",
  },
  NOTIF_COMMUNITY_REPORT_ACTIONED: {
    vi: "Người kiểm duyệt đã xem xét báo cáo của bạn trong {{community}}",
    en: "A moderator reviewed your report in {{community}}",
    th: "ผู้ช่วยดูแลตรวจสอบรายงานของคุณใน{{community}}แล้ว",
  },
  NOTIF_COMMUNITY_REPORT_RESOLVED: {
    vi: "Báo cáo của bạn trong {{community}} đã được xử lý",
    en: "Your report in {{community}} was resolved",
    th: "รายงานของคุณใน{{community}}ได้รับการแก้ไขแล้ว",
  },
  NOTIF_COMMUNITY_DELETED: {
    vi: "{{community}} đã bị xóa",
    en: "{{community}} was deleted",
    th: "{{community}}ถูกลบแล้ว",
  },
  NOTIF_COMMUNITY_CLOSED: {
    vi: "{{community}} đã đóng",
    en: "{{community}} has been closed",
    th: "{{community}}ถูกปิดแล้ว",
  },
  NOTIF_COMMUNITY_REOPENED: {
    vi: "{{community}} đã mở lại",
    en: "{{community}} is open again",
    th: "{{community}}เปิดอีกครั้งแล้ว",
  },

  // ── Chat ────────────────────────────────────────────────────────────────
  NOTIF_CHAT_NEW_MESSAGE: {
    vi: "Tin nhắn mới",
    en: "New message",
    th: "ข้อความใหม่",
  },
  NOTIF_CHAT_NEW_MESSAGE_IN: {
    vi: "Tin nhắn mới trong {{community}}",
    en: "New message in {{community}}",
    th: "ข้อความใหม่ใน{{community}}",
  },
  NOTIF_CHAT_SENT_A_MESSAGE: {
    vi: "Đã gửi một tin nhắn",
    en: "Sent a message",
    th: "ส่งข้อความ",
  },
  NOTIF_CHAT_SENT_YOU_A_MESSAGE: {
    vi: "Đã gửi cho bạn một tin nhắn",
    en: "Sent you a message",
    th: "ส่งข้อความถึงคุณ",
  },
  NOTIF_CHAT_COMMUNITY_BODY: {
    vi: "{{name}}: {{preview}}",
    en: "{{name}}: {{preview}}",
    th: "{{name}}: {{preview}}",
  },
  // Coalesced burst: N messages arriving together are one notification whose
  // body leads with the count and ends with the newest line.
  NOTIF_CHAT_BURST_COUNT: {
    vi: "{{count}} tin nhắn mới",
    en: "{{count}} new messages",
    th: "{{count}} ข้อความใหม่",
  },
  NOTIF_CHAT_BURST_BODY: {
    vi: "{{count}} tin nhắn mới · {{preview}}",
    en: "{{count}} new messages · {{preview}}",
    th: "{{count}} ข้อความใหม่ · {{preview}}",
  },
  NOTIF_CHAT_BURST_BODY_NAMED: {
    vi: "{{count}} tin nhắn mới · {{name}}: {{preview}}",
    en: "{{count}} new messages · {{name}}: {{preview}}",
    th: "{{count}} ข้อความใหม่ · {{name}}: {{preview}}",
  },

  // ── Group ───────────────────────────────────────────────────────────────
  NOTIF_GROUP_UNNAMED: {
    vi: "Nhóm mới",
    en: "New group",
    th: "กลุ่มใหม่",
  },
  NOTIF_GROUP_THIS_GROUP: {
    vi: "nhóm này",
    en: "this group",
    th: "กลุ่มนี้",
  },
  NOTIF_GROUP_MEMBER_ADDED: {
    vi: "Bạn đã được thêm vào nhóm",
    en: "You were added to the group",
    th: "คุณถูกเพิ่มเข้ากลุ่ม",
  },
  NOTIF_GROUP_MEMBER_MUTED_UNTIL: {
    vi: "Bạn bị cấm nói trong {{group}} đến {{until}}",
    en: "You're muted in {{group}} until {{until}}",
    th: "คุณถูกปิดสิทธิ์พูดใน{{group}}จนถึง {{until}}",
  },
  NOTIF_GROUP_MEMBER_MUTED: {
    vi: "Bạn bị cấm nói trong {{group}}",
    en: "You're muted in {{group}}",
    th: "คุณถูกปิดสิทธิ์พูดใน{{group}}",
  },
  NOTIF_GROUP_MEMBER_UNMUTED: {
    vi: "Bạn có thể nhắn tin trong {{group}} trở lại",
    en: "You can post in {{group}} again",
    th: "คุณสามารถส่งข้อความใน{{group}}ได้อีกครั้ง",
  },

  // ── Calls ───────────────────────────────────────────────────────────────
  NOTIF_CALL_INCOMING_VOICE: {
    vi: "Cuộc gọi thoại đến",
    en: "Incoming voice call",
    th: "สายสนทนาเข้า",
  },
  NOTIF_CALL_INCOMING_VIDEO: {
    vi: "Cuộc gọi video đến",
    en: "Incoming video call",
    th: "สายวิดีโอเข้า",
  },
  // The CALLER's side of any call that never connected. There is no
  // user-facing "cancelled"/"declined" call in AiMess — see
  // buildCallActivityText for the single rule that produces this.
  NOTIF_CALL_NO_ANSWER_VOICE: {
    vi: "Cuộc gọi thoại không trả lời",
    en: "Voice call, no answer",
    th: "สายสนทนา ไม่มีการรับสาย",
  },
  NOTIF_CALL_NO_ANSWER_VIDEO: {
    vi: "Cuộc gọi video không trả lời",
    en: "Video call, no answer",
    th: "สายวิดีโอ ไม่มีการรับสาย",
  },
  NOTIF_CALL_MISSED_VOICE: {
    vi: "Cuộc gọi thoại nhỡ",
    en: "Missed voice call",
    th: "สายสนทนาที่ไม่ได้รับ",
  },
  NOTIF_CALL_MISSED_VIDEO: {
    vi: "Cuộc gọi video nhỡ",
    en: "Missed video call",
    th: "สายวิดีโอที่ไม่ได้รับ",
  },
  // Call ACTIVITY copy — the Notification Center's call-history line. One row
  // per call (see buildCallActivityText), rendered from the canonical
  // CallTimelineStatus plus the reader's own direction, so the caller reads
  // "Outgoing voice call" where the callee reads "Missed voice call".
  NOTIF_CALL_OUTGOING_VOICE: {
    vi: "Cuộc gọi thoại đi",
    en: "Outgoing voice call",
    th: "สายสนทนาออก",
  },
  NOTIF_CALL_OUTGOING_VIDEO: {
    vi: "Cuộc gọi video đi",
    en: "Outgoing video call",
    th: "สายวิดีโอออก",
  },
  NOTIF_CALL_DECLINED_VOICE: {
    vi: "Cuộc gọi thoại bị từ chối",
    en: "Declined voice call",
    th: "สายสนทนาที่ถูกปฏิเสธ",
  },
  NOTIF_CALL_DECLINED_VIDEO: {
    vi: "Cuộc gọi video bị từ chối",
    en: "Declined video call",
    th: "สายวิดีโอที่ถูกปฏิเสธ",
  },
  NOTIF_CALL_CANCELLED_VOICE: {
    vi: "Cuộc gọi thoại đã hủy",
    en: "Cancelled voice call",
    th: "สายสนทนาที่ถูกยกเลิก",
  },
  NOTIF_CALL_CANCELLED_VIDEO: {
    vi: "Cuộc gọi video đã hủy",
    en: "Cancelled video call",
    th: "สายวิดีโอที่ถูกยกเลิก",
  },
  NOTIF_CALL_FAILED_VOICE: {
    vi: "Cuộc gọi thoại thất bại",
    en: "Failed voice call",
    th: "สายสนทนาที่ล้มเหลว",
  },
  NOTIF_CALL_FAILED_VIDEO: {
    vi: "Cuộc gọi video thất bại",
    en: "Failed video call",
    th: "สายวิดีโอที่ล้มเหลว",
  },
  // Completed call WITH a known duration. `duration` is always the canonical
  // mm:ss / hh:mm:ss from formatCallDuration — never a re-derived number.
  NOTIF_CALL_ENDED_VOICE: {
    vi: "Cuộc gọi thoại • {{duration}}",
    en: "Voice call • {{duration}}",
    th: "สายสนทนา • {{duration}}",
  },
  NOTIF_CALL_ENDED_VIDEO: {
    vi: "Cuộc gọi video • {{duration}}",
    en: "Video call • {{duration}}",
    th: "สายวิดีโอ • {{duration}}",
  },
  // Completed call with NO duration recorded — never invent one.
  NOTIF_CALL_COMPLETED_VOICE: {
    vi: "Cuộc gọi thoại",
    en: "Voice call",
    th: "สายสนทนา",
  },
  NOTIF_CALL_COMPLETED_VIDEO: {
    vi: "Cuộc gọi video",
    en: "Video call",
    th: "สายวิดีโอ",
  },

  // ── Account / security ──────────────────────────────────────────────────
  NOTIF_AUTH_LOGIN_DETECTED_TITLE: {
    vi: "Phát hiện đăng nhập",
    en: "Login Detected",
    th: "ตรวจพบการเข้าสู่ระบบ",
  },
  NOTIF_AUTH_NEW_DEVICE: {
    vi: "một thiết bị mới",
    en: "a new device",
    th: "อุปกรณ์ใหม่",
  },
  // The article lives in the translation, not in a JS template — "a chrome"
  // has no equivalent in vi/th, which use a classifier or nothing at all.
  NOTIF_AUTH_ON_BROWSER: {
    vi: "một trình duyệt {{browser}}",
    en: "a {{browser}}",
    th: "เบราว์เซอร์{{browser}}",
  },
  NOTIF_AUTH_NEW_LOGIN: {
    vi: "Phát hiện đăng nhập mới trên {{device}}. Nếu không phải bạn, hãy Kết thúc phiên",
    en: "New login detected on {{device}}. If this wasn't you, Terminate Session",
    th: "ตรวจพบการเข้าสู่ระบบใหม่จาก{{device}} หากไม่ใช่คุณ กรุณายุติเซสชัน",
  },
  NOTIF_AUTH_NEW_LOGIN_LOCATION: {
    vi: "Phát hiện đăng nhập mới trên {{device}} từ {{location}}. Nếu không phải bạn, hãy Kết thúc phiên",
    en: "New login detected on {{device}} from {{location}}. If this wasn't you, Terminate Session",
    th: "ตรวจพบการเข้าสู่ระบบใหม่จาก{{device}} ที่ {{location}} หากไม่ใช่คุณ กรุณายุติเซสชัน",
  },
  // ── OTP emails ──────────────────────────────────────────────────────────
  // No recipient account exists yet in these flows (reset / verify), so these
  // follow the `x-lang` of the request that triggered the send, carried on the
  // event payload.
  NOTIF_EMAIL_OTP_EXPIRY_ONE: {
    vi: "Mã này hết hạn sau {{count}} phút.",
    en: "This code expires in {{count}} minute.",
    th: "รหัสนี้จะหมดอายุใน {{count}} นาที",
  },
  NOTIF_EMAIL_OTP_EXPIRY_OTHER: {
    vi: "Mã này hết hạn sau {{count}} phút.",
    en: "This code expires in {{count}} minutes.",
    th: "รหัสนี้จะหมดอายุใน {{count}} นาที",
  },
  NOTIF_EMAIL_PASSWORD_RESET_SUBJECT: {
    vi: "Mã đặt lại mật khẩu AIMess của bạn",
    en: "Your AIMess password reset code",
    th: "รหัสรีเซ็ตรหัสผ่าน AIMess ของคุณ",
  },
  NOTIF_EMAIL_PASSWORD_RESET_INTRO: {
    vi: "Dùng mã xác minh bên dưới để đặt lại mật khẩu AIMess của bạn.",
    en: "Use the verification code below to reset your AIMess password.",
    th: "ใช้รหัสยืนยันด้านล่างเพื่อรีเซ็ตรหัสผ่าน AIMess ของคุณ",
  },
  NOTIF_EMAIL_PASSWORD_RESET_OUTRO: {
    vi: "Nếu bạn không yêu cầu điều này, hãy bỏ qua email; mật khẩu của bạn sẽ không thay đổi.",
    en: "If you did not request this, you can safely ignore this email; your password will not be changed.",
    th: "หากคุณไม่ได้ร้องขอ สามารถเพิกเฉยต่ออีเมลนี้ได้ รหัสผ่านของคุณจะไม่ถูกเปลี่ยน",
  },
  NOTIF_EMAIL_ADMIN_PASSWORD_RESET_SUBJECT: {
    vi: "Mã đặt lại mật khẩu quản trị AIMess của bạn",
    en: "Your AIMess admin password reset code",
    th: "รหัสรีเซ็ตรหัสผ่านผู้ดูแลระบบ AIMess ของคุณ",
  },
  NOTIF_EMAIL_ADMIN_PASSWORD_RESET_INTRO: {
    vi: "Dùng mã xác minh bên dưới để đặt lại mật khẩu tài khoản quản trị AIMess của bạn.",
    en: "Use the verification code below to reset your AIMess admin password.",
    th: "ใช้รหัสยืนยันด้านล่างเพื่อรีเซ็ตรหัสผ่านบัญชีผู้ดูแลระบบ AIMess ของคุณ",
  },
  NOTIF_EMAIL_LINK_EMAIL_SUBJECT: {
    vi: "Mã xác minh email AIMess của bạn",
    en: "Your AIMess email verification code",
    th: "รหัสยืนยันอีเมล AIMess ของคุณ",
  },
  NOTIF_EMAIL_LINK_EMAIL_INTRO: {
    vi: "Dùng mã xác minh bên dưới để liên kết email này với tài khoản AIMess của bạn.",
    en: "Use the verification code below to link this email to your AIMess account.",
    th: "ใช้รหัสยืนยันด้านล่างเพื่อเชื่อมอีเมลนี้กับบัญชี AIMess ของคุณ",
  },
  NOTIF_EMAIL_LINK_EMAIL_OUTRO: {
    vi: "Nếu bạn không yêu cầu điều này, hãy bỏ qua email này.",
    en: "If you did not request this, you can safely ignore this email.",
    th: "หากคุณไม่ได้ร้องขอ สามารถเพิกเฉยต่ออีเมลนี้ได้",
  },
  NOTIF_EMAIL_CHANGE_EMAIL_SUBJECT: {
    vi: "Mã xác minh email mới của bạn trên AIMess",
    en: "Your AIMess new-email verification code",
    th: "รหัสยืนยันอีเมลใหม่ AIMess ของคุณ",
  },
  NOTIF_EMAIL_CHANGE_EMAIL_INTRO: {
    vi: "Dùng mã xác minh bên dưới để xác nhận địa chỉ email mới của bạn.",
    en: "Use the verification code below to confirm your new email address.",
    th: "ใช้รหัสยืนยันด้านล่างเพื่อยืนยันที่อยู่อีเมลใหม่ของคุณ",
  },
  NOTIF_EMAIL_CHANGE_EMAIL_OUTRO: {
    vi: "Nếu bạn không yêu cầu điều này, hãy bỏ qua email; email tài khoản của bạn sẽ không thay đổi.",
    en: "If you did not request this, you can safely ignore this email; your account email will not be changed.",
    th: "หากคุณไม่ได้ร้องขอ สามารถเพิกเฉยต่ออีเมลนี้ได้ อีเมลบัญชีของคุณจะไม่ถูกเปลี่ยน",
  },

  // ── Account status, set by a platform admin ──────────────────────────────
  // Exempt from the notification toggles and from quiet hours (see
  // NON_SUPPRESSIBLE_TYPES): a banned user must always be told. Which is
  // precisely why the copy has to be localized — it is the one notification the
  // user cannot have opted out of.
  NOTIF_ACCOUNT_BANNED_TITLE: {
    vi: "Tài khoản đã bị cấm",
    en: "Account banned",
    th: "บัญชีถูกแบน",
  },
  NOTIF_ACCOUNT_BANNED_BODY: {
    vi: "Tài khoản của bạn đã bị cấm. Hãy liên hệ bộ phận hỗ trợ nếu bạn cho rằng đây là nhầm lẫn.",
    en: "Your account has been banned. Reach out to support if you think this is a mistake.",
    th: "บัญชีของคุณถูกแบน หากคุณคิดว่าเป็นความผิดพลาด โปรดติดต่อฝ่ายสนับสนุน",
  },
  NOTIF_ACCOUNT_SUSPENDED_TITLE: {
    vi: "Tài khoản đã bị tạm khóa",
    en: "Account suspended",
    th: "บัญชีถูกระงับชั่วคราว",
  },
  NOTIF_ACCOUNT_SUSPENDED_BODY: {
    vi: "Tài khoản của bạn đang bị tạm khóa",
    en: "Your account is temporarily suspended",
    th: "บัญชีของคุณถูกระงับชั่วคราว",
  },
  NOTIF_ACCOUNT_REINSTATED_TITLE: {
    vi: "Chào mừng trở lại",
    en: "Welcome back",
    th: "ยินดีต้อนรับกลับมา",
  },
  NOTIF_ACCOUNT_REINSTATED_BODY: {
    vi: "Tài khoản của bạn đã được khôi phục",
    en: "Your account has been reinstated",
    th: "บัญชีของคุณได้รับการคืนสถานะแล้ว",
  },

  NOTIF_AUTH_PASSWORD_CHANGED_TITLE: {
    vi: "Đã đổi mật khẩu",
    en: "Password changed",
    th: "เปลี่ยนรหัสผ่านแล้ว",
  },
  NOTIF_AUTH_PASSWORD_CHANGED_BODY: {
    vi: "Mật khẩu của bạn đã được cập nhật",
    en: "Your password was updated",
    th: "รหัสผ่านของคุณถูกอัปเดตแล้ว",
  },
  NOTIF_AUTH_EMAIL_CHANGED_TITLE: {
    vi: "Đã đổi email",
    en: "Email changed",
    th: "เปลี่ยนอีเมลแล้ว",
  },
  NOTIF_AUTH_EMAIL_CHANGED_BODY: {
    vi: "Email tài khoản của bạn đã được cập nhật",
    en: "Your account email was updated",
    th: "อีเมลบัญชีของคุณถูกอัปเดตแล้ว",
  },
} as const satisfies MessageCatalog;

export type NotificationMessageKey = keyof typeof NOTIFICATION_MESSAGES;
