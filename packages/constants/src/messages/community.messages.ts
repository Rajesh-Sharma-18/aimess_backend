import type { MessageCatalog } from "./types.js";

/** Community-service API messages. */
export const COMMUNITY_MESSAGES = {
  COMMUNITY_CREATED: {
    vi: "Tạo cộng đồng thành công",
    en: "Community created successfully",
    th: "สร้างคอมมูนิตี้เรียบร้อยแล้ว",
  },
  COMMUNITY_UPDATED: {
    vi: "Cập nhật cộng đồng thành công",
    en: "Community updated successfully",
    th: "อัปเดตคอมมูนิตี้เรียบร้อยแล้ว",
  },
  COMMUNITY_FETCHED: {
    vi: "Lấy thông tin cộng đồng thành công",
    en: "Community fetched successfully",
    th: "ดึงข้อมูลคอมมูนิตี้เรียบร้อยแล้ว",
  },
  COMMUNITY_NAME_AVAILABLE: {
    vi: "Tên cộng đồng này có thể sử dụng",
    en: "This community name is available.",
    th: "ชื่อคอมมูนิตี้นี้ใช้งานได้",
  },
  COMMUNITY_HANDLE_AVAILABLE: {
    vi: "Định danh cộng đồng này có thể sử dụng",
    en: "This community handle is available.",
    th: "แฮนเดิลคอมมูนิตี้นี้ใช้งานได้",
  },
  COMMUNITY_CATEGORIES_FETCHED: {
    vi: "Lấy danh mục cộng đồng thành công",
    en: "Community categories fetched successfully",
    th: "ดึงหมวดหมู่คอมมูนิตี้เรียบร้อยแล้ว",
  },
  COMMUNITY_LIST_FETCHED: {
    vi: "Lấy danh sách cộng đồng thành công",
    en: "Communities fetched successfully",
    th: "ดึงรายการคอมมูนิตี้เรียบร้อยแล้ว",
  },
  COMMUNITY_DISCOVER_FETCHED: {
    vi: "Khám phá cộng đồng thành công",
    en: "Communities discovered successfully",
    th: "ค้นพบคอมมูนิตี้เรียบร้อยแล้ว",
  },
  COMMUNITY_IMAGE_UPLOAD_URL_CREATED: {
    vi: "Đã tạo URL tải ảnh cộng đồng",
    en: "Community image upload URL created",
    th: "สร้างลิงก์อัปโหลดรูปภาพคอมมูนิตี้แล้ว",
  },
  COMMUNITY_NAME_TAKEN: {
    vi: "Tên cộng đồng này đã được sử dụng",
    en: "This community name is already taken",
    th: "ชื่อคอมมูนิตี้นี้ถูกใช้ไปแล้ว",
  },
  COMMUNITY_HANDLE_TAKEN: {
    vi: "Định danh cộng đồng này đã được sử dụng",
    en: "This community handle is already taken",
    th: "แฮนเดิลคอมมูนิตี้นี้ถูกใช้ไปแล้ว",
  },
  INVALID_HANDLE: {
    vi: "Định danh cộng đồng không hợp lệ",
    en: "Invalid community handle format",
    th: "รูปแบบแฮนเดิลคอมมูนิตี้ไม่ถูกต้อง",
  },
  COMMUNITY_HANDLE_REQUIRED: {
    vi: "Cộng đồng công khai cần có định danh hợp lệ để tạo liên kết chia sẻ",
    en: "A public community requires a valid handle to build its share link",
    th: "คอมมูนิตี้สาธารณะต้องมีแฮนเดิลที่ถูกต้องเพื่อสร้างลิงก์แชร์",
  },
  COMMUNITY_NOT_FOUND: {
    vi: "Không tìm thấy cộng đồng",
    en: "Community not found",
    th: "ไม่พบคอมมูนิตี้",
  },
  COMMUNITY_FORBIDDEN: {
    vi: "Bạn không có quyền thực hiện hành động này",
    en: "You do not have permission to perform this action",
    th: "คุณไม่มีสิทธิ์ดำเนินการนี้",
  },
  PLATFORM_ADMIN_REQUIRED: {
    vi: "Bạn không có quyền quản trị nền tảng",
    en: "Platform administrator access is required",
    th: "ต้องใช้สิทธิ์ผู้ดูแลระบบของแพลตฟอร์ม",
  },
  COMMUNITY_CATEGORY_INVALID: {
    vi: "Danh mục cộng đồng không hợp lệ",
    en: "Invalid community category",
    th: "หมวดหมู่คอมมูนิตี้ไม่ถูกต้อง",
  },
  CATEGORY_FETCHED: {
    vi: "Lấy danh sách danh mục thành công",
    en: "Categories fetched successfully",
    th: "ดึงหมวดหมู่เรียบร้อยแล้ว",
  },
  CATEGORY_CREATED: {
    vi: "Tạo danh mục thành công",
    en: "Category created successfully",
    th: "สร้างหมวดหมู่เรียบร้อยแล้ว",
  },
  CATEGORY_UPDATED: {
    vi: "Cập nhật danh mục thành công",
    en: "Category updated successfully",
    th: "อัปเดตหมวดหมู่เรียบร้อยแล้ว",
  },
  CATEGORY_DELETED: {
    vi: "Xóa danh mục thành công",
    en: "Category deleted successfully",
    th: "ลบหมวดหมู่เรียบร้อยแล้ว",
  },
  CATEGORY_NOT_FOUND: {
    vi: "Không tìm thấy danh mục",
    en: "Category not found",
    th: "ไม่พบหมวดหมู่",
  },
  CATEGORY_NAME_TAKEN: {
    vi: "Tên danh mục này đã được sử dụng",
    en: "This category name is already taken",
    th: "ชื่อหมวดหมู่นี้ถูกใช้ไปแล้ว",
  },
  CATEGORY_HAS_ACTIVE_COMMUNITIES: {
    vi: "Không thể xóa danh mục vì đang được gán cho các cộng đồng đang hoạt động",
    en: "Category cannot be deleted because it is assigned to active communities.",
    th: "ไม่สามารถลบหมวดหมู่นี้ได้ เนื่องจากถูกใช้กับคอมมูนิตี้ที่ยังใช้งานอยู่",
  },
  COMMUNITY_IMAGE_NOT_UPLOADED: {
    vi: "Chưa tải ảnh lên, vui lòng upload trước khi lưu",
    en: "Community image not uploaded yet",
    th: "ยังไม่ได้อัปโหลดรูปภาพคอมมูนิตี้",
  },
  COMMUNITY_IMAGE_INVALID_OBJECT_KEY: {
    vi: "Ảnh cộng đồng không hợp lệ",
    en: "Invalid community image reference",
    th: "การอ้างอิงรูปภาพคอมมูนิตี้ไม่ถูกต้อง",
  },
  COMMUNITY_IMAGE_FILE_TOO_LARGE: {
    vi: "Ảnh cộng đồng vượt quá kích thước cho phép",
    en: "Community image exceeds the maximum allowed size",
    th: "รูปภาพคอมมูนิตี้มีขนาดเกินกว่าที่กำหนด",
  },
  COMMUNITY_MEMBERS_FETCHED: {
    vi: "Lấy danh sách thành viên thành công",
    en: "Community members fetched successfully",
    th: "ดึงรายชื่อสมาชิกคอมมูนิตี้เรียบร้อยแล้ว",
  },
  COMMUNITY_MEMBER_ROLE_UPDATED: {
    vi: "Cập nhật vai trò thành viên thành công",
    en: "Member role updated successfully",
    th: "อัปเดตบทบาทสมาชิกเรียบร้อยแล้ว",
  },
  COMMUNITY_MEMBER_NOT_FOUND: {
    vi: "Không tìm thấy thành viên",
    en: "Community member not found",
    th: "ไม่พบสมาชิกคอมมูนิตี้",
  },
  COMMUNITY_MESSAGE_NOT_FOUND: {
    vi: "Không tìm thấy tin nhắn trong cộng đồng này",
    en: "Message not found in this community",
    th: "ไม่พบข้อความในคอมมูนิตี้นี้",
  },
  COMMUNITY_MEMBER_CANNOT_MODIFY_SELF: {
    vi: "Bạn không thể thay đổi vai trò của chính mình",
    en: "You cannot change your own role",
    th: "คุณไม่สามารถเปลี่ยนบทบาทของตัวเองได้",
  },
  COMMUNITY_MEMBER_CANNOT_MODIFY_ADMIN: {
    vi: "Không thể thay đổi vai trò của quản trị viên cộng đồng",
    en: "Cannot change the role of the community admin",
    th: "ไม่สามารถเปลี่ยนบทบาทของผู้ดูแลคอมมูนิตี้ได้",
  },
  COMMUNITY_MEMBER_KICKED: {
    vi: "Đã xóa thành viên khỏi cộng đồng",
    en: "Member removed from the community",
    th: "นำสมาชิกออกจากคอมมูนิตี้แล้ว",
  },
  COMMUNITY_MEMBER_BANNED: {
    vi: "Đã cấm thành viên khỏi cộng đồng",
    en: "Member banned from the community",
    th: "แบนสมาชิกออกจากคอมมูนิตี้แล้ว",
  },
  COMMUNITY_MEMBERS_ADDED: {
    vi: "Đã thêm thành viên vào cộng đồng",
    en: "Members added to the community",
    th: "เพิ่มสมาชิกเข้าคอมมูนิตี้แล้ว",
  },
  COMMUNITY_LEFT: {
    vi: "Đã rời khỏi cộng đồng",
    en: "Left the community",
    th: "ออกจากคอมมูนิตี้แล้ว",
  },
  COMMUNITY_BULK_LEFT: {
    vi: "Xử lý rời khỏi cộng đồng hàng loạt thành công",
    en: "Bulk community leave processed",
    th: "ดำเนินการออกจากคอมมูนิตี้หลายรายการแล้ว",
  },
  COMMUNITY_BULK_DELETED: {
    vi: "Xử lý xóa cộng đồng hàng loạt thành công",
    en: "Bulk community removal processed",
    th: "ดำเนินการนำคอมมูนิตี้ออกหลายรายการแล้ว",
  },
  COMMUNITY_OWNER_CANNOT_DELETE: {
    vi: "Bạn không thể xóa một cộng đồng mà bạn sở hữu. Hãy chuyển quyền sở hữu hoặc xóa cộng đồng từ trang quản trị.",
    en: "You cannot remove a community that you own. Transfer ownership or delete the community from the admin panel.",
    th: "คุณไม่สามารถนำคอมมูนิตี้ที่คุณเป็นเจ้าของออกได้ กรุณาโอนสิทธิ์ความเป็นเจ้าของหรือลบคอมมูนิตี้จากหน้าผู้ดูแล",
  },
  COMMUNITY_REMOVED_FOR_SELF: {
    vi: "Đã xóa cộng đồng khỏi danh sách của bạn",
    en: "Community removed from your list",
    th: "นำคอมมูนิตี้ออกจากรายการของคุณแล้ว",
  },
  COMMUNITY_MEMBER_UNBANNED: {
    vi: "Đã bỏ cấm thành viên",
    en: "Member unbanned",
    th: "ปลดแบนสมาชิกแล้ว",
  },
  COMMUNITY_ADMIN_CANNOT_LEAVE: {
    vi: "Quản trị viên không thể rời khỏi cộng đồng",
    en: "The community admin cannot leave the community",
    th: "ผู้ดูแลคอมมูนิตี้ไม่สามารถออกจากคอมมูนิตี้ได้",
  },
  COMMUNITY_MEMBER_NOT_BANNED: {
    vi: "Thành viên này hiện không bị cấm",
    en: "This member is not banned",
    th: "สมาชิกรายนี้ไม่ได้ถูกแบน",
  },
  COMMUNITY_AUDIT_LOGS_FETCHED: {
    vi: "Lấy nhật ký kiểm duyệt thành công",
    en: "Community audit logs fetched successfully",
    th: "ดึงบันทึกการตรวจสอบของคอมมูนิตี้เรียบร้อยแล้ว",
  },
  COMMUNITY_JOINED: {
    vi: "Đã tham gia cộng đồng",
    en: "Joined the community",
    th: "เข้าร่วมคอมมูนิตี้แล้ว",
  },
  COMMUNITY_JOIN_REQUIRES_INVITE: {
    vi: "Cộng đồng riêng tư yêu cầu lời mời",
    en: "This community is private and requires an invite",
    th: "คอมมูนิตี้นี้เป็นแบบส่วนตัวและต้องมีคำเชิญ",
  },
  COMMUNITY_JOIN_BANNED: {
    vi: "Bạn đã bị cấm khỏi cộng đồng này",
    en: "You are banned from this community",
    th: "คุณถูกแบนจากคอมมูนิตี้นี้",
  },
  // Uniform denial for EVERY action a banned member attempts on a community
  // (read messages, send, react, edit, media, socket join). Thrown by
  // chat-service's access-guard and surfaced verbatim as the ack/HTTP error
  // code so clients can branch on it.
  USER_BANNED: {
    vi: "Bạn đã bị cấm khỏi cộng đồng này",
    en: "You are banned from this community",
    th: "คุณถูกแบนจากคอมมูนิตี้นี้",
  },
  COMMUNITY_ADMIN_TRANSFERRED: {
    vi: "Đã chuyển quyền quản trị viên",
    en: "Community admin transferred",
    th: "โอนสิทธิ์ผู้ดูแลคอมมูนิตี้แล้ว",
  },
  COMMUNITY_DELETED: {
    vi: "Đã xóa cộng đồng",
    en: "Community deleted",
    th: "ลบคอมมูนิตี้แล้ว",
  },
  COMMUNITY_CLOSED: {
    vi: "Đã đóng cộng đồng",
    en: "Community closed",
    th: "ปิดคอมมูนิตี้แล้ว",
  },
  COMMUNITY_REOPENED: {
    vi: "Đã mở lại cộng đồng",
    en: "Community reopened",
    th: "เปิดคอมมูนิตี้อีกครั้งแล้ว",
  },
  // Thrown when an action is attempted on a community the owner has CLOSED.
  COMMUNITY_IS_CLOSED: {
    vi: "Cộng đồng này đã đóng",
    en: "This community is closed",
    th: "คอมมูนิตี้นี้ปิดอยู่",
  },
  // Thrown when an action is attempted on a community the platform SUSPENDED.
  COMMUNITY_SUSPENDED: {
    vi: "Cộng đồng này đang bị tạm khóa",
    en: "This community is suspended",
    th: "คอมมูนิตี้นี้ถูกระงับการใช้งาน",
  },
  // Thrown by chat-service when the community chat room is unavailable.
  COMMUNITY_CHAT_DISABLED: {
    vi: "Trò chuyện cộng đồng hiện không khả dụng",
    en: "Community chat is currently unavailable",
    th: "ขณะนี้แชทของคอมมูนิตี้ไม่พร้อมใช้งาน",
  },
  COMMUNITY_JOIN_REQUEST_CREATED: {
    vi: "Đã gửi yêu cầu tham gia",
    en: "Join request submitted",
    th: "ส่งคำขอเข้าร่วมแล้ว",
  },
  COMMUNITY_JOIN_REQUESTS_FETCHED: {
    vi: "Lấy danh sách yêu cầu tham gia thành công",
    en: "Join requests fetched successfully",
    th: "ดึงคำขอเข้าร่วมเรียบร้อยแล้ว",
  },
  COMMUNITY_MY_JOIN_REQUESTS_FETCHED: {
    vi: "Lấy yêu cầu tham gia của bạn thành công",
    en: "Your join requests fetched successfully",
    th: "ดึงคำขอเข้าร่วมของคุณเรียบร้อยแล้ว",
  },
  COMMUNITY_JOIN_REQUEST_APPROVED: {
    vi: "Đã duyệt yêu cầu tham gia",
    en: "Join request approved",
    th: "อนุมัติคำขอเข้าร่วมแล้ว",
  },
  COMMUNITY_JOIN_REQUEST_REJECTED: {
    vi: "Đã từ chối yêu cầu tham gia",
    en: "Join request rejected",
    th: "ปฏิเสธคำขอเข้าร่วมแล้ว",
  },
  COMMUNITY_JOIN_REQUESTS_BULK_APPROVED: {
    vi: "Đã duyệt hàng loạt yêu cầu tham gia",
    en: "Join requests bulk approved",
    th: "อนุมัติคำขอเข้าร่วมหลายรายการแล้ว",
  },
  COMMUNITY_JOIN_REQUESTS_BULK_REJECTED: {
    vi: "Đã từ chối hàng loạt yêu cầu tham gia",
    en: "Join requests bulk rejected",
    th: "ปฏิเสธคำขอเข้าร่วมหลายรายการแล้ว",
  },
  COMMUNITY_JOIN_REQUEST_CANCELLED: {
    vi: "Đã hủy yêu cầu tham gia",
    en: "Join request cancelled",
    th: "ยกเลิกคำขอเข้าร่วมแล้ว",
  },
  COMMUNITY_JOIN_REQUEST_NOT_FOUND: {
    vi: "Không tìm thấy yêu cầu tham gia",
    en: "Join request not found",
    th: "ไม่พบคำขอเข้าร่วม",
  },
  COMMUNITY_JOIN_REQUEST_NOT_PENDING: {
    vi: "Yêu cầu tham gia không còn ở trạng thái chờ",
    en: "Join request is not pending",
    th: "คำขอเข้าร่วมนี้ไม่ได้อยู่ระหว่างรอดำเนินการ",
  },
  COMMUNITY_JOIN_REQUEST_PUBLIC_NOT_ALLOWED: {
    vi: "Cộng đồng công khai không yêu cầu duyệt tham gia",
    en: "Public communities do not require join requests",
    th: "คอมมูนิตี้สาธารณะไม่ต้องใช้คำขอเข้าร่วม",
  },
  COMMUNITY_JOIN_REQUEST_NOT_OWNER: {
    vi: "Bạn không thể hủy yêu cầu của người khác",
    en: "You cannot cancel another user's join request",
    th: "คุณไม่สามารถยกเลิกคำขอเข้าร่วมของผู้ใช้รายอื่นได้",
  },
  COMMUNITY_ALREADY_MEMBER: {
    vi: "Người dùng đã là thành viên của cộng đồng",
    en: "User is already a member of the community",
    th: "ผู้ใช้รายนี้เป็นสมาชิกของคอมมูนิตี้อยู่แล้ว",
  },
  COMMUNITY_INVITE_CREATED: {
    vi: "Đã gửi lời mời",
    en: "Invite sent",
    th: "ส่งคำเชิญแล้ว",
  },
  COMMUNITY_INVITES_SENT: {
    vi: "Đã xử lý lời mời",
    en: "Invites processed",
    th: "ดำเนินการส่งคำเชิญแล้ว",
  },
  COMMUNITY_INVITES_FETCHED: {
    vi: "Lấy danh sách lời mời thành công",
    en: "Invites fetched successfully",
    th: "ดึงคำเชิญเรียบร้อยแล้ว",
  },
  COMMUNITY_MY_INVITES_FETCHED: {
    vi: "Lấy lời mời của bạn thành công",
    en: "Your invites fetched successfully",
    th: "ดึงคำเชิญของคุณเรียบร้อยแล้ว",
  },
  COMMUNITY_INVITE_ACCEPTED: {
    vi: "Đã chấp nhận lời mời",
    en: "Invite accepted",
    th: "ตอบรับคำเชิญแล้ว",
  },
  COMMUNITY_INVITE_DECLINED: {
    vi: "Đã từ chối lời mời",
    en: "Invite declined",
    th: "ปฏิเสธคำเชิญแล้ว",
  },
  COMMUNITY_INVITE_NOT_FOUND: {
    vi: "Không tìm thấy lời mời",
    en: "Invite not found",
    th: "ไม่พบคำเชิญ",
  },
  COMMUNITY_INVITE_NOT_PENDING: {
    vi: "Lời mời không còn ở trạng thái chờ",
    en: "Invite is not pending",
    th: "คำเชิญนี้ไม่ได้อยู่ระหว่างรอดำเนินการ",
  },
  COMMUNITY_INVITE_USER_BANNED: {
    vi: "Không thể mời người dùng đã bị cấm",
    en: "Cannot invite a banned user",
    th: "ไม่สามารถเชิญผู้ใช้ที่ถูกแบนได้",
  },
  COMMUNITY_INVITE_NOT_INVITEE: {
    vi: "Bạn không phải là người được mời",
    en: "You are not the invitee",
    th: "คุณไม่ใช่ผู้ได้รับคำเชิญนี้",
  },
  COMMUNITY_REPORT_CREATED: {
    vi: "Đã gửi báo cáo",
    en: "Report submitted",
    th: "ส่งรายงานแล้ว",
  },
  COMMUNITY_REPORTS_FETCHED: {
    vi: "Lấy danh sách báo cáo thành công",
    en: "Reports fetched successfully",
    th: "ดึงรายงานเรียบร้อยแล้ว",
  },
  COMMUNITY_MY_REPORTS_FETCHED: {
    vi: "Lấy báo cáo của bạn thành công",
    en: "Your reports fetched successfully",
    th: "ดึงรายงานของคุณเรียบร้อยแล้ว",
  },
  COMMUNITY_REPORT_REVIEWED: {
    vi: "Đã đánh dấu báo cáo là đã xem xét",
    en: "Report marked as reviewed",
    th: "ทำเครื่องหมายว่าตรวจสอบรายงานแล้ว",
  },
  COMMUNITY_REPORT_ACTIONED: {
    vi: "Đã xử lý báo cáo",
    en: "Report actioned",
    th: "ดำเนินการตามรายงานแล้ว",
  },
  COMMUNITY_REPORT_DISMISSED: {
    vi: "Đã bỏ qua báo cáo",
    en: "Report dismissed",
    th: "ยกเลิกรายงานแล้ว",
  },
  COMMUNITY_REPORT_WITHDRAWN: {
    vi: "Đã rút báo cáo",
    en: "Report withdrawn",
    th: "ถอนรายงานแล้ว",
  },
  COMMUNITY_REPORT_NOT_FOUND: {
    vi: "Không tìm thấy báo cáo",
    en: "Report not found",
    th: "ไม่พบรายงาน",
  },
  COMMUNITY_REPORT_NOT_OPEN: {
    vi: "Báo cáo không còn ở trạng thái mở",
    en: "Report is no longer open",
    th: "รายงานนี้ไม่ได้เปิดอยู่แล้ว",
  },
  COMMUNITY_REPORT_NOT_OWNER: {
    vi: "Bạn không thể rút báo cáo của người khác",
    en: "You cannot withdraw another user's report",
    th: "คุณไม่สามารถถอนรายงานของผู้ใช้รายอื่นได้",
  },
  COMMUNITY_REPORT_CANNOT_TARGET_SELF: {
    vi: "Bạn không thể báo cáo chính mình",
    en: "You cannot report yourself",
    th: "คุณไม่สามารถรายงานตัวเองได้",
  },
  COMMUNITY_REPORT_ALREADY_EXISTS: {
    vi: "Bạn đã báo cáo người dùng này trong cộng đồng rồi",
    en: "You have already reported this user in this community",
    th: "คุณรายงานผู้ใช้รายนี้ในคอมมูนิตี้นี้ไปแล้ว",
  },
  COMMUNITY_REPORT_OTHER_REASON_REQUIRED: {
    vi: "Vui lòng nhập mô tả khi chọn lý do 'Khác'",
    en: "A description is required when reason is OTHER",
    th: "ต้องระบุคำอธิบายเมื่อเลือกเหตุผลเป็น OTHER",
  },
  COMMUNITY_REPORT_INVALID_TRANSITION: {
    vi: "Không thể chuyển trạng thái báo cáo này",
    en: "Invalid report status transition",
    th: "การเปลี่ยนสถานะรายงานไม่ถูกต้อง",
  },
  COMMUNITY_REPORT_DELETED: {
    vi: "Đã xóa báo cáo",
    en: "Report deleted",
    th: "ลบรายงานแล้ว",
  },

  // --- Member moderation mute / warn --------------------------------------
  COMMUNITY_MEMBER_MUTED: {
    vi: "Đã tắt tiếng thành viên",
    en: "Member muted",
    th: "ปิดสิทธิ์พูดของสมาชิกแล้ว",
  },
  COMMUNITY_MEMBER_UNMUTED: {
    vi: "Đã bỏ tắt tiếng thành viên",
    en: "Member unmuted",
    th: "เปิดสิทธิ์พูดของสมาชิกแล้ว",
  },
  COMMUNITY_MEMBER_NOT_MUTED: {
    vi: "Thành viên này hiện không bị tắt tiếng",
    en: "This member is not muted",
    th: "สมาชิกรายนี้ไม่ได้ถูกปิดสิทธิ์พูด",
  },
  COMMUNITY_MUTED_MEMBERS_FETCHED: {
    vi: "Lấy danh sách thành viên bị tắt tiếng thành công",
    en: "Muted members fetched successfully",
    th: "ดึงรายชื่อสมาชิกที่ถูกปิดสิทธิ์พูดเรียบร้อยแล้ว",
  },
  COMMUNITY_BANNED_MEMBERS_FETCHED: {
    vi: "Lấy danh sách thành viên bị cấm thành công",
    en: "Banned members fetched successfully",
    th: "ดึงรายชื่อสมาชิกที่ถูกแบนเรียบร้อยแล้ว",
  },
  COMMUNITY_MEMBER_WARNED: {
    vi: "Đã cảnh cáo thành viên",
    en: "Member warned",
    th: "ตักเตือนสมาชิกแล้ว",
  },
  COMMUNITY_MEMBER_WARNINGS_FETCHED: {
    vi: "Lấy danh sách cảnh cáo thành viên thành công",
    en: "Member warnings fetched successfully",
    th: "ดึงประวัติการตักเตือนสมาชิกเรียบร้อยแล้ว",
  },

  // --- Notification preferences -------------------------------------------
  COMMUNITY_NOTIFICATION_PREFERENCES_FETCHED: {
    vi: "Lấy tùy chọn thông báo thành công",
    en: "Notification preferences fetched successfully",
    th: "ดึงการตั้งค่าการแจ้งเตือนเรียบร้อยแล้ว",
  },
  COMMUNITY_NOTIFICATION_PREFERENCES_UPDATED: {
    vi: "Đã cập nhật tùy chọn thông báo",
    en: "Notification preferences updated",
    th: "อัปเดตการตั้งค่าการแจ้งเตือนแล้ว",
  },

  // --- Mute ---------------------------------------------------------------
  COMMUNITY_MUTE_UPDATED: {
    vi: "Đã cập nhật cài đặt tắt thông báo",
    en: "Mute setting updated",
    th: "อัปเดตการปิดเสียงแล้ว",
  },
  COMMUNITY_MUTE_CLEARED: {
    vi: "Đã bật lại thông báo",
    en: "Mute cleared",
    th: "ยกเลิกการปิดเสียงแล้ว",
  },
  COMMUNITY_MUTE_FETCHED: {
    vi: "Lấy cài đặt tắt thông báo thành công",
    en: "Mute setting fetched",
    th: "ดึงการตั้งค่าการปิดเสียงแล้ว",
  },
  COMMUNITY_NOT_MUTED: {
    vi: "Cộng đồng này hiện không bị tắt thông báo",
    en: "Community is not muted",
    th: "คอมมูนิตี้นี้ไม่ได้ถูกปิดเสียง",
  },
  COMMUNITY_MARK_READ_UPDATED: {
    vi: "Đã đánh dấu đọc thành công",
    en: "Marked as read",
    th: "ทำเครื่องหมายว่าอ่านแล้ว",
  },

  // --- Invite links --------------------------------------------------------
  COMMUNITY_INVITE_LINK_CREATED: {
    vi: "Đã tạo liên kết mời",
    en: "Invite link created",
    th: "สร้างลิงก์เชิญแล้ว",
  },
  COMMUNITY_INVITE_LINKS_FETCHED: {
    vi: "Lấy danh sách liên kết mời thành công",
    en: "Invite links fetched",
    th: "ดึงลิงก์เชิญแล้ว",
  },
  COMMUNITY_INVITE_LINK_REVOKED: {
    vi: "Đã thu hồi liên kết mời",
    en: "Invite link revoked",
    th: "เพิกถอนลิงก์เชิญแล้ว",
  },
  COMMUNITY_INVITE_LINK_REDEEMED: {
    vi: "Đã tham gia cộng đồng qua liên kết mời",
    en: "Joined community via invite link",
    th: "เข้าร่วมคอมมูนิตี้ผ่านลิงก์เชิญแล้ว",
  },
  COMMUNITY_INVITE_LINK_NOT_FOUND: {
    vi: "Không tìm thấy liên kết mời",
    en: "Invite link not found",
    th: "ไม่พบลิงก์เชิญ",
  },
  COMMUNITY_INVITE_LINK_REVOKED_ERROR: {
    vi: "Liên kết mời này đã bị thu hồi",
    en: "This invite link has been revoked",
    th: "ลิงก์เชิญนี้ถูกเพิกถอนแล้ว",
  },
  COMMUNITY_INVITE_LINK_EXPIRED: {
    vi: "Liên kết mời đã hết hạn",
    en: "Invite link has expired",
    th: "ลิงก์เชิญหมดอายุแล้ว",
  },
  COMMUNITY_INVITE_LINK_EXHAUSTED: {
    vi: "Liên kết mời đã đạt giới hạn sử dụng",
    en: "Invite link usage limit reached",
    th: "ลิงก์เชิญถูกใช้ครบจำนวนแล้ว",
  },
  COMMUNITY_INVITE_LINK_BULK_SENT: {
    vi: "Đã gửi liên kết mời hàng loạt",
    en: "Invite links sent",
    th: "ส่งลิงก์เชิญแล้ว",
  },
  COMMUNITY_INVITE_LINK_INACTIVE: {
    vi: "Liên kết mời này không còn hoạt động",
    en: "Invite link is no longer active",
    th: "ลิงก์เชิญนี้ไม่ได้ใช้งานแล้ว",
  },
  COMMUNITY_INVITE_LINK_RATE_LIMITED: {
    vi: "Bạn đang tạo hoặc gửi liên kết mời quá nhanh. Vui lòng thử lại sau.",
    en: "You are creating or sending invite links too quickly. Please try again later.",
    th: "คุณสร้างหรือส่งลิงก์เชิญเร็วเกินไป กรุณาลองใหม่ภายหลัง",
  },
  COMMUNITY_INVITE_LINK_LIMIT_REACHED: {
    vi: "Bạn đã đạt số lượng liên kết mời đang hoạt động tối đa cho cộng đồng này. Hãy thu hồi bớt liên kết cũ.",
    en: "You have reached the maximum number of active invite links for this community. Revoke an existing link first.",
    th: "คุณมีลิงก์เชิญที่ใช้งานอยู่ครบจำนวนสูงสุดสำหรับคอมมูนิตี้นี้แล้ว กรุณาเพิกถอนลิงก์เดิมก่อน",
  },
  COMMUNITY_INVITE_LINK_PREVIEW_FETCHED: {
    vi: "Đã lấy thông tin cộng đồng qua liên kết mời",
    en: "Community details fetched",
    th: "ดึงรายละเอียดคอมมูนิตี้แล้ว",
  },
  COMMUNITY_PERMANENT_INVITATION_LINK_FETCHED: {
    vi: "Đã lấy liên kết mời vĩnh viễn của cộng đồng",
    en: "Permanent invitation link fetched",
    th: "ดึงลิงก์เชิญถาวรแล้ว",
  },
  COMMUNITY_LIKED: {
    vi: "Đã thêm cộng đồng vào yêu thích",
    en: "Community added to liked",
    th: "เพิ่มคอมมูนิตี้ในรายการที่ถูกใจแล้ว",
  },
  COMMUNITY_UNLIKED: {
    vi: "Đã xóa cộng đồng khỏi yêu thích",
    en: "Community removed from liked",
    th: "นำคอมมูนิตี้ออกจากรายการที่ถูกใจแล้ว",
  },
  COMMUNITY_LIKED_LIST_FETCHED: {
    vi: "Đã tải danh sách cộng đồng yêu thích",
    en: "Liked communities fetched",
    th: "ดึงรายการคอมมูนิตี้ที่ถูกใจแล้ว",
  },
} as const satisfies MessageCatalog;

export type CommunityMessageKey = keyof typeof COMMUNITY_MESSAGES;
