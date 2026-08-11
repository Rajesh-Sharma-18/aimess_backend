/**
 * Integration tests — WhatsApp-style grouped "X added A, B and C" system line.
 *
 * One add-member OPERATION must produce exactly ONE MEMBER_ADDED row carrying
 * every member that operation actually added (`systemData.targetUserIds`), so
 * the grouping survives reload/reconnect instead of being reconstructed by the
 * client from timing. Separate operations must stay separate rows.
 *
 * Route: POST /api/chat/group-members/add  (userIds[] = batch form)
 */
import request from "supertest";

import {
  buildGroupSystemFallbackText,
  personalizeGroupSystemMessageForViewer,
} from "@aimess/constants";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_room_batch";

/** Snapshot map so resolved display names land in systemData.targetNames. */
function snapshotsFor(names: Record<string, string>) {
  return new Map(
    Object.entries(names).map(([userId, displayName]) => [
      userId,
      { userId, displayName, avatar: "", memberId: displayName },
    ])
  );
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(
    snapshotsFor({
      [TEST_USER_ID]: "Krish",
      "user-b": "User B",
      "user-c": "User C",
      "user-d": "User D",
      "user-e": "User E",
    })
  );
  mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
    roomId: ROOM,
    name: "Squad",
    memberCount: 2,
    memberLimit: 256,
  });
  mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
    role: "ADMIN",
  });
  mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue(null);
  mocks.groupMemberRepo.upsert.mockImplementation(
    async (roomId: string, userId: string) => ({
      roomId,
      userId,
      role: "MEMBER",
      joinedAt: new Date(),
    })
  );
  mocks.groupRoomRepo.allocateSequence.mockResolvedValue(7);
  mocks.groupMessageRepo.create.mockImplementation(async (row: any) => ({
    ...row,
    id: "sys-msg-1",
    createdAt: new Date(),
    revision: 1,
  }));
});

/** Every SYSTEM row the request persisted. */
function systemRows() {
  return mocks.groupMessageRepo.create.mock.calls
    .map((call: unknown[]) => call[0] as Record<string, any>)
    .filter((row) => row.messageType === "SYSTEM");
}

describe("POST /api/chat/group-members/add — batch", () => {
  it("POSITIVE: three members added in ONE operation post ONE grouped system message", async () => {
    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userIds: ["user-b", "user-c", "user-d"] });

    expect(res.status).toBe(201);
    expect(res.body.data.added).toHaveLength(3);
    expect(res.body.data.skipped).toEqual([]);

    const rows = systemRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.systemEvent).toBe("MEMBER_ADDED");
    expect(rows[0]!.systemData.targetUserIds).toEqual([
      "user-b",
      "user-c",
      "user-d",
    ]);
    expect(rows[0]!.systemData.targetNames).toEqual([
      "User B",
      "User C",
      "User D",
    ]);
    expect(rows[0]!.content.text).toBe("Krish added User B, User C and User D");
  });

  it("POSITIVE: only members actually added are named — a skipped id never appears", async () => {
    // user-c is already an ACTIVE member → CHAT_ALREADY_MEMBER, not added.
    mocks.groupMemberRepo.findByRoomAndUser.mockImplementation(
      async (_roomId: string, userId: string) =>
        userId === "user-c" ? { userId, status: "ACTIVE" } : null
    );

    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userIds: ["user-b", "user-c", "user-d"] });

    expect(res.status).toBe(201);
    expect(res.body.data.skipped).toEqual([
      { userId: "user-c", reason: "CHAT_ALREADY_MEMBER" },
    ]);

    const rows = systemRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.systemData.targetUserIds).toEqual(["user-b", "user-d"]);
    expect(rows[0]!.content.text).toBe("Krish added User B and User D");
  });

  it("EDGE: a batch of one keeps the classic single-target shape", async () => {
    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userIds: ["user-b"] });

    expect(res.status).toBe(201);
    const rows = systemRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.systemData.targetUserId).toBe("user-b");
    expect(rows[0]!.systemData.targetUserIds).toBeUndefined();
    expect(rows[0]!.content.text).toBe("Krish added User B");
  });

  it("EDGE: duplicate ids in one request add (and announce) the member once", async () => {
    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userIds: ["user-b", "user-b", "user-c"] });

    expect(res.status).toBe(201);
    expect(mocks.groupMemberRepo.upsert).toHaveBeenCalledTimes(2);
    expect(systemRows()[0]!.systemData.targetUserIds).toEqual([
      "user-b",
      "user-c",
    ]);
  });

  it("NEGATIVE: no member added ⇒ no system message at all", async () => {
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      userId: "x",
      status: "ACTIVE",
    });

    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userIds: ["user-b", "user-c"] });

    expect(res.status).toBe(201);
    expect(res.body.data.added).toEqual([]);
    expect(systemRows()).toHaveLength(0);
  });

  it("SECURITY: a plain MEMBER gets 403 for the whole batch — nobody is added", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });

    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userIds: ["user-b", "user-c"] });

    expect(res.status).toBe(403);
    expect(mocks.groupMemberRepo.upsert).not.toHaveBeenCalled();
    expect(systemRows()).toHaveLength(0);
  });

  it("NEGATIVE: 400 when neither userId nor userIds is supplied", async () => {
    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM });

    expect(res.status).toBe(400);
  });

  it("REGRESSION: two separate operations stay two separate rows", async () => {
    await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userIds: ["user-b"] });
    await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userIds: ["user-c"] });

    const rows = systemRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.content.text).toBe("Krish added User B");
    expect(rows[1]!.content.text).toBe("Krish added User C");
  });
});

