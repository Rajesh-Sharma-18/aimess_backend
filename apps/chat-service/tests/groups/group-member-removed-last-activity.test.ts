/** A removal is the row's latest line: the leader reads "You removed X", like "You added X". */
import { buildGroupSystemFallbackText, chatSystemMessageBumpsActivity } from "@aimess/constants";

const LEADER = "leader-1";
const TARGET = "target-1";
const data = { actorId: LEADER, actorName: "Harshil Vekariya", targetUserId: TARGET, targetName: "Harshil Vekariya 10" };

describe("group member removal bumps last activity", () => {
  it("MEMBER_REMOVED bumps the inbox row, like MEMBER_ADDED", () => {
    expect(chatSystemMessageBumpsActivity("MEMBER_REMOVED")).toBe(true);
    expect(chatSystemMessageBumpsActivity("MEMBER_ADDED")).toBe(true);
  });

  it("each viewer's row reads the removal from their own side", () => {
    expect(buildGroupSystemFallbackText("MEMBER_REMOVED", data, LEADER)).toBe("You removed Harshil Vekariya 10");
    expect(buildGroupSystemFallbackText("MEMBER_REMOVED", data, TARGET)).toBe("Harshil Vekariya removed you");
    expect(buildGroupSystemFallbackText("MEMBER_REMOVED", data, "member-2")).toBe(
      "Harshil Vekariya removed Harshil Vekariya 10"
    );
  });

  it("AIMESS-326: a leave is the row's latest line; the leader's delete line waits on AIMESS-269", () => {
    expect(chatSystemMessageBumpsActivity("MEMBER_LEFT")).toBe(true);
    expect(chatSystemMessageBumpsActivity("MESSAGE_DELETED")).toBe(false);
  });
});
