import {
  formatDurationShort,
  formatViewerDateTime,
  resolveTimeZone,
} from "../src/time-format.js";
import { runWithTimeZone } from "../src/locale-context.js";
import { personalizeCommunitySystemMessageForViewer } from "../src/community/system-message-text.js";
import {
  buildCallListPreviewText,
  buildGroupSystemFallbackText,
} from "../src/chat/group-system-message-text.js";
import { accountSuspendedMessage } from "../src/account-status-text.js";
import {
  communityCopy,
  renderNotificationCopy,
} from "../src/notification-copy.js";

const YEAR = new Date().getUTCFullYear();
const HCM = "Asia/Ho_Chi_Minh";
// 15:00 UTC = 22:00 in Ho Chi Minh City, Oct 8 of the current year.
const OCT8 = Date.UTC(YEAR, 9, 8, 15, 0);

describe("formatViewerDateTime", () => {
  it("renders the viewer's zone per locale, no year in the current year", () => {
    expect(formatViewerDateTime(OCT8, "en", HCM)).toBe("10:00 PM, Oct 8");
    expect(formatViewerDateTime(OCT8, "vi", HCM)).toBe("22:00, 8/10");
    expect(formatViewerDateTime(OCT8, "th", HCM)).toBe("22:00 น. 8 ต.ค.");
  });

  it("adds a Gregorian year only when it is not the viewer's current year", () => {
    const now = Date.UTC(2026, 5, 1);
    const jan2 = Date.UTC(2027, 0, 2, 3, 5);
    expect(formatViewerDateTime(jan2, "en", "UTC", now)).toBe("3:05 AM, Jan 2, 2027");
    expect(formatViewerDateTime(jan2, "vi", "UTC", now)).toBe("03:05, 2/1/2027");
    expect(formatViewerDateTime(jan2, "th", "UTC", now)).toBe("03:05 น. 2 ม.ค. 2027");
  });

  it("decides the year in the viewer's zone (Dec 31 UTC is already next year in Bangkok)", () => {
    const now = Date.UTC(2026, 11, 31, 10, 0);
    const at = Date.UTC(2026, 11, 31, 20, 0);
    expect(formatViewerDateTime(at, "en", "UTC", now)).toBe("8:00 PM, Dec 31");
    expect(formatViewerDateTime(at, "en", "Asia/Bangkok", now)).toBe("3:00 AM, Jan 1, 2027");
  });

  it("midnight reads 12 AM; invalid / missing zone falls back to UTC", () => {
    const midnight = Date.UTC(YEAR, 0, 5, 0, 0);
    expect(formatViewerDateTime(midnight, "en", "UTC")).toBe("12:00 AM, Jan 5");
    expect(formatViewerDateTime(midnight, "en", "Not/AZone")).toBe("12:00 AM, Jan 5");
    expect(resolveTimeZone("")).toBe("UTC");
    expect(resolveTimeZone(undefined)).toBe("UTC");
    expect(resolveTimeZone("Asia/Bangkok")).toBe("Asia/Bangkok");
  });

  it("defaults to the ambient request zone", () => {
    expect(runWithTimeZone(HCM, () => formatViewerDateTime(OCT8, "en"))).toBe(
      "10:00 PM, Oct 8"
    );
  });
});

describe("formatDurationShort", () => {
  it.each([
    [3720, "1h 2m", "1 giờ 2 phút", "1 ชม. 2 นาที"],
    [720, "12m", "12 phút", "12 นาที"],
    [3600, "1h", "1 giờ", "1 ชม."],
    [30, "<1m", "<1 phút", "<1 นาที"],
  ])("%i s", (seconds, en, vi, th) => {
    expect(formatDurationShort(seconds, "en")).toBe(en);
    expect(formatDurationShort(seconds, "vi")).toBe(vi);
    expect(formatDurationShort(seconds, "th")).toBe(th);
  });
});

const LAN = "u-lan";
const BINH = "u-binh";
const MOD = "u-other-mod";

const community = (
  type: Parameters<typeof personalizeCommunitySystemMessageForViewer>[0],
  metadata: Record<string, unknown>,
  viewer: string,
  locale: "en" | "vi" | "th" = "en"
) =>
  personalizeCommunitySystemMessageForViewer(
    type,
    metadata,
    "",
    String(metadata.actorName ?? ""),
    String(metadata.targetName ?? ""),
    viewer,
    locale,
    HCM
  );

