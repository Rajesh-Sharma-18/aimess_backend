import type { MessageCatalog } from "./types.js";

/** Stream-service API messages — lifecycle, comments, bans, and reports. */
export const STREAM_MESSAGES = {
  // ── Success ────────────────────────────────────────────────────────────────
  STREAM_CREATED: {
    en: "Stream created successfully.",
    vi: "Tạo buổi phát trực tiếp thành công.",
    th: "สร้างสตรีมเรียบร้อยแล้ว",
  },
  STREAM_LIST_FETCHED: {
    en: "Streams fetched successfully.",
    vi: "Lấy danh sách buổi phát trực tiếp thành công.",
    th: "ดึงรายการสตรีมเรียบร้อยแล้ว",
  },
  STREAM_FETCHED: {
    en: "Stream fetched successfully.",
    vi: "Lấy thông tin buổi phát trực tiếp thành công.",
    th: "ดึงข้อมูลสตรีมเรียบร้อยแล้ว",
  },
  STREAM_SOURCE_RESOLVED: {
    en: "Stream source resolved successfully.",
    vi: "Phân giải nguồn phát trực tiếp thành công.",
    th: "แปลงแหล่งสตรีมเรียบร้อยแล้ว",
  },
  STREAM_UPDATED: {
    en: "Stream updated successfully.",
    vi: "Cập nhật buổi phát trực tiếp thành công.",
    th: "อัปเดตสตรีมเรียบร้อยแล้ว",
  },
  STREAM_DELETED: {
    en: "Stream deleted successfully.",
    vi: "Xóa buổi phát trực tiếp thành công.",
    th: "ลบสตรีมเรียบร้อยแล้ว",
  },
  STREAM_STOPPED: {
    en: "Stream stopped successfully.",
    vi: "Dừng buổi phát trực tiếp thành công.",
    th: "หยุดสตรีมเรียบร้อยแล้ว",
  },
  STREAM_WENT_LIVE: {
    en: "Stream is now live.",
    vi: "Buổi phát trực tiếp đang bắt đầu.",
    th: "สตรีมกำลังถ่ายทอดสดแล้ว",
  },
  STREAM_PUBLISH_CREDENTIALS_FETCHED: {
    en: "Publish credentials fetched successfully.",
    vi: "Lấy thông tin phát trực tiếp thành công.",
    th: "ดึงข้อมูลรับรองสำหรับการถ่ายทอดเรียบร้อยแล้ว",
  },
  STREAM_COMMENTS_FETCHED: {
    en: "Comments fetched successfully.",
    vi: "Lấy danh sách bình luận thành công.",
    th: "ดึงความคิดเห็นเรียบร้อยแล้ว",
  },
  STREAM_VIEWERS_FETCHED: {
    en: "Viewers fetched successfully.",
    vi: "Lấy danh sách người xem thành công.",
    th: "ดึงรายชื่อผู้ชมเรียบร้อยแล้ว",
  },
  STREAM_COMMENT_STATUS_UPDATED: {
    en: "Comment status updated.",
    vi: "Cập nhật trạng thái bình luận thành công.",
    th: "อัปเดตสถานะความคิดเห็นแล้ว",
  },
  STREAM_USER_BANNED: {
    en: "User banned from stream.",
    vi: "Cấm người dùng khỏi buổi phát trực tiếp thành công.",
    th: "แบนผู้ใช้ออกจากสตรีมแล้ว",
  },
  STREAM_USER_UNBANNED: {
    en: "User ban lifted.",
    vi: "Gỡ lệnh cấm người dùng thành công.",
    th: "ปลดแบนผู้ใช้แล้ว",
  },
  STREAM_MEMBER_MUTED: {
    en: "Member muted.",
    vi: "Đã tắt tiếng thành viên.",
    th: "ปิดสิทธิ์พูดของสมาชิกแล้ว",
  },
  STREAM_MEMBER_UNMUTED: {
    en: "Member unmuted.",
    vi: "Đã bỏ tắt tiếng thành viên.",
    th: "เปิดสิทธิ์พูดของสมาชิกแล้ว",
  },
  STREAM_BANS_FETCHED: {
    en: "Banned users fetched successfully.",
    vi: "Lấy danh sách người dùng bị cấm thành công.",
    th: "ดึงรายชื่อผู้ใช้ที่ถูกแบนเรียบร้อยแล้ว",
  },
  STREAM_COMMENT_REPORTED: {
    en: "Comment reported successfully.",
    vi: "Báo cáo bình luận thành công.",
    th: "รายงานความคิดเห็นเรียบร้อยแล้ว",
  },
  STREAM_COMMENT_REPORTS_FETCHED: {
    en: "Comment reports fetched successfully.",
    vi: "Lấy danh sách báo cáo bình luận thành công.",
    th: "ดึงรายงานความคิดเห็นเรียบร้อยแล้ว",
  },

  // ── Validation / bad request ────────────────────────────────────────────────
  STREAM_REQUEST_INVALID: {
    en: "Invalid request parameters.",
    vi: "Tham số yêu cầu không hợp lệ.",
    th: "พารามิเตอร์คำขอไม่ถูกต้อง",
  },
  STREAM_SOURCE_URL_REQUIRED: {
    en: "A source URL is required for this stream type.",
    vi: "URL nguồn là bắt buộc cho loại phát trực tiếp này.",
    th: "สตรีมประเภทนี้ต้องระบุ URL ต้นทาง",
  },
  STREAM_ALREADY_ENDED: {
    en: "This stream has already ended.",
    vi: "Buổi phát trực tiếp này đã kết thúc.",
    th: "สตรีมนี้จบไปแล้ว",
  },
  STREAM_NOT_PHONE_CAMERA_SOURCE: {
    en: "Publish credentials are only available for phone-camera streams.",
    vi: "Thông tin phát trực tiếp chỉ khả dụng cho buổi phát từ camera điện thoại.",
    th: "ข้อมูลรับรองสำหรับการถ่ายทอดใช้ได้เฉพาะสตรีมจากกล้องมือถือเท่านั้น",
  },
  STREAM_CANNOT_BAN_OWNER: {
    en: "You cannot ban the stream owner.",
    vi: "Không thể cấm chủ sở hữu buổi phát trực tiếp.",
    th: "คุณไม่สามารถแบนเจ้าของสตรีมได้",
  },

  // ── Not found ─────────────────────────────────────────────────────────────
  STREAM_NOT_FOUND: {
    en: "Stream not found.",
    vi: "Không tìm thấy buổi phát trực tiếp.",
    th: "ไม่พบสตรีม",
  },
  COMMENT_NOT_FOUND: {
    en: "Comment not found.",
    vi: "Không tìm thấy bình luận.",
    th: "ไม่พบความคิดเห็น",
  },

  // ── Forbidden / access ─────────────────────────────────────────────────────
  STREAM_NOT_OWNER: {
    en: "You are not the owner of this stream.",
    vi: "Bạn không phải là chủ sở hữu buổi phát trực tiếp này.",
    th: "คุณไม่ใช่เจ้าของสตรีมนี้",
  },
  STREAM_NOT_A_COMMUNITY_MEMBER: {
    en: "You must be a member of this community to start a stream.",
    vi: "Bạn phải là thành viên của cộng đồng này để phát trực tiếp.",
    th: "คุณต้องเป็นสมาชิกของคอมมูนิตี้นี้จึงจะเริ่มสตรีมได้",
  },
  STREAM_MUTE_FORBIDDEN: {
    en: "You do not have permission to mute members in this community.",
    vi: "Bạn không có quyền tắt tiếng thành viên trong cộng đồng này.",
    th: "คุณไม่มีสิทธิ์ปิดสิทธิ์พูดของสมาชิกในคอมมูนิตี้นี้",
  },
  STREAM_BANNED: {
    en: "You have been banned from this stream.",
    vi: "Bạn đã bị cấm khỏi buổi phát trực tiếp này.",
    th: "คุณถูกแบนจากสตรีมนี้",
  },
  COMMENTS_BANNED: {
    en: "You have been banned from commenting on this stream.",
    vi: "Bạn đã bị cấm bình luận trong buổi phát trực tiếp này.",
    th: "คุณถูกแบนจากการแสดงความคิดเห็นในสตรีมนี้",
  },
  COMMENTS_DISABLED: {
    en: "Comments are disabled for this stream.",
    vi: "Bình luận đã bị tắt trong buổi phát trực tiếp này.",
    th: "ปิดการแสดงความคิดเห็นสำหรับสตรีมนี้",
  },
  COMMENTS_MUTED: {
    en: "You have been muted by a moderator and cannot comment or react in this community's streams.",
    vi: "Bạn đã bị quản trị viên tắt tiếng và không thể bình luận hoặc thả cảm xúc trong buổi phát trực tiếp của cộng đồng này.",
    th: "คุณถูกผู้ดูแลปิดสิทธิ์พูด จึงไม่สามารถแสดงความคิดเห็นหรือรีแอคในสตรีมของคอมมูนิตี้นี้ได้",
  },
  COMMENT_DELETE_FORBIDDEN: {
    en: "You are not allowed to delete this comment.",
    vi: "Bạn không được phép xóa bình luận này.",
    th: "คุณไม่ได้รับอนุญาตให้ลบความคิดเห็นนี้",
  },
  REPORTS_VIEW_FORBIDDEN: {
    en: "You do not have permission to view these reports.",
    vi: "Bạn không có quyền xem các báo cáo này.",
    th: "คุณไม่มีสิทธิ์ดูรายงานเหล่านี้",
  },

  STREAM_SOURCE_UNRESOLVABLE: {
    en: "No playable video could be found at this link.",
    vi: "Không tìm thấy video có thể phát tại liên kết này.",
    th: "ไม่พบวิดีโอที่เล่นได้จากลิงก์นี้",
  },
  STREAM_SOURCE_HOST_FORBIDDEN: {
    en: "This link points to an address that cannot be resolved.",
    vi: "Liên kết này trỏ đến một địa chỉ không thể phân giải.",
    th: "ลิงก์นี้ชี้ไปยังที่อยู่ที่ไม่สามารถแปลงได้",
  },
  STREAM_RESOLVER_BUSY: {
    en: "Too many links are being checked right now. Please try again shortly.",
    vi: "Có quá nhiều liên kết đang được kiểm tra. Vui lòng thử lại sau giây lát.",
    th: "มีลิงก์จำนวนมากกำลังถูกตรวจสอบ กรุณาลองใหม่อีกครั้ง",
  },
  STREAM_RESOLVER_UNAVAILABLE: {
    en: "Link resolution is unavailable right now. Please try again later.",
    vi: "Chức năng phân giải liên kết hiện không khả dụng. Vui lòng thử lại sau.",
    th: "ขณะนี้ไม่สามารถแปลงลิงก์ได้ กรุณาลองใหม่ภายหลัง",
  },

  // ── Conflict ───────────────────────────────────────────────────────────────
  STREAM_COMMUNITY_CONCURRENCY_LIMIT: {
    en: "This community already has an active stream.",
    vi: "Cộng đồng này đã có một buổi phát trực tiếp đang hoạt động.",
    th: "คอมมูนิตี้นี้มีสตรีมที่กำลังถ่ายทอดอยู่แล้ว",
  },
  STREAM_ALREADY_ACTIVE: {
    en: "You already have an active stream in this community.",
    vi: "Bạn đã có một buổi phát trực tiếp đang hoạt động trong cộng đồng này.",
    th: "คุณมีสตรีมที่กำลังถ่ายทอดอยู่ในคอมมูนิตี้นี้แล้ว",
  },
  STREAM_IS_LIVE: {
    en: "This stream is already live.",
    vi: "Buổi phát trực tiếp này đã đang diễn ra.",
    th: "สตรีมนี้กำลังถ่ายทอดสดอยู่แล้ว",
  },
} as const satisfies MessageCatalog;

export type StreamMessageKey = keyof typeof STREAM_MESSAGES;