describe("grouped MEMBER_ADDED text — per-viewer wording", () => {
  const systemData = {
    actorId: "admin-1",
    actorName: "Krish",
    targetUserIds: ["user-b", "user-c", "user-d"],
    targetNames: ["User B", "User C", "User D"],
  };
  const stored = buildGroupSystemFallbackText("MEMBER_ADDED", systemData);

  it("the actor reads the first-person form", () => {
    expect(
      personalizeGroupSystemMessageForViewer(
        "MEMBER_ADDED",
        systemData,
        stored,
        "admin-1"
      )
    ).toBe("You added User B, User C and User D");
  });

  it("an existing member reads the third-person form naming the actor", () => {
    expect(
      personalizeGroupSystemMessageForViewer(
        "MEMBER_ADDED",
        systemData,
        stored,
        "bystander"
      )
    ).toBe("Krish added User B, User C and User D");
  });

  it("a newly added member is named 'you' — the actor stays the admin", () => {
    const text = personalizeGroupSystemMessageForViewer(
      "MEMBER_ADDED",
      systemData,
      stored,
      "user-c"
    );
    expect(text).toBe("Krish added you, User B and User D");
    expect(text).not.toContain("You added");
  });

  it("overflows into 'and N others', keeping the viewer named", () => {
    const many = {
      ...systemData,
      targetUserIds: ["user-b", "user-c", "user-d", "user-e", "user-f"],
      targetNames: ["User B", "User C", "User D", "User E", "User F"],
    };
    expect(buildGroupSystemFallbackText("MEMBER_ADDED", many)).toBe(
      "Krish added User B, User C, User D and 2 others"
    );
    expect(buildGroupSystemFallbackText("MEMBER_ADDED", many, "user-f")).toBe(
      "Krish added you, User B, User C and 2 others"
    );
  });

  it("localizes instead of concatenating English", () => {
    expect(
      buildGroupSystemFallbackText("MEMBER_ADDED", systemData, null, "vi")
    ).toBe("Krish đã thêm User B, User C và User D");
    expect(
      buildGroupSystemFallbackText("MEMBER_ADDED", systemData, "admin-1", "th")
    ).toBe("คุณเพิ่มUser B, User C และUser D");
  });
});