describe("community lines: three points of view with actorRole", () => {
  const muted = {
    actorUserId: LAN,
    actorName: "Lan",
    actorRole: "MODERATOR",
    targetUserId: BINH,
    targetName: "Binh",
    mutedUntil: OCT8,
  };

  it("mute: actor / affected / other moderators, in the viewer's time zone", () => {
    expect(community("MEMBER_MUTED", muted, LAN)).toBe("You muted Binh until 10:00 PM, Oct 8");
    expect(community("MEMBER_MUTED", muted, BINH)).toBe(
      "Lan (Moderator) muted you until 10:00 PM, Oct 8"
    );
    expect(community("MEMBER_MUTED", muted, MOD)).toBe(
      "Lan (Moderator) muted Binh until 10:00 PM, Oct 8"
    );
    expect(community("MEMBER_MUTED", muted, BINH, "vi")).toBe(
      "Lan (Người kiểm duyệt) đã cấm nói bạn đến 22:00, 8/10"
    );
    expect(community("MEMBER_MUTED", muted, BINH, "th")).toBe(
      "Lan (ผู้ช่วยดูแล) ปิดสิทธิ์พูดของคุณจนถึง 22:00 น. 8 ต.ค."
    );
  });

  it("unmute: the affected member reads 'You can chat in X again'", () => {
    const unmuted = { ...muted, communityName: "X" };
    expect(community("MEMBER_UNMUTED", unmuted, BINH)).toBe("You can chat in X again");
    expect(community("MEMBER_UNMUTED", unmuted, MOD)).toBe("Lan (Moderator) unmuted Binh");
    expect(
      community("MEMBER_UNMUTED", { ...unmuted, actorUserId: "system", source: "auto" }, BINH, "th")
    ).toBe("คุณแชทใน X ได้อีกครั้งแล้ว");
  });

  it("admin rename names the actor with role; PLATFORM is AI Mess Administrator", () => {
    const renamed = { actorUserId: "u-minh", actorName: "Minh", actorRole: "ADMIN", newName: "X" };
    expect(community("COMMUNITY_NAME_UPDATED", renamed, "u-minh")).toBe(
      "You renamed the community to “X”"
    );
    expect(community("COMMUNITY_NAME_UPDATED", renamed, BINH, "vi")).toBe(
      "Minh (Quản trị viên) đã đổi tên cộng đồng thành “X”"
    );
    expect(
      community("MEMBER_BANNED", { actorUserId: "u-staff", actorName: "Staff", actorRole: "PLATFORM", targetUserId: BINH, targetName: "Binh" }, MOD)
    ).toBe("AI Mess Administrator banned Binh");
  });

  it("legacy rows without actorRole render as before", () => {
    expect(community("COMMUNITY_NAME_UPDATED", { newName: "X" }, BINH)).toBe(
      "Community renamed to “X”"
    );
    expect(
      community("MEMBER_UNBANNED", { actorUserId: LAN, actorName: "Lan", targetUserId: BINH, targetName: "Binh" }, MOD)
    ).toBe("Lan unbanned Binh");
    expect(
      community("ROLE_CHANGED", { newRole: "MODERATOR", oldRole: "MEMBER", targetUserId: BINH, targetName: "Binh" }, MOD)
    ).toBe("Binh is now a moderator");
  });

  it("role changes and handover", () => {
    const made = { actorUserId: "u-minh", actorName: "Minh", actorRole: "ADMIN", targetUserId: LAN, targetName: "Lan", newRole: "MODERATOR", oldRole: "MEMBER" };
    expect(community("ROLE_CHANGED", made, "u-minh")).toBe("You made Lan a moderator");
    expect(community("ROLE_CHANGED", made, LAN)).toBe("Minh (Admin) made you a moderator");
    expect(community("ROLE_CHANGED", made, BINH)).toBe("Minh (Admin) made Lan a moderator");
    const handover = { ...made, targetUserId: "u-hung", targetName: "Hung", newRole: "ADMIN", oldRole: "MODERATOR" };
    expect(community("ROLE_CHANGED", handover, "u-minh")).toBe(
      "You made Hung the admin. You’re now a moderator"
    );
    expect(
      community("ROLE_CHANGED", { newRole: "ADMIN", auto: true, targetUserId: "u-hung", targetName: "Hung" }, BINH)
    ).toBe("Hung is now the admin");
  });

  it("message deleted by a moderator", () => {
    const del = { actorUserId: LAN, actorName: "Lan", actorRole: "MODERATOR", senderId: BINH, senderName: "Binh", messageId: "m1" };
    expect(community("MESSAGE_DELETED", del, LAN)).toBe("You deleted a message");
    expect(community("MESSAGE_DELETED", del, BINH)).toBe("Lan (Moderator) deleted your message");
    expect(community("MESSAGE_DELETED", del, MOD, "vi")).toBe(
      "Lan (Người kiểm duyệt) đã xóa một tin nhắn"
    );
  });

  it("livestream lost: host vs everyone else", () => {
    const lost = { actorUserId: "u-thu", actorName: "Thu", hostUserId: "u-thu", endedReason: "CONNECTION_LOST", durationSeconds: 2700 };
    expect(community("LIVE_STREAM_ENDED", lost, "u-thu")).toBe(
      "Your livestream ended due to connection loss"
    );
    expect(community("LIVE_STREAM_ENDED", lost, BINH)).toBe("Thu’s livestream ended after 45m");
    expect(community("LIVE_STREAM_ENDED", lost, BINH, "vi")).toBe(
      "Buổi phát trực tiếp của Thu đã kết thúc sau 45 phút"
    );
  });
});

