jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findByUserId: jest.fn(),
    findPublicProfileByUserId: jest.fn(),
    findCustomStatus: jest.fn(),
    setCustomStatus: jest.fn(),
    clearCustomStatus: jest.fn(),
    claimExpiredCustomStatuses: jest.fn(),
  },
}));
jest.mock("../../src/repositories/friendship.repository.js", () => ({
  friendshipRepository: {
    findBlock: jest.fn(async () => null),
    findByPair: jest.fn(async () => null),
    hasMutualFriend: jest.fn(async () => false),
  },
}));
jest.mock("../../src/repositories/friends.repository.js", () => ({
  friendsRepository: { listAcceptedFriendIds: jest.fn(async () => []) },
}));
jest.mock("../../src/services/avatar.service.js", () => ({
  avatarService: { resolveViewUrlForClient: jest.fn(async () => null) },
}));
jest.mock("../../src/lib/user-cache.js", () => ({
  userCache: {
    getProfileRecord: jest.fn(async () => null),
    setProfileRecord: jest.fn(async () => undefined),
  },
  toCachedProfileRecord: (r: unknown) => r,
  fromCachedProfileRecord: (r: unknown) => r,
}));
jest.mock("../../src/lib/resolve-auth-account.js", () => ({
  resolveAuthAccountSummary: jest.fn(async () => ({ account: null })),
}));
jest.mock("@aimess/redis", () => ({
  ...jest.requireActual("@aimess/redis"),
  publishChatUserEvent: jest.fn(async () => 1),
  publishUserSocketEvent: jest.fn(async () => 1),
}));

import request from "supertest";
import { publishChatUserEvent, publishUserSocketEvent } from "@aimess/redis";

import { app } from "../../src/app.js";
import { runCustomStatusSweepOnce } from "../../src/jobs/custom-status-expiry-sweeper.js";
import { redis } from "../../src/config/redis.js";
import { messagingGrpcClient } from "../../src/grpc/messaging.client.js";
import { friendshipRepository } from "../../src/repositories/friendship.repository.js";
import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";
import { TEST_USER_ID, bearer, makeAccessToken } from "../helpers/auth.js";

const repo = userProfileRepository as unknown as Record<string, jest.Mock>;
const fRepo = friendshipRepository as unknown as Record<string, jest.Mock>;
const chatPub = publishChatUserEvent as unknown as jest.Mock;
const notifyPub = publishUserSocketEvent as unknown as jest.Mock;

const PEER_ID = "33333333-3333-4333-8333-333333333333";
const URL = "/api/v1/users/profiles/me/custom-status";
const EVENT = "user:custom_status_updated";
const auth = () => bearer(makeAccessToken());
const put = (body: unknown) => request(app).put(URL).set(auth()).send(body as object);

const future = () => new Date(Date.now() + 3_600_000);
const statusCols = (expiresAt: Date) => ({
  customStatusEmoji: "✈️",
  customStatusText: "Travelling",
  customStatusStartedAt: new Date(expiresAt.getTime() - 3_600_000),
  customStatusExpiresAt: expiresAt,
  customStatusUpdatedAt: new Date(expiresAt.getTime() - 3_600_000),
});
const peerProfile = (extra: Record<string, unknown> = {}) => ({
  userId: PEER_ID,
  username: "peer",
  firstName: "Pat",
  lastName: "Peer",
  bio: "bio",
  avatarUrl: null,
  coverImageUrl: null,
  isOnline: false,
  lastSeenAt: null,
  friendsCount: 0,
  communitiesCount: 0,
  groupsCount: 0,
  status: "ACTIVE",
  deletedAt: null,
  privacySettings: null,
  ...statusCols(future()),
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  repo.setCustomStatus.mockResolvedValue({ userId: TEST_USER_ID, whoCanViewProfile: "EVERYONE" });
  repo.clearCustomStatus.mockResolvedValue({ userId: TEST_USER_ID, whoCanViewProfile: "EVERYONE" });
  repo.findCustomStatus.mockResolvedValue(null);
  fRepo.findBlock.mockResolvedValue(null);
});

