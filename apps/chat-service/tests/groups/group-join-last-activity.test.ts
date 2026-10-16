/** AIMESS-274: a group join is the row's latest activity — "You joined the group" for the joiner. */
import {
  buildGroupSystemFallbackText,
  chatSystemMessageBumpsActivity,
  resolveGroupSystemSubjectUserId,
} from "@aimess/constants";

import { GroupRoomService } from "../../src/services/group-room.service.js";

const JOINER = "joiner-1";
const joinData = { actorId: JOINER, actorName: "Rajesh Vasundhara", targetUserId: JOINER, targetName: "Rajesh Vasundhara" };

describe("group join bumps last activity", () => {
  it("MEMBER_JOINED bumps the inbox row", () => {
    expect(chatSystemMessageBumpsActivity("MEMBER_JOINED")).toBe(true);
  });

  it("the joiner is the line's subject, so their live row gets the self wording", () => {
    expect(resolveGroupSystemSubjectUserId("MEMBER_JOINED", joinData)).toBe(JOINER);
    expect(buildGroupSystemFallbackText("MEMBER_JOINED", joinData, JOINER)).toBe("You joined the group");
    expect(buildGroupSystemFallbackText("MEMBER_JOINED", joinData, "someone-else")).toBe(
      "Rajesh Vasundhara joined the group"
    );
  });
});

describe("history-boundary cap keeps the joiner's own join line", () => {
  const cap = (preview: Record<string, unknown>, member: Record<string, unknown>, userId: string) =>
    (Object.create(GroupRoomService.prototype) as {
      applyHistoryBoundaryPreviewCap: (r: unknown[], m: Map<string, unknown>, u: string) => Array<{ lastMessagePreview: unknown }>;
    }).applyHistoryBoundaryPreviewCap(
      [{ roomId: "r1", lastMessageAt: preview.createdAt, lastMessagePreview: preview }],
      new Map([["r1", member]]),
      userId
    )[0]!.lastMessagePreview;

  const at = new Date("2026-10-16T05:00:00.000Z");
  const joinLine = { createdAt: at, systemEvent: "MEMBER_JOINED", systemData: joinData, content: { text: "x" } };

  it("same-millisecond join line is not blanked for the joiner", () => {
    expect(cap(joinLine, { joinedAt: at }, JOINER)).toBe(joinLine);
  });

  it("a pre-join message is still hidden from the joiner", () => {
    const old = { createdAt: new Date(at.getTime() - 60_000), content: { text: "Krishn added Boyd" } };
    expect(cap(old, { joinedAt: at }, JOINER)).toBeNull();
  });

  it("a later Clear Chat still hides the join line", () => {
    const cleared = cap(joinLine, { joinedAt: at, clearChatAt: new Date(at.getTime() + 1000) }, JOINER);
    expect(cleared).not.toBe(joinLine);
  });

  it("another member's join line at the viewer's own join floor is not exempt", () => {
    const other = { ...joinLine, systemData: { ...joinData, targetUserId: "other" } };
    expect(cap(other, { joinedAt: at }, JOINER)).toBeNull();
  });
});
