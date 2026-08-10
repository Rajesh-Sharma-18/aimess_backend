import type { MessageCatalog } from "./types.js";

/**
 * SYSTEM timeline copy — the sentences rendered into private/group/community
 * SYSTEM rows, call rows, and their inbox previews.
 *
 * These differ from the rest of the catalog in two ways:
 *
 * 1. They interpolate. Never concatenate around a translation — pass params
 *    (`t("SYS_GROUP_MEMBER_ADDED", locale, { actor, target })`) so each language
 *    controls its own word order.
 * 2. They are rendered PER VIEWER. A `_SELF` key is the first-person form shown
 *    to the actor/subject of the event; the base key is what everyone else sees.
 *
 * The text persisted on the message row is always the English form (see
 * `STORED_TEXT_LOCALE`) and is only a fallback — every read path re-renders from
 * the stored `systemEvent`/`systemMetadata`, so changing a translation here
 * changes historical rows too, with no migration.
 */
export const SYSTEM_MESSAGES = {
  // ── Shared name / role fallbacks ────────────────────────────────────────
  SYS_NAME_SOMEONE: {
    vi: "Ai đó",
    en: "Someone",
    th: "บางคน",
  },
  SYS_NAME_SOMEONE_LOWER: {
    vi: "ai đó",
    en: "someone",
    th: "บางคน",
  },
  SYS_NAME_A_MEMBER: {
    vi: "một thành viên",
    en: "a member",
    th: "สมาชิกคนหนึ่ง",
  },
  SYS_NAME_A_MEMBER_CAP: {
    vi: "Một thành viên",
    en: "A member",
    th: "สมาชิกคนหนึ่ง",
  },
  SYS_NAME_UNKNOWN_USER: {
    vi: "Người dùng không xác định",
    en: "Unknown User",
    th: "ผู้ใช้ที่ไม่รู้จัก",
  },
  SYS_SENDER_YOU: {
    vi: "Bạn",
    en: "You",
    th: "คุณ",
  },
  SYS_ROLE_ADMIN_ARTICLE: {
    vi: "quản trị viên",
    en: "an admin",
    th: "ผู้ดูแล",
  },
  SYS_ROLE_MODERATOR_ARTICLE: {
    vi: "người kiểm duyệt",
    en: "a moderator",
    th: "ผู้ช่วยดูแล",
  },
  SYS_ROLE_MEMBER_ARTICLE: {
    vi: "thành viên",
    en: "a member",
    th: "สมาชิก",
  },

  // ── Durations (mute / livestream / call) ────────────────────────────────
  // en distinguishes singular/plural; vi and th do not — same string in both
  // slots is correct, not a copy-paste slip.
  SYS_DURATION_MINUTE_ONE: {
    vi: "{{count}} phút",
    en: "{{count}} minute",
    th: "{{count}} นาที",
  },
  SYS_DURATION_MINUTE_OTHER: {
    vi: "{{count}} phút",
    en: "{{count}} minutes",
    th: "{{count}} นาที",
  },
  SYS_DURATION_HOUR_ONE: {
    vi: "{{count}} giờ",
    en: "{{count}} hour",
    th: "{{count}} ชั่วโมง",
  },
  SYS_DURATION_HOUR_OTHER: {
    vi: "{{count}} giờ",
    en: "{{count}} hours",
    th: "{{count}} ชั่วโมง",
  },
  SYS_DURATION_DAY_ONE: {
    vi: "{{count}} ngày",
    en: "{{count}} day",
    th: "{{count}} วัน",
  },
  SYS_DURATION_DAY_OTHER: {
    vi: "{{count}} ngày",
    en: "{{count}} days",
    th: "{{count}} วัน",
  },
  SYS_STREAM_DURATION_HM: {
    vi: "{{hours}} giờ {{minutes}} phút",
    en: "{{hours}}h {{minutes}}m",
    th: "{{hours}} ชม. {{minutes}} นาที",
  },
  SYS_STREAM_DURATION_H: {
    vi: "{{hours}} giờ",
    en: "{{hours}}h",
    th: "{{hours}} ชม.",
  },
  SYS_STREAM_DURATION_M: {
    vi: "{{minutes}} phút",
    en: "{{minutes}}m",
    th: "{{minutes}} นาที",
  },
  SYS_STREAM_DURATION_S: {
    vi: "{{seconds}} giây",
    en: "{{seconds}}s",
    th: "{{seconds}} วิ",
  },

  // ── Calls (shared by private DM rows and group rows) ─────────────────────
  SYS_CALL_LABEL_VOICE: {
    vi: "Cuộc gọi thoại",
    en: "Voice call",
    th: "สายสนทนา",
  },
  SYS_CALL_LABEL_VIDEO: {
    vi: "Cuộc gọi video",
    en: "Video call",
    th: "สายวิดีโอ",
  },
  SYS_CALL_RINGING: {
    vi: "{{label}} đang đổ chuông",
    en: "{{label}} ringing",
    th: "{{label}}กำลังเรียก",
  },
  SYS_CALL_ONGOING: {
    vi: "{{label}} đang diễn ra",
    en: "{{label}} ongoing",
    th: "{{label}}กำลังดำเนินอยู่",
  },
  SYS_CALL_DECLINED: {
    vi: "{{label}} bị từ chối",
    en: "{{label}} declined",
    th: "{{label}}ถูกปฏิเสธ",
  },
  SYS_CALL_CANCELLED: {
    vi: "{{label}} đã hủy",
    en: "{{label}} cancelled",
    th: "{{label}}ถูกยกเลิก",
  },
  SYS_CALL_FAILED: {
    vi: "{{label}} thất bại",
    en: "{{label}} failed",
    th: "{{label}}ล้มเหลว",
  },
  SYS_CALL_MISSED: {
    vi: "{{label}} không có người trả lời",
    en: "{{label}} was not answered",
    th: "ไม่มีผู้รับ{{label}}",
  },
  SYS_CALL_ENDED: {
    vi: "{{label}} kéo dài {{duration}}",
    en: "{{label}} lasted {{duration}}",
    th: "{{label}}ใช้เวลา {{duration}}",
  },

  // ── Group SYSTEM rows ───────────────────────────────────────────────────
  SYS_GROUP_CREATED: {
    vi: "{{actor}} đã tạo nhóm",
    en: "{{actor}} created the group",
    th: "{{actor}}สร้างกลุ่มนี้",
  },
  SYS_GROUP_CREATED_SELF: {
    vi: "Bạn đã tạo nhóm",
    en: "You created the group",
    th: "คุณสร้างกลุ่มนี้",
  },
  SYS_GROUP_MEMBER_ADDED: {
    vi: "{{actor}} đã thêm {{target}}",
    en: "{{actor}} added {{target}}",
    th: "{{actor}}เพิ่ม{{target}}",
  },
  SYS_GROUP_MEMBER_ADDED_SELF: {
    vi: "Bạn đã được thêm vào nhóm",
    en: "You were added to the group",
    th: "คุณถูกเพิ่มเข้ากลุ่ม",
  },
  SYS_GROUP_MEMBER_JOINED: {
    vi: "{{actor}} đã tham gia nhóm",
    en: "{{actor}} joined the group",
    th: "{{actor}}เข้าร่วมกลุ่ม",
  },
  SYS_GROUP_MEMBER_JOINED_SELF: {
    vi: "Bạn đã tham gia nhóm",
    en: "You joined the group",
    th: "คุณเข้าร่วมกลุ่ม",
  },
  SYS_GROUP_MEMBER_LEFT: {
    vi: "{{actor}} đã rời nhóm",
    en: "{{actor}} left the group",
    th: "{{actor}}ออกจากกลุ่ม",
  },
  SYS_GROUP_MEMBER_LEFT_SELF: {
    vi: "Bạn đã rời nhóm",
    en: "You left the group",
    th: "คุณออกจากกลุ่ม",
  },
  SYS_GROUP_MEMBER_REMOVED: {
    vi: "{{actor}} đã xóa {{target}}",
    en: "{{actor}} removed {{target}}",
    th: "{{actor}}นำ{{target}}ออกจากกลุ่ม",
  },
  SYS_GROUP_MEMBER_REMOVED_SELF: {
    vi: "Bạn đã bị xóa khỏi nhóm",
    en: "You were removed",
    th: "คุณถูกนำออกจากกลุ่ม",
  },
  SYS_GROUP_MEMBER_BANNED: {
    vi: "{{actor}} đã cấm {{target}}",
    en: "{{actor}} banned {{target}}",
    th: "{{actor}}แบน{{target}}",
  },
  SYS_GROUP_MEMBER_BANNED_SELF: {
    vi: "Bạn đã bị cấm",
    en: "You were banned",
    th: "คุณถูกแบน",
  },
  SYS_GROUP_MEMBER_UNBANNED: {
    vi: "{{actor}} đã bỏ cấm {{target}}",
    en: "{{actor}} unbanned {{target}}",
    th: "{{actor}}ปลดแบน{{target}}",
  },
  SYS_GROUP_MEMBER_UNBANNED_SELF: {
    vi: "Bạn đã được bỏ cấm",
    en: "You were unbanned",
    th: "คุณถูกปลดแบน",
  },
  SYS_GROUP_ADMIN_ASSIGNED: {
    vi: "{{target}} hiện là quản trị viên",
    en: "{{target}} is now an admin",
    th: "{{target}}เป็นผู้ดูแลแล้ว",
  },
  SYS_GROUP_ADMIN_ASSIGNED_SELF: {
    vi: "Bạn hiện là quản trị viên",
    en: "You are now an admin",
    th: "คุณเป็นผู้ดูแลแล้ว",
  },
  SYS_GROUP_ROLE_ADMIN: {
    vi: "{{target}} hiện là quản trị viên của nhóm",
    en: "{{target}} is now the group admin",
    th: "{{target}}เป็นผู้ดูแลกลุ่มแล้ว",
  },
  SYS_GROUP_ROLE_ADMIN_SELF: {
    vi: "Bạn hiện là quản trị viên của nhóm",
    en: "You are now the group admin",
    th: "คุณเป็นผู้ดูแลกลุ่มแล้ว",
  },
  // Also used for ADMIN_REMOVED — a demotion and a role change to MEMBER read
  // identically in every language here.
  SYS_GROUP_ROLE_MEMBER: {
    vi: "{{target}} hiện là thành viên",
    en: "{{target}} is now a member",
    th: "{{target}}เป็นสมาชิกแล้ว",
  },
  SYS_GROUP_ROLE_MEMBER_SELF: {
    vi: "Bạn hiện là thành viên",
    en: "You are now a member",
    th: "คุณเป็นสมาชิกแล้ว",
  },
  SYS_GROUP_ROLE_CHANGED: {
    vi: "{{target}} hiện là {{role}}",
    en: "{{target}} is now {{role}}",
    th: "{{target}}เป็น{{role}}แล้ว",
  },
  SYS_GROUP_ROLE_CHANGED_SELF: {
    vi: "Bạn hiện là {{role}}",
    en: "You are now {{role}}",
    th: "คุณเป็น{{role}}แล้ว",
  },
  SYS_GROUP_OWNERSHIP_TRANSFERRED: {
    vi: "{{actor}} đã chuyển quyền sở hữu cho {{target}}",
    en: "{{actor}} transferred ownership to {{target}}",
    th: "{{actor}}โอนสิทธิ์ความเป็นเจ้าของให้{{target}}",
  },
  SYS_GROUP_OWNERSHIP_TRANSFERRED_ACTOR: {
    vi: "Bạn đã chuyển quyền sở hữu cho {{target}}",
    en: "You transferred ownership to {{target}}",
    th: "คุณโอนสิทธิ์ความเป็นเจ้าของให้{{target}}",
  },
  SYS_GROUP_OWNERSHIP_TRANSFERRED_TARGET: {
    vi: "{{actor}} đã chuyển quyền sở hữu cho bạn",
    en: "{{actor}} transferred ownership to you",
    th: "{{actor}}โอนสิทธิ์ความเป็นเจ้าของให้คุณ",
  },
  SYS_GROUP_RENAMED: {
    vi: "{{actor}} đã đổi tên nhóm thành “{{name}}”",
    en: '{{actor}} renamed the group to "{{name}}"',
    th: "{{actor}}เปลี่ยนชื่อกลุ่มเป็น “{{name}}”",
  },
  SYS_GROUP_RENAMED_SELF: {
    vi: "Bạn đã đổi tên nhóm thành “{{name}}”",
    en: 'You renamed the group to "{{name}}"',
    th: "คุณเปลี่ยนชื่อกลุ่มเป็น “{{name}}”",
  },
  SYS_GROUP_RENAMED_PLAIN: {
    vi: "{{actor}} đã đổi tên nhóm",
    en: "{{actor}} renamed the group",
    th: "{{actor}}เปลี่ยนชื่อกลุ่ม",
  },
  SYS_GROUP_RENAMED_PLAIN_SELF: {
    vi: "Bạn đã đổi tên nhóm",
    en: "You renamed the group",
    th: "คุณเปลี่ยนชื่อกลุ่ม",
  },
  SYS_GROUP_AVATAR_CHANGED: {
    vi: "{{actor}} đã đổi ảnh nhóm",
    en: "{{actor}} changed the group photo",
    th: "{{actor}}เปลี่ยนรูปกลุ่ม",
  },
  SYS_GROUP_AVATAR_CHANGED_SELF: {
    vi: "Bạn đã đổi ảnh nhóm",
    en: "You changed the group photo",
    th: "คุณเปลี่ยนรูปกลุ่ม",
  },
  SYS_GROUP_DESCRIPTION_CHANGED: {
    vi: "{{actor}} đã cập nhật mô tả nhóm",
    en: "{{actor}} updated the group description",
    th: "{{actor}}อัปเดตคำอธิบายกลุ่ม",
  },
  SYS_GROUP_DESCRIPTION_CHANGED_SELF: {
    vi: "Bạn đã cập nhật mô tả nhóm",
    en: "You updated the group description",
    th: "คุณอัปเดตคำอธิบายกลุ่ม",
  },
  SYS_GROUP_INVITE_LINK_CREATED: {
    vi: "{{actor}} đã tạo liên kết mời",
    en: "{{actor}} created an invite link",
    th: "{{actor}}สร้างลิงก์เชิญ",
  },
  SYS_GROUP_INVITE_LINK_CREATED_SELF: {
    vi: "Bạn đã tạo liên kết mời",
    en: "You created an invite link",
    th: "คุณสร้างลิงก์เชิญ",
  },
  SYS_GROUP_INVITE_SHARED: {
    vi: "{{actor}} đã chia sẻ lời mời vào nhóm",
    en: "{{actor}} shared a group invite",
    th: "{{actor}}แชร์คำเชิญเข้ากลุ่ม",
  },
  SYS_GROUP_INVITE_SHARED_SELF: {
    vi: "Bạn đã chia sẻ lời mời vào nhóm",
    en: "You shared a group invite",
    th: "คุณแชร์คำเชิญเข้ากลุ่ม",
  },
  SYS_GROUP_MESSAGE_PINNED: {
    vi: "{{actor}} đã ghim một tin nhắn",
    en: "{{actor}} pinned a message",
    th: "{{actor}}ปักหมุดข้อความ",
  },
  SYS_GROUP_MESSAGE_PINNED_SELF: {
    vi: "Bạn đã ghim một tin nhắn",
    en: "You pinned a message",
    th: "คุณปักหมุดข้อความ",
  },
  SYS_GROUP_MESSAGE_UNPINNED: {
    vi: "{{actor}} đã bỏ ghim một tin nhắn",
    en: "{{actor}} unpinned a message",
    th: "{{actor}}เลิกปักหมุดข้อความ",
  },
  SYS_GROUP_MESSAGE_UNPINNED_SELF: {
    vi: "Bạn đã bỏ ghim một tin nhắn",
    en: "You unpinned a message",
    th: "คุณเลิกปักหมุดข้อความ",
  },
  SYS_MESSAGES_ENCRYPTED: {
    vi: "Tin nhắn được mã hóa đầu cuối",
    en: "Messages are end-to-end encrypted",
    th: "ข้อความถูกเข้ารหัสแบบต้นทางถึงปลายทาง",
  },
  SYS_GROUP_UPDATED: {
    vi: "{{actor}} đã cập nhật nhóm",
    en: "{{actor}} updated the group",
    th: "{{actor}}อัปเดตข้อมูลกลุ่ม",
  },
  SYS_GROUP_UPDATED_SELF: {
    vi: "Bạn đã cập nhật nhóm",
    en: "You updated the group",
    th: "คุณอัปเดตข้อมูลกลุ่ม",
  },

  // ── Private (1:1) SYSTEM rows ───────────────────────────────────────────
  SYS_PRIVATE_FRIENDSHIP_CREATED: {
    vi: "{{actor}} và {{target}} hiện là bạn bè",
    en: "{{actor}} and {{target}} are now friends",
    th: "{{actor}}และ{{target}}เป็นเพื่อนกันแล้ว",
  },
  SYS_PRIVATE_FRIENDSHIP_CREATED_SELF: {
    vi: "Bạn và {{other}} hiện là bạn bè",
    en: "You and {{other}} are now friends",
    th: "คุณและ{{other}}เป็นเพื่อนกันแล้ว",
  },
  SYS_PRIVATE_FRIENDSHIP_DELETED: {
    vi: "{{actor}} đã hủy kết bạn với {{target}}",
    en: "{{actor}} removed {{target}}",
    th: "{{actor}}ลบ{{target}}ออกจากรายชื่อเพื่อน",
  },
  SYS_PRIVATE_FRIENDSHIP_DELETED_ACTOR: {
    vi: "Bạn đã hủy kết bạn với {{target}}",
    en: "You removed {{target}}",
    th: "คุณลบ{{target}}ออกจากรายชื่อเพื่อน",
  },
  SYS_PRIVATE_FRIENDSHIP_DELETED_TARGET: {
    vi: "{{actor}} đã hủy kết bạn với bạn",
    en: "{{actor}} removed you",
    th: "{{actor}}ลบคุณออกจากรายชื่อเพื่อน",
  },
  SYS_PRIVATE_FRIENDSHIP_BLOCKED: {
    vi: "{{actor}} đã chặn {{target}}",
    en: "{{actor}} blocked {{target}}",
    th: "{{actor}}บล็อก{{target}}",
  },
  SYS_PRIVATE_FRIENDSHIP_BLOCKED_ACTOR: {
    vi: "Bạn đã chặn {{target}}",
    en: "You blocked {{target}}",
    th: "คุณบล็อก{{target}}",
  },
  SYS_PRIVATE_FRIENDSHIP_BLOCKED_TARGET: {
    vi: "{{actor}} đã chặn bạn",
    en: "{{actor}} blocked you",
    th: "{{actor}}บล็อกคุณ",
  },
  SYS_PRIVATE_FRIENDSHIP_BANNED: {
    vi: "{{actor}} đã cấm {{target}}",
    en: "{{actor}} banned {{target}}",
    th: "{{actor}}แบน{{target}}",
  },
  SYS_PRIVATE_FRIENDSHIP_BANNED_ACTOR: {
    vi: "Bạn đã cấm {{target}}",
    en: "You banned {{target}}",
    th: "คุณแบน{{target}}",
  },
  SYS_PRIVATE_FRIENDSHIP_BANNED_TARGET: {
    vi: "{{actor}} đã cấm bạn",
    en: "{{actor}} banned you",
    th: "{{actor}}แบนคุณ",
  },
  SYS_PRIVATE_AUTO_DELETE_OFF: {
    vi: "{{who}} đã tắt tự động xóa tin nhắn",
    en: "{{who}} turned off automatic message deletion",
    th: "{{who}}ปิดการลบข้อความอัตโนมัติ",
  },
  SYS_PRIVATE_AUTO_DELETE_AFTER_VIEWING: {
    vi: "{{who}} đã đặt tin nhắn tự xóa sau khi xem",
    en: "{{who}} set messages to delete after viewing",
    th: "{{who}}ตั้งให้ข้อความลบหลังจากเปิดอ่าน",
  },
  SYS_PRIVATE_AUTO_DELETE_DURATION: {
    vi: "{{who}} đã đặt tin nhắn tự xóa sau {{duration}}",
    en: "{{who}} set messages to auto-delete after {{duration}}",
    th: "{{who}}ตั้งให้ข้อความลบอัตโนมัติหลังจาก {{duration}}",
  },
  SYS_PRIVATE_AUTO_DELETE_ON: {
    vi: "{{who}} đã bật tự động xóa tin nhắn",
    en: "{{who}} turned on automatic message deletion",
    th: "{{who}}เปิดการลบข้อความอัตโนมัติ",
  },
  SYS_PRIVATE_UPDATED: {
    vi: "{{actor}} đã cập nhật cuộc trò chuyện",
    en: "{{actor}} updated the chat",
    th: "{{actor}}อัปเดตการสนทนา",
  },
  SYS_PRIVATE_UPDATED_SELF: {
    vi: "Bạn đã cập nhật cuộc trò chuyện",
    en: "You updated the chat",
    th: "คุณอัปเดตการสนทนา",
  },

  // ── Community SYSTEM rows ───────────────────────────────────────────────
  SYS_COMMUNITY_CREATED: {
    vi: "Cộng đồng đã được tạo",
    en: "Community created",
    th: "สร้างคอมมูนิตี้แล้ว",
  },
  SYS_COMMUNITY_RENAMED: {
    vi: "Cộng đồng đã đổi tên thành “{{name}}”",
    en: 'Community renamed to "{{name}}"',
    th: "เปลี่ยนชื่อคอมมูนิตี้เป็น “{{name}}”",
  },
  SYS_COMMUNITY_NAME_UPDATED: {
    vi: "Tên cộng đồng đã được cập nhật",
    en: "Community name updated",
    th: "อัปเดตชื่อคอมมูนิตี้แล้ว",
  },
  SYS_COMMUNITY_DESCRIPTION_UPDATED: {
    vi: "Mô tả cộng đồng đã được cập nhật",
    en: "Community description updated",
    th: "อัปเดตคำอธิบายคอมมูนิตี้แล้ว",
  },
  SYS_COMMUNITY_AVATAR_UPDATED: {
    vi: "Ảnh cộng đồng đã được cập nhật",
    en: "Community photo updated",
    th: "อัปเดตรูปคอมมูนิตี้แล้ว",
  },
  SYS_COMMUNITY_BANNER_UPDATED: {
    vi: "Ảnh bìa cộng đồng đã được cập nhật",
    en: "Community banner updated",
    th: "อัปเดตรูปปกคอมมูนิตี้แล้ว",
  },
  SYS_COMMUNITY_HANDLE_UPDATED: {
    vi: "Định danh cộng đồng đã được cập nhật",
    en: "Community handle updated",
    th: "อัปเดตแฮนเดิลคอมมูนิตี้แล้ว",
  },
  SYS_COMMUNITY_UPDATED: {
    vi: "Cài đặt cộng đồng đã được cập nhật",
    en: "Community settings updated",
    th: "อัปเดตการตั้งค่าคอมมูนิตี้แล้ว",
  },
  SYS_COMMUNITY_LIVESTREAM_STARTED: {
    vi: "{{actor}} đã bắt đầu một buổi phát trực tiếp",
    en: "{{actor}} started a livestream",
    th: "{{actor}}เริ่มไลฟ์สตรีม",
  },
  SYS_COMMUNITY_LIVESTREAM_STARTED_SELF: {
    vi: "Bạn đã bắt đầu một buổi phát trực tiếp",
    en: "You started a livestream",
    th: "คุณเริ่มไลฟ์สตรีม",
  },
  SYS_COMMUNITY_LIVESTREAM_ENDED: {
    vi: "{{actor}} đã kết thúc buổi phát trực tiếp",
    en: "{{actor}} ended the livestream",
    th: "{{actor}}จบไลฟ์สตรีม",
  },
  SYS_COMMUNITY_LIVESTREAM_ENDED_SELF: {
    vi: "Bạn đã kết thúc buổi phát trực tiếp",
    en: "You ended the livestream",
    th: "คุณจบไลฟ์สตรีม",
  },
  SYS_COMMUNITY_LIVESTREAM_ENDED_DURATION: {
    vi: "{{lead}} ({{duration}})",
    en: "{{lead}} ({{duration}})",
    th: "{{lead}} ({{duration}})",
  },
  SYS_COMMUNITY_ROLE_ADMIN: {
    vi: "{{target}} hiện là quản trị viên của cộng đồng",
    en: "{{target}} is now the community admin",
    th: "{{target}}เป็นผู้ดูแลคอมมูนิตี้แล้ว",
  },
  SYS_COMMUNITY_ROLE_ADMIN_SELF: {
    vi: "Bạn hiện là quản trị viên của cộng đồng",
    en: "You are now the community admin",
    th: "คุณเป็นผู้ดูแลคอมมูนิตี้แล้ว",
  },
  SYS_COMMUNITY_ROLE_MEMBER: {
    vi: "{{target}} hiện là thành viên",
    en: "{{target}} is now a member",
    th: "{{target}}เป็นสมาชิกแล้ว",
  },
  SYS_COMMUNITY_ROLE_MEMBER_SELF: {
    vi: "Bạn hiện là thành viên",
    en: "You are now a member",
    th: "คุณเป็นสมาชิกแล้ว",
  },
  SYS_COMMUNITY_ROLE_CHANGED: {
    vi: "{{target}} hiện là {{role}}",
    en: "{{target}} is now {{role}}",
    th: "{{target}}เป็น{{role}}แล้ว",
  },
  SYS_COMMUNITY_ROLE_CHANGED_SELF: {
    vi: "Bạn hiện là {{role}}",
    en: "You are now {{role}}",
    th: "คุณเป็น{{role}}แล้ว",
  },
  SYS_COMMUNITY_MEMBER_JOINED: {
    vi: "{{target}} đã tham gia cộng đồng",
    en: "{{target}} joined the community",
    th: "{{target}}เข้าร่วมคอมมูนิตี้",
  },
  SYS_COMMUNITY_MEMBER_JOINED_SELF: {
    vi: "Bạn đã tham gia cộng đồng",
    en: "You joined the community",
    th: "คุณเข้าร่วมคอมมูนิตี้",
  },
  SYS_COMMUNITY_MEMBER_LEFT: {
    vi: "{{target}} đã rời cộng đồng",
    en: "{{target}} left the community",
    th: "{{target}}ออกจากคอมมูนิตี้",
  },
  SYS_COMMUNITY_MEMBER_LEFT_SELF: {
    vi: "Bạn đã rời cộng đồng",
    en: "You left the community",
    th: "คุณออกจากคอมมูนิตี้",
  },
  SYS_COMMUNITY_MEMBER_REMOVED: {
    vi: "{{target}} đã bị xóa",
    en: "{{target}} was removed",
    th: "{{target}}ถูกนำออก",
  },
  SYS_COMMUNITY_MEMBER_REMOVED_SELF: {
    vi: "Bạn đã bị xóa",
    en: "You were removed",
    th: "คุณถูกนำออก",
  },
  SYS_COMMUNITY_MEMBER_BANNED: {
    vi: "{{target}} đã bị cấm",
    en: "{{target}} was banned",
    th: "{{target}}ถูกแบน",
  },
  SYS_COMMUNITY_MEMBER_BANNED_SELF: {
    vi: "Bạn đã bị cấm khỏi cộng đồng này.",
    en: "You were banned from this community.",
    th: "คุณถูกแบนจากคอมมูนิตี้นี้",
  },
  SYS_COMMUNITY_MEMBER_UNBANNED: {
    vi: "{{target}} đã được bỏ cấm",
    en: "{{target}} was unbanned",
    th: "{{target}}ถูกปลดแบน",
  },
  SYS_COMMUNITY_MEMBER_UNBANNED_SELF: {
    vi: "Bạn đã được bỏ cấm",
    en: "You were unbanned",
    th: "คุณถูกปลดแบน",
  },
  SYS_COMMUNITY_MEMBER_MUTED_UNTIL: {
    vi: "{{target}} bị cấm nói đến {{until}}",
    en: "{{target}} is muted until {{until}}",
    th: "{{target}}ถูกปิดสิทธิ์พูดจนถึง {{until}}",
  },
  SYS_COMMUNITY_MEMBER_MUTED_UNTIL_SELF: {
    vi: "Bạn bị cấm nói đến {{until}}",
    en: "You are muted until {{until}}",
    th: "คุณถูกปิดสิทธิ์พูดจนถึง {{until}}",
  },
  SYS_COMMUNITY_MEMBER_MUTED: {
    vi: "{{target}} bị cấm nói vô thời hạn",
    en: "{{target}} is muted indefinitely",
    th: "{{target}}ถูกปิดสิทธิ์พูดโดยไม่มีกำหนด",
  },
  SYS_COMMUNITY_MEMBER_MUTED_SELF: {
    vi: "Bạn bị cấm nói vô thời hạn",
    en: "You are muted indefinitely",
    th: "คุณถูกปิดสิทธิ์พูดโดยไม่มีกำหนด",
  },
  SYS_COMMUNITY_MEMBER_UNMUTED: {
    vi: "{{target}} đã được bỏ cấm nói",
    en: "{{target}} was unmuted",
    th: "{{target}}ถูกเปิดสิทธิ์พูดแล้ว",
  },
  SYS_COMMUNITY_MEMBER_UNMUTED_SELF: {
    vi: "Bạn đã được bỏ cấm nói",
    en: "You were unmuted",
    th: "คุณถูกเปิดสิทธิ์พูดแล้ว",
  },
  SYS_COMMUNITY_MESSAGE_PINNED: {
    vi: "{{actor}} đã ghim một tin nhắn",
    en: "{{actor}} pinned a message",
    th: "{{actor}}ปักหมุดข้อความ",
  },
  SYS_COMMUNITY_MESSAGE_PINNED_SELF: {
    vi: "Bạn đã ghim một tin nhắn",
    en: "You pinned a message",
    th: "คุณปักหมุดข้อความ",
  },
  SYS_COMMUNITY_MESSAGE_UNPINNED: {
    vi: "{{actor}} đã bỏ ghim một tin nhắn",
    en: "{{actor}} unpinned a message",
    th: "{{actor}}เลิกปักหมุดข้อความ",
  },
  SYS_COMMUNITY_MESSAGE_UNPINNED_SELF: {
    vi: "Bạn đã bỏ ghim một tin nhắn",
    en: "You unpinned a message",
    th: "คุณเลิกปักหมุดข้อความ",
  },
  SYS_COMMUNITY_INVITE_CREATED: {
    vi: "{{actor}} đã tạo liên kết mời",
    en: "{{actor}} created an invite link",
    th: "{{actor}}สร้างลิงก์เชิญ",
  },
  SYS_COMMUNITY_INVITE_CREATED_SELF: {
    vi: "Bạn đã tạo liên kết mời",
    en: "You created an invite link",
    th: "คุณสร้างลิงก์เชิญ",
  },
  SYS_COMMUNITY_JOIN_REQUEST_APPROVED: {
    vi: "Yêu cầu tham gia của bạn đã được chấp thuận",
    en: "Your request to join was approved",
    th: "คำขอเข้าร่วมของคุณได้รับการอนุมัติ",
  },
  SYS_COMMUNITY_JOIN_REQUEST_REJECTED: {
    vi: "Yêu cầu tham gia của bạn đã bị từ chối",
    en: "Your request to join was declined",
    th: "คำขอเข้าร่วมของคุณถูกปฏิเสธ",
  },

  // ── Reaction activity preview (community list bump) ─────────────────────
  SYS_REACTION_THIRD_PERSON: {
    vi: "{{actor}} đã thả {{emoji}} cho {{preview}}",
    en: "{{actor}} reacted {{emoji}} to {{preview}}",
    th: "{{actor}}แสดงความรู้สึก {{emoji}} ต่อ {{preview}}",
  },
  SYS_REACTION_SELF: {
    vi: "Bạn đã thả {{emoji}} cho {{preview}}",
    en: "You reacted {{emoji}} to {{preview}}",
    th: "คุณแสดงความรู้สึก {{emoji}} ต่อ {{preview}}",
  },
} as const satisfies MessageCatalog;

export type SystemMessageKey = keyof typeof SYSTEM_MESSAGES;