describe("PUT /profiles/me/custom-status", () => {
  it("creates a status with a server-computed expiry", async () => {
    const before = Date.now();
    const res = await put({ emoji: "✈️", text: "  Travelling  ", durationSeconds: 604800 });

    expect(res.status).toBe(200);
    const { customStatus, serverNow } = res.body.data;
    expect(customStatus).toMatchObject({ emoji: "✈️", text: "Travelling" });
    expect(serverNow).toBeGreaterThanOrEqual(before);
    expect(customStatus.startedAt).toBe(serverNow);
    expect(customStatus.updatedAt).toBe(serverNow);
    expect(customStatus.expiresAt - customStatus.startedAt).toBe(604800 * 1000);
    expect(repo.setCustomStatus).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ emoji: "✈️", text: "Travelling" })
    );
  });

  it("replaces: each set overwrites the single active status", async () => {
    await put({ emoji: "🎉", durationSeconds: 3600 });
    const res = await put({ text: "Busy", durationSeconds: 28800 });

    expect(res.status).toBe(200);
    expect(res.body.data.customStatus).toMatchObject({ emoji: null, text: "Busy" });
    expect(repo.setCustomStatus).toHaveBeenLastCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ emoji: null, text: "Busy" })
    );
  });

  it("accepts emoji-only and text-only", async () => {
    expect((await put({ emoji: "👨‍👩‍👧", durationSeconds: 60 })).status).toBe(200);
    expect((await put({ emoji: "🇻🇳", durationSeconds: 60 })).status).toBe(200);
    expect((await put({ emoji: "👍🏽", durationSeconds: 60 })).status).toBe(200);
    expect((await put({ text: "ok", emoji: "", durationSeconds: 2_592_000 })).status).toBe(200);
  });

  it.each([
    [{ emoji: "✈️", durationSeconds: 59 }],
    [{ emoji: "✈️", durationSeconds: 2_592_001 }],
    [{ emoji: "✈️", durationSeconds: 90.5 }],
    [{ emoji: "✈️", durationSeconds: "3600" }],
    [{ emoji: "✈️" }],
  ])("rejects invalid duration %j", async (body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.message).toBe("Status duration must be between 1 minute and 30 days.");
    expect(repo.setCustomStatus).not.toHaveBeenCalled();
  });

  it.each([[{ durationSeconds: 3600 }], [{ text: "   ", emoji: null, durationSeconds: 3600 }]])(
    "rejects an empty status %j",
    async (body) => {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Add an emoji or some text for your status.");
    }
  );

  it("counts text length in graphemes (60 ok, 61 rejected)", async () => {
    expect((await put({ text: "👍".repeat(60), durationSeconds: 60 })).status).toBe(200);
    const res = await put({ text: "a".repeat(61), durationSeconds: 60 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Status must be at most 60 characters.");
  });

  it("rejects line breaks in text", async () => {
    const res = await put({ text: "a\nb", durationSeconds: 60 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Status can't contain line breaks or control characters.");
  });

  it.each(["a", "✈️✈️", "ab", "1"])("rejects invalid emoji %j", async (emoji) => {
    const res = await put({ emoji, durationSeconds: 60 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Choose a single emoji.");
  });

  it("401s without a token", async () => {
    const res = await request(app).put(URL).send({ emoji: "✈️", durationSeconds: 60 });
    expect(res.status).toBe(401);
    expect((await request(app).delete(URL)).status).toBe(401);
  });

  it("publishes the full status on user:<id> when the profile is public", async () => {
    await put({ emoji: "✈️", durationSeconds: 60 });

    expect(chatPub).toHaveBeenCalledWith(
      redis,
      TEST_USER_ID,
      EVENT,
      expect.objectContaining({
        userId: TEST_USER_ID,
        customStatus: expect.objectContaining({ emoji: "✈️" }),
      })
    );
    expect(notifyPub).not.toHaveBeenCalled();
  });

  it("always publishes the full form on user:<id> and nothing on notify:<id>", async () => {
    await put({ emoji: "✈️", durationSeconds: 60 });

    expect(chatPub.mock.calls[0][3]).toEqual(
      expect.objectContaining({ customStatus: expect.objectContaining({ emoji: "✈️" }) })
    );
    expect(notifyPub).not.toHaveBeenCalled();
  });

  it("404s when the profile row is missing", async () => {
    repo.setCustomStatus.mockResolvedValue(null);
    expect((await put({ emoji: "✈️", durationSeconds: 60 })).status).toBe(404);
  });
});

describe("DELETE /profiles/me/custom-status", () => {
  it("clears and emits customStatus: null", async () => {
    const res = await request(app).delete(URL).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.customStatus).toBeNull();
    expect(typeof res.body.data.serverNow).toBe("number");
    expect(chatPub).toHaveBeenCalledWith(
      redis,
      TEST_USER_ID,
      EVENT,
      expect.objectContaining({ customStatus: null })
    );
  });

  it("is idempotent: 200 and no event when nothing is set", async () => {
    repo.clearCustomStatus.mockResolvedValue(null);
    const res = await request(app).delete(URL).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.customStatus).toBeNull();
    expect(chatPub).not.toHaveBeenCalled();
  });
});

describe("read paths", () => {
  it("GET /profiles/me returns the active status and serverNow", async () => {
    repo.findByUserId.mockResolvedValue({
      userId: TEST_USER_ID,
      username: "me",
      account: "me",
      isGoogleLogin: false,
      firstName: "Me",
      lastName: "Self",
      bio: null,
      dateOfBirth: new Date("1995-06-15T00:00:00.000Z"),
      gender: null,
      avatarUrl: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      deletedAt: null,
    });
    repo.findCustomStatus.mockResolvedValue(statusCols(future()));

    const res = await request(app).get("/api/v1/users/profiles/me").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.customStatus).toMatchObject({ emoji: "✈️", text: "Travelling" });
    expect(typeof res.body.data.serverNow).toBe("number");
  });

  it("GET /profiles/me returns null for an expired (unswept) status", async () => {
    repo.findByUserId.mockResolvedValue({
      userId: TEST_USER_ID,
      username: "me",
      isGoogleLogin: false,
      firstName: "Me",
      lastName: "Self",
      bio: null,
      dateOfBirth: new Date("1995-06-15T00:00:00.000Z"),
      gender: null,
      avatarUrl: null,
      updatedAt: new Date(),
      deletedAt: null,
    });
    repo.findCustomStatus.mockResolvedValue(statusCols(new Date(Date.now() - 1000)));

    const res = await request(app).get("/api/v1/users/profiles/me").set(auth());
    expect(res.body.data.customStatus).toBeNull();
  });

  it("GET /users/:id shows a visible peer's status", async () => {
    repo.findPublicProfileByUserId.mockResolvedValue(peerProfile());

    const res = await request(app).get(`/api/v1/users/${PEER_ID}`).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.customStatus).toMatchObject({ emoji: "✈️", text: "Travelling" });
    expect(typeof res.body.data.serverNow).toBe("number");
  });

  it("GET /users/:id shows bio and status to a stranger (no profile-view scope)", async () => {
    repo.findPublicProfileByUserId.mockResolvedValue(
      peerProfile({ privacySettings: { whoCanViewProfile: "FRIENDS" } })
    );

    const res = await request(app).get(`/api/v1/users/${PEER_ID}`).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.customStatus).toMatchObject({ emoji: "✈️" });
  });

  it("GET /users/:id hides it when the peer blocked the viewer (conversation kept)", async () => {
    repo.findPublicProfileByUserId.mockResolvedValue(peerProfile());
    fRepo.findBlock.mockImplementation(async (blocker: string) =>
      blocker === PEER_ID ? { id: "b", blockerId: PEER_ID, blockedId: TEST_USER_ID } : null
    );
    (messagingGrpcClient.resolvePrivateRooms as jest.Mock).mockResolvedValue([{ roomId: "r" }]);

    const res = await request(app).get(`/api/v1/users/${PEER_ID}`).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.customStatus).toBeNull();
    (messagingGrpcClient.resolvePrivateRooms as jest.Mock).mockResolvedValue([]);
  });

  it("GET /users/:id returns null for an expired status", async () => {
    repo.findPublicProfileByUserId.mockResolvedValue(
      peerProfile(statusCols(new Date(Date.now() - 1)))
    );

    const res = await request(app).get(`/api/v1/users/${PEER_ID}`).set(auth());
    expect(res.body.data.customStatus).toBeNull();
  });
});

