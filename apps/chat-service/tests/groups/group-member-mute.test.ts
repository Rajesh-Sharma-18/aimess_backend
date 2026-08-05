/**
 * Integration tests — GROUP moderation mute (admin/mod silences a member),
 * the group counterpart of community's member mute.
 *
 * Routes (apps/chat-service/src/api/routes/group-member.routes.ts):
 *   POST /api/chat/group-members/mute-member    (Zod body)
 *   POST /api/chat/group-members/unmute-member  (Zod body)
 *
 * Covers what the previously half-shipped feature was missing: the realtime
 * fan-out that makes the mute land on every logged-in device with no refresh
 * (`group:member:muted` / `group:member:unmuted` on `conv:<roomId>` AND on the
 * target's own `user:<id>` channel), the stuck-typing-indicator retraction, and
 * the auto-unmute sweep.
 */
import request from "supertest";

import { GroupMemberService } from "../../src/services/group-member.service.js";
import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_room_mute";
const TARGET = "target-user-1";

/** Every `redis.publish` call as `{ channel, event, data }`. */
function publishes(): Array<{ channel: string; event: string; data: any }> {
  return mocks.redis.publish.mock.calls.map(
    ([channel, raw]: [string, string]) => ({
      channel,
      ...(JSON.parse(raw) as { event: string; data: any }),
    })
  );
}

function publishedEvent(event: string) {
  return publishes().filter((p) => p.event === event);
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([
    { userId: TEST_USER_ID },
    { userId: TARGET },
    { userId: "bystander-1" },
  ]);
});

/** Actor = OWNER (the authenticated caller), target = plain MEMBER. */
function programRoles(
  target: Record<string, unknown> = {
    userId: TARGET,
    role: "MEMBER",
    moderationMuted: false,
    moderationMutedUntil: null,
  }
): void {
  mocks.groupMemberRepo.findActiveByRoomAndUser.mockImplementation(
    async (_roomId: string, userId: string) =>
      userId === TEST_USER_ID ? { userId: TEST_USER_ID, role: "OWNER" } : target
  );
}

describe("POST /api/chat/group-members/mute-member", () => {
  it("POSITIVE: an OWNER mutes a MEMBER and the mute is persisted", async () => {
    programRoles();
    mocks.groupMemberRepo.setModerationMute.mockResolvedValue({
      userId: TARGET,
      moderationMuted: true,
    });

    const res = await request(app)
      .post("/api/chat/group-members/mute-member")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });

    expect(res.status).toBe(200);
    expect(mocks.groupMemberRepo.setModerationMute).toHaveBeenCalledWith(
      ROOM,
      TARGET,
      { mutedBy: TEST_USER_ID, mutedUntil: null }
    );
  });

  it("REALTIME: group:member:muted reaches the room AND the target's own user channel", async () => {
    programRoles();
    mocks.groupMemberRepo.setModerationMute.mockResolvedValue({});

    await request(app)
      .post("/api/chat/group-members/mute-member")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });

    const muted = publishedEvent("group:member:muted");
    // Room leg → every member's roster badge; user leg → EVERY device of the
    // muted member (web/Android/iOS), including ones that never joined the room.
    expect(muted.map((p) => p.channel).sort()).toEqual([
      `conv:${ROOM}`,
      `user:${TARGET}`,
    ]);
    expect(muted[0].data).toMatchObject({
      roomId: ROOM,
      conversationType: "GROUP",
      memberId: TARGET,
      isMuted: true,
      mutedUntil: null,
      actorId: TEST_USER_ID,
    });
  });

  it("REALTIME: a timed mute carries mutedUntil as epoch ms", async () => {
    programRoles();
    mocks.groupMemberRepo.setModerationMute.mockResolvedValue({});
    const until = new Date(Date.now() + 3_600_000);

    await request(app)
      .post("/api/chat/group-members/mute-member")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET, mutedUntil: until.toISOString() });

    expect(publishedEvent("group:member:muted")[0].data.mutedUntil).toBe(
      until.getTime()
    );
  });

  // Scenario 1 — muted mid-keystroke: peers must not keep a stuck "typing…".
  it("REALTIME: muting retracts the target's typing/recording indicators", async () => {
    programRoles();
    mocks.groupMemberRepo.setModerationMute.mockResolvedValue({});

    await request(app)
      .post("/api/chat/group-members/mute-member")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });

    expect(publishedEvent("recording:stop")[0].channel).toBe(`conv:${ROOM}`);
    // typing is delivered direct-to-recipient, so one stop per OTHER member.
    expect(
      publishedEvent("typing:stop")
        .map((p) => p.channel)
        .sort()
    ).toEqual([`user:${TEST_USER_ID}`, "user:bystander-1"]);
  });

  it("NEGATIVE: 400 when muting yourself", async () => {
    programRoles();

    const res = await request(app)
      .post("/api/chat/group-members/mute-member")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TEST_USER_ID });

    expect(res.status).toBe(400);
    expect(mocks.groupMemberRepo.setModerationMute).not.toHaveBeenCalled();
  });

  // 400 CHAT_INSUFFICIENT_PERMISSIONS — same status the sibling `kick` gate
  // uses (BadRequestError), kept identical rather than "fixed" to 403 here.
  it("SECURITY: rejects a plain MEMBER trying to mute someone", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      userId: TEST_USER_ID,
      role: "MEMBER",
    });

    const res = await request(app)
      .post("/api/chat/group-members/mute-member")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });

    expect(res.status).toBe(400);
    expect(mocks.groupMemberRepo.setModerationMute).not.toHaveBeenCalled();
  });

  it("SECURITY: a MODERATOR cannot mute another MODERATOR (role order)", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockImplementation(
      async (_roomId: string, userId: string) => ({
        userId,
        role: "MODERATOR",
      })
    );

    const res = await request(app)
      .post("/api/chat/group-members/mute-member")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });

    expect(res.status).toBe(400);
    expect(mocks.groupMemberRepo.setModerationMute).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat/group-members/unmute-member", () => {
  it("POSITIVE: clears the mute and fans out group:member:unmuted", async () => {
    programRoles({
      userId: TARGET,
      role: "MEMBER",
      moderationMuted: true,
      moderationMutedUntil: null,
    });
    mocks.groupMemberRepo.clearModerationMute.mockResolvedValue({});

    const res = await request(app)
      .post("/api/chat/group-members/unmute-member")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });

    expect(res.status).toBe(200);
    expect(mocks.groupMemberRepo.clearModerationMute).toHaveBeenCalledWith(
      ROOM,
      TARGET
    );
    const unmuted = publishedEvent("group:member:unmuted");
    expect(unmuted.map((p) => p.channel).sort()).toEqual([
      `conv:${ROOM}`,
      `user:${TARGET}`,
    ]);
    expect(unmuted[0].data).toMatchObject({ isMuted: false, mutedUntil: null });
  });

  it("NEGATIVE: 404 when the member is not currently muted", async () => {
    programRoles();

    const res = await request(app)
      .post("/api/chat/group-members/unmute-member")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });

    expect(res.status).toBe(404);
    expect(mocks.groupMemberRepo.clearModerationMute).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 404 when only a fully-EXPIRED timed mute remains", async () => {
    programRoles({
      userId: TARGET,
      role: "MEMBER",
      moderationMuted: true,
      moderationMutedUntil: new Date(Date.now() - 1000),
    });

    const res = await request(app)
      .post("/api/chat/group-members/unmute-member")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: TARGET });

    expect(res.status).toBe(404);
  });
});