describe("group lines", () => {
  const leader = { actorId: "u-an", actorName: "An", targetUserId: "u-chi", targetName: "Chi" };

  it("leader handover: three points of view + automatic", () => {
    expect(buildGroupSystemFallbackText("LEADER_CHANGED", leader, "u-an")).toBe(
      "You made Chi the group leader"
    );
    expect(buildGroupSystemFallbackText("LEADER_CHANGED", leader, "u-chi")).toBe(
      "An made you the group leader"
    );
    expect(buildGroupSystemFallbackText("LEADER_CHANGED", leader, BINH, "th")).toBe(
      "An โอนตำแหน่งหัวหน้ากลุ่มให้ Chi"
    );
    const auto = { auto: true, actorId: null, targetId: "u-chi", targetName: "Chi" };
    expect(buildGroupSystemFallbackText("LEADER_CHANGED", auto, "u-chi")).toBe(
      "You’re now the group leader"
    );
    expect(buildGroupSystemFallbackText("LEADER_CHANGED", auto, BINH, "vi")).toBe(
      "Chi hiện là trưởng nhóm"
    );
  });

  it("leader deletes a member's message", () => {
    const del = { actorId: "u-an", actorName: "An", senderId: BINH, senderName: "Binh", messageId: "m" };
    expect(buildGroupSystemFallbackText("MESSAGE_DELETED", del, "u-an")).toBe("You deleted a message");
    expect(buildGroupSystemFallbackText("MESSAGE_DELETED", del, BINH)).toBe("An deleted your message");
    expect(buildGroupSystemFallbackText("MESSAGE_DELETED", del, MOD)).toBe("An deleted a message");
  });

  it("batch add lists the reader as 'you'", () => {
    const add = {
      actorId: "u-an",
      actorName: "An",
      targetUserIds: [BINH, "u-chi", "u-dung"],
      targetNames: ["Binh", "Chi", "Dung"],
    };
    expect(buildGroupSystemFallbackText("MEMBER_ADDED", add, BINH)).toBe("An added you, Chi and Dung");
    expect(buildGroupSystemFallbackText("MEMBER_ADDED", add, "u-an", "vi")).toBe(
      "Bạn đã thêm Binh, Chi và Dung"
    );
  });
});

describe("calls: declined vs missed", () => {
  it("previews per side", () => {
    const p = (endReason: "declined" | "no_answer", viewerIsCaller: boolean) =>
      buildCallListPreviewText({ callType: "VIDEO", endReason, viewerIsCaller });
    expect(p("declined", true)).toBe("Call declined");
    expect(p("declined", false)).toBe("You declined a video call");
    expect(p("no_answer", true)).toBe("No answer");
    expect(p("no_answer", false)).toBe("Missed video call");
  });
});

describe("push copy follows the device time zone", () => {
  it("mute push names the actor and renders the expiry in the reader's zone", () => {
    const copy = communityCopy.memberMuted(OCT8, "X", "Lan", "MODERATOR");
    const ticket = JSON.stringify(copy.descriptor);
    expect(renderNotificationCopy(ticket, "en", undefined, BINH, HCM)?.body).toBe(
      "Lan (Moderator) muted you in X until 10:00 PM, Oct 8"
    );
    expect(renderNotificationCopy(ticket, "en", undefined, BINH, "UTC")?.body).toBe(
      "Lan (Moderator) muted you in X until 3:00 PM, Oct 8"
    );
  });

  it("suspension message", () => {
    expect(accountSuspendedMessage(OCT8, "spam", "en", HCM)).toBe(
      "Your account is suspended until 10:00 PM, Oct 8. Reason: spam"
    );
  });
});

describe("deleted account name follows the reader's language", () => {
  it("in system lines and push copy", () => {
    const del = { actorId: "u-an", actorName: "Deleted Account", senderId: BINH, messageId: "m" };
    expect(buildGroupSystemFallbackText("MESSAGE_DELETED", del, MOD, "vi")).toBe(
      "Tài khoản đã bị xóa đã xóa một tin nhắn"
    );
    expect(buildGroupSystemFallbackText("MESSAGE_DELETED", del, MOD)).toBe(
      "Deleted Account deleted a message"
    );
    const copy = communityCopy.joinRequested("X", "Deleted Account");
    expect(copy("th").body).toBe("บัญชีที่ถูกลบขอเข้าร่วม X");
  });
});

describe("group meta lines from the admin panel", () => {
  it.each([
    ["ROOM_RENAMED", { newName: "Hikers" }],
    ["AVATAR_CHANGED", {}],
    ["DESCRIPTION_CHANGED", {}],
  ])("names the Administrator on a BO %s line", (event, data) => {
    const text = buildGroupSystemFallbackText(event, {
      ...data,
      source: "BO",
      actorName: "Real Admin Name",
    });
    expect(text).toContain("AI Mess Administrator");
    expect(text).not.toContain("Real Admin Name");
  });

  it("keeps naming the member on an in-app rename", () => {
    expect(
      buildGroupSystemFallbackText("ROOM_RENAMED", {
        actorId: "u1",
        actorName: "Minh",
        newName: "Hikers",
      })
    ).toContain("Minh");
  });
});
