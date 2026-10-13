import {
  buildCallListPreviewText,
  buildCallTimelineText,
  buildGroupSystemFallbackText,
  personalizePrivateSystemMessageForViewer,
  resolveCallOutcome,
} from "../src/chat/group-system-message-text.js";
import {
  buildCallActivityText,
  isUnreadCallActivity,
} from "../src/chat/call-activity-text.js";

const OUT = "OUTGOING" as const;
const IN = "INCOMING" as const;

describe("resolveCallOutcome (contract §9)", () => {
  it("endReason wins over status", () => {
    expect(resolveCallOutcome({ status: "CANCELLED", endReason: "declined" })).toBe("declined");
    expect(resolveCallOutcome({ status: "BUSY", endReason: "busy" })).toBe("unanswered");
    expect(resolveCallOutcome({ status: "ENDED", endReason: "dropped", durationSec: 9 })).toBe("connected");
    expect(resolveCallOutcome({ status: "ENDED", endReason: "failed" })).toBe("unanswered");
  });
  it("falls back to status without an endReason", () => {
    for (const s of ["MISSED", "CANCELLED", "FAILED", "BUSY"]) {
      expect(resolveCallOutcome({ status: s })).toBe("unanswered");
    }
    expect(resolveCallOutcome({ status: "DECLINED" })).toBe("declined");
    expect(resolveCallOutcome({ status: "RINGING" })).toBe("live");
    expect(resolveCallOutcome({ status: "ENDED", durationSec: 5 })).toBe("connected");
    expect(resolveCallOutcome({ status: "ENDED" })).toBe("connected");
  });
});

describe("timeline / activity / preview per side", () => {
  const cases: [string, string | null, string, string][] = [
    // status, endReason, caller, callee (voice, en)
    ["BUSY", null, "No answer", "Missed voice call"],
    ["BUSY", "busy", "No answer", "Missed voice call"],
    ["CANCELLED", "canceled", "No answer", "Missed voice call"],
    ["MISSED", "no_answer", "No answer", "Missed voice call"],
    ["DECLINED", "declined", "Call declined", "You declined a voice call"],
    ["CANCELLED", "declined", "Call declined", "You declined a voice call"],
  ];
  it.each(cases)("%s/%s", (status, endReason, caller, callee) => {
    const base = { callType: "AUDIO", status, endReason };
    expect(buildCallTimelineText({ ...base, direction: OUT })).toBe(caller);
    expect(buildCallTimelineText({ ...base, direction: IN })).toBe(callee);
    expect(buildCallActivityText({ ...base, direction: OUT })).toBe(caller);
    expect(buildCallActivityText({ ...base, direction: IN })).toBe(callee);
    if (endReason) {
      const r = endReason as "busy";
      expect(buildCallListPreviewText({ callType: "AUDIO", endReason: r, viewerIsCaller: true })).toBe(caller);
      expect(buildCallListPreviewText({ callType: "AUDIO", endReason: r, viewerIsCaller: false })).toBe(callee);
    }
  });

  it("ENDED under 1s (failed / dropped / no endReason) is unanswered everywhere", () => {
    for (const p of [
      { status: "ENDED", durationSec: 0, endReason: "failed" },
      { status: "ENDED", durationSec: 0, endReason: "dropped" },
      { status: "ENDED", durationSec: 0 },
    ]) {
      const base = { callType: "AUDIO", ...p };
      expect(resolveCallOutcome(p)).toBe("unanswered");
      expect(buildCallTimelineText({ ...base, direction: OUT })).toBe("No answer");
      expect(buildCallTimelineText({ ...base, direction: IN })).toBe("Missed voice call");
      expect(buildCallActivityText({ ...base, direction: OUT })).toBe("No answer");
      expect(buildCallActivityText({ ...base, direction: IN })).toBe("Missed voice call");
      expect(isUnreadCallActivity(p.status, IN, 0, p.endReason, p.durationSec)).toBe(true);
      expect(isUnreadCallActivity(p.status, OUT, 0, p.endReason, p.durationSec)).toBe(false);
    }
    expect(buildCallListPreviewText({ callType: "AUDIO", endReason: "failed", viewerIsCaller: false })).toBe("Missed voice call");
    expect(buildCallActivityText({ callType: "AUDIO", status: "ENDED", durationSec: 134, direction: IN })).toBe("Voice call • 02:14");
  });

  it("BUSY stored text is neutral, never 'Voice Call 00:00'", () => {
    expect(buildCallTimelineText({ callType: "AUDIO", status: "BUSY" })).toBe("Voice call was not answered");
  });

  it("vi/th wording, incl. server Thai terms", () => {
    const busyVideo = { callType: "VIDEO", status: "BUSY" };
    expect(buildCallTimelineText({ ...busyVideo, direction: IN, locale: "vi" })).toBe("Cuộc gọi video nhỡ");
    expect(buildCallTimelineText({ ...busyVideo, direction: IN, locale: "th" })).toBe("วิดีโอคอลที่ไม่ได้รับ");
    expect(buildCallTimelineText({ ...busyVideo, direction: OUT, locale: "vi" })).toBe("Không trả lời");
    expect(buildCallTimelineText({ ...busyVideo, direction: OUT, locale: "th" })).toBe("ไม่มีผู้รับสาย");
    const declined = { callType: "AUDIO", status: "CANCELLED", endReason: "declined" };
    expect(buildCallActivityText({ ...declined, direction: IN, locale: "th" })).toBe("คุณปฏิเสธสายสนทนา");
    expect(buildCallActivityText({ ...declined, direction: OUT, locale: "vi" })).toBe("Cuộc gọi bị từ chối");
    expect(buildCallActivityText({ callType: "VIDEO", status: "ENDED", durationSec: 90, direction: IN, locale: "th" })).toBe("วิดีโอคอล • 01:30");
  });
});