/**
 * Auto-unmute sweep. Enforcement never depends on it (lazy expiry already lets
 * the member post again); the sweep exists purely to emit the realtime
 * `group:member:unmuted` so the composer re-enables without a refresh, and it
 * must fire side-effects EXACTLY once across instances via the atomic claim.
 */
describe("GroupMemberService.expireDueModerationMutes", () => {
  function buildService(overrides: Record<string, unknown> = {}) {
    const redis = {
      publish: jest.fn(async () => 0),
    } as unknown as import("ioredis").Redis;
    const memberRepo = {
      findExpiredModerationMutes: jest.fn(async () => [
        { id: "m1", roomId: ROOM, userId: TARGET },
        { id: "m2", roomId: ROOM, userId: "other-user" },
      ]),
      claimExpiredModerationMute: jest.fn(async () => 1),
      findActiveMembers: jest.fn(async () => []),
      ...overrides,
    };
    const service = new GroupMemberService(
      memberRepo as never,
      {} as never,
      {} as never,
      redis
    );
    return {
      service,
      memberRepo,
      redis: redis as unknown as { publish: jest.Mock },
    };
  }

  it("emits group:member:unmuted with actorId '' for each claimed row", async () => {
    const { service, redis } = buildService();

    await expect(service.expireDueModerationMutes(200)).resolves.toBe(2);

    const events = redis.publish.mock.calls.map(([channel, raw]) => ({
      channel,
      ...(JSON.parse(raw as string) as { event: string; data: any }),
    }));
    expect(events).toHaveLength(4); // 2 rows × (room leg + user leg)
    expect(events.every((e) => e.event === "group:member:unmuted")).toBe(true);
    // An automatic expiry has no acting moderator.
    expect(events[0].data).toMatchObject({ actorId: "", isMuted: false });
  });

  it("fires NO side-effects for a row another instance already claimed", async () => {
    const { service, redis } = buildService({
      claimExpiredModerationMute: jest.fn(async () => 0),
    });

    await expect(service.expireDueModerationMutes(200)).resolves.toBe(0);
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it("no-ops when nothing is due", async () => {
    const { service, memberRepo, redis } = buildService({
      findExpiredModerationMutes: jest.fn(async () => []),
    });

    await expect(service.expireDueModerationMutes(200)).resolves.toBe(0);
    expect(memberRepo.claimExpiredModerationMute).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });
});
