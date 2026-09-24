/**
 * Media authorization for a group attachment (`CheckMediaAccess`, the RPC
 * media-service calls before minting a presigned download URL).
 *
 * It asked one question — "is this user a member of this room?" — so an
 * objectKey was a way around the membership HISTORY boundary: a member who
 * joined today could fetch an attachment from years before they arrived, while
 * the timeline, search, media list and pins all refuse them the message it
 * belongs to. A presigned URL is the content.
 *
 *   npx jest group-media-history-guard
 */
import { ForbiddenError } from "@aimess/errors";

import { assertGroupMediaWithinHistory } from "../../src/lib/media-history-guard.js";

const ROOM_ID = "grp_room_1";
const OBJECT_KEY = "group-chat-uploads/usr_old/secret.jpg";

const JOINED_AT = new Date("2026-01-10T10:00:00.000Z");
const BEFORE_JOIN = new Date("2026-01-10T09:00:00.000Z");
const AFTER_JOIN = new Date("2026-01-10T11:00:00.000Z");

const newMember = { joinedAt: JOINED_AT, clearedAt: null, clearChatAt: null };

const guard = (over: Record<string, unknown> = {}, probeAnswer = false) => {
  const probe = jest.fn().mockResolvedValue(probeAnswer);
  const run = () =>
    assertGroupMediaWithinHistory({
      member: newMember,
      roomId: ROOM_ID,
      objectKey: OBJECT_KEY,
      objectCreatedAtMs: AFTER_JOIN.getTime(),
      probe,
      ...over,
    } as never);
  return { run, probe };
};

describe("group attachment download: the history boundary applies to the object", () => {
  it("refuses a pre-join object no readable message carries", async () => {
    const { run, probe } = guard({
      objectCreatedAtMs: BEFORE_JOIN.getTime(),
    });

    await expect(run()).rejects.toBeInstanceOf(ForbiddenError);
    expect(probe).toHaveBeenCalledWith({
      roomId: ROOM_ID,
      objectKey: OBJECT_KEY,
      cutoff: JOINED_AT,
    });
  });

  // The straddle the timestamp comparison alone would get wrong: a long upload
  // that finished before the join, sent after it. Refusing that forever would
  // leave a permanently broken attachment in the member's own history.
  it("allows a pre-join object that a readable message does carry", async () => {
    const { run } = guard({ objectCreatedAtMs: BEFORE_JOIN.getTime() }, true);
    await expect(run()).resolves.toBeUndefined();
  });

  it("allows an object uploaded after the boundary without touching the DB", async () => {
    const { run, probe } = guard();
    await expect(run()).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it("has nothing to enforce for a membership with no boundary", async () => {
    const { run, probe } = guard({
      member: { joinedAt: null, clearedAt: null, clearChatAt: null },
      objectCreatedAtMs: BEFORE_JOIN.getTime(),
    });
    await expect(run()).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  // An older media-service sends neither field. Keeping the previous
  // membership-only answer is deliberate — refusing every download the moment
  // one service is behind would be an outage, not a security win.
  it.each([
    ["no object key", { objectKey: "" }],
    ["no upload instant", { objectCreatedAtMs: 0 }],
  ])("falls back to membership when the caller sends %s", async (_l, over) => {
    const { run, probe } = guard(over);
    await expect(run()).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  // A clear-chat cutoff later than the join is the boundary that counts.
  it("uses the LATEST boundary the membership carries", async () => {
    const clearedAt = new Date("2026-02-01T00:00:00.000Z");
    const { run, probe } = guard({
      member: { joinedAt: JOINED_AT, clearedAt, clearChatAt: null },
      objectCreatedAtMs: AFTER_JOIN.getTime(),
    });

    await expect(run()).rejects.toBeInstanceOf(ForbiddenError);
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ cutoff: clearedAt })
    );
  });
});