describe("isUnreadCallActivity", () => {
  it("unanswered (incl. busy) badges the callee only; declined never", () => {
    expect(isUnreadCallActivity("BUSY", IN)).toBe(true);
    expect(isUnreadCallActivity("BUSY", OUT)).toBe(false);
    expect(isUnreadCallActivity("DECLINED", IN)).toBe(false);
    expect(isUnreadCallActivity("CANCELLED", IN, 3, "declined")).toBe(false);
    expect(isUnreadCallActivity("CANCELLED", IN, 3, "canceled")).toBe(true);
  });
});

describe("list preview personalization", () => {
  const data = { callType: "AUDIO", status: "BUSY", callerId: "a", endReason: "busy" };
  it("English private call previews are per viewer", () => {
    expect(personalizePrivateSystemMessageForViewer("CALL_ENDED", data, "Voice call was not answered", "a", "en")).toBe("No answer");
    expect(personalizePrivateSystemMessageForViewer("CALL_ENDED", data, "Voice call was not answered", "b", "en")).toBe("Missed voice call");
  });
});

describe("group call decliners", () => {
  const row = (status: string, declinedBy?: string[]) => ({
    callType: "AUDIO",
    status,
    callerId: "caller",
    ...(declinedBy ? { declinedBy } : {}),
  });
  const text = (data: Record<string, unknown>, viewer: string) =>
    buildGroupSystemFallbackText("CALL_ENDED", data, viewer, "en");

  it("everyone declined: decliners 'You declined', others missed, caller 'Call declined'", () => {
    const d = row("DECLINED", ["m1", "m2"]);
    expect(text(d, "m1")).toBe("You declined a voice call");
    expect(text(d, "m2")).toBe("You declined a voice call");
    expect(text(d, "m3")).toBe("Missed voice call");
    expect(text(d, "caller")).toBe("Call declined");
  });
  it("some declined, rest timed out: caller 'No answer'", () => {
    const d = row("MISSED", ["m1"]);
    expect(text(d, "m1")).toBe("You declined a voice call");
    expect(text(d, "m2")).toBe("Missed voice call");
    expect(text(d, "caller")).toBe("No answer");
  });
  it("a connected call reads the duration for everyone", () => {
    const d = { ...row("ENDED", ["m1"]), durationSec: 65 };
    expect(text(d, "m1")).toBe("Voice Call 01:05");
  });
});