describe("expiry sweeper", () => {
  it("claims expired rows and emits customStatus: null once per user", async () => {
    (redis as unknown as { set: jest.Mock; del: jest.Mock }).set = jest.fn(async () => "OK");
    (redis as unknown as { set: jest.Mock; del: jest.Mock }).del = jest.fn(async () => 1);
    repo.claimExpiredCustomStatuses
      .mockResolvedValueOnce([
        { userId: TEST_USER_ID },
        { userId: PEER_ID },
      ])
      .mockResolvedValue([]);

    expect(await runCustomStatusSweepOnce()).toBe(2);
    expect(await runCustomStatusSweepOnce()).toBe(0);

    expect(chatPub).toHaveBeenCalledTimes(2);
    expect(chatPub).toHaveBeenCalledWith(
      redis,
      TEST_USER_ID,
      EVENT,
      expect.objectContaining({ customStatus: null })
    );
    expect(chatPub.mock.calls.find((c) => c[1] === PEER_ID)?.[3]).toEqual(
      expect.objectContaining({ customStatus: null })
    );
    expect(notifyPub).not.toHaveBeenCalled();
  });

  it("skips the tick when another instance holds the lock", async () => {
    (redis as unknown as { set: jest.Mock }).set = jest.fn(async () => null);
    expect(await runCustomStatusSweepOnce()).toBe(0);
    expect(repo.claimExpiredCustomStatuses).not.toHaveBeenCalled();
  });
});
