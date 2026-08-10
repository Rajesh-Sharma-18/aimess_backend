/**
 * /api/v1/users/profiles/me — GET (read own profile) + PATCH (update).
 *
 * The profile service runs for real. We mock:
 *  - userProfileRepository (DB boundary),
 *  - user-cache (forced cold so reads hit the repo, writes are no-ops),
 *  - avatar.service (so no MinIO head/presign is attempted),
 *  - resolve-auth-account (so no gRPC summary is needed),
 *  - the username service availability check (so PATCH username branches are
 *    deterministic), and the profile-updated publisher.
 *
 * Dates in the success envelope are serialized to epoch ms by ApiResponse, but
 * the profile service hands the controller ISO strings (it pre-formats), so we
 * assert on the string fields it actually returns.
 */
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findByUserId: jest.fn(),
    findByUsername: jest.fn(),
    updateProfile: jest.fn(),
  },
}));
jest.mock("../../src/lib/user-cache.js", () => ({
  userCache: {
    getProfileRecord: jest.fn(async () => null),
    setProfileRecord: jest.fn(async () => undefined),
    invalidateProfile: jest.fn(async () => undefined),
    onUsernameClaimed: jest.fn(async () => undefined),
    onUsernameReleased: jest.fn(async () => undefined),
  },
  // Identity passthroughs — the service round-trips a record through these when
  // it warms the (mocked, always-cold) cache after a DB read.
  toCachedProfileRecord: (record: unknown) => record,
  fromCachedProfileRecord: (record: unknown) => record,
}));
jest.mock("../../src/services/avatar.service.js", () => ({
  avatarService: {
    resolveViewUrlForClient: jest.fn(async () => null),
    resolveAvatarObjectKeyForProfile: jest.fn(
      async (_userId: string, key: string) => key
    ),
  },
}));
jest.mock("../../src/lib/resolve-auth-account.js", () => ({
  resolveAuthAccountSummary: jest.fn(async () => ({
    account: {
      account: "johndoe",
      email: "john@example.com",
      primaryAccount: "EMAIL",
      providers: [],
    },
    accountStatus: "live",
  })),
}));
jest.mock("../../src/services/username.service.js", () => ({
  usernameService: {
    validateAvailability: jest.fn(async (username: string) => ({
      username,
      available: true,
    })),
  },
}));
jest.mock("../../src/messaging/publish-profile-updated.js", () => ({
  publishProfileUpdatedSafe: jest.fn(),
}));
// Also keeps the real module (and its Redis client import) out of the suite.
jest.mock("../../src/lib/profile-socket.js", () => ({
  emitProfileUpdatedSafe: jest.fn(),
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";
import { usernameService } from "../../src/services/username.service.js";
import {
  TEST_SESSION_ID,
  TEST_USER_ID,
  bearer,
  makeAccessToken,
  makeExpiredAccessToken,
} from "../helpers/auth.js";
import { emitProfileUpdatedSafe } from "../../src/lib/profile-socket.js";

const repo = userProfileRepository as unknown as Record<string, jest.Mock>;
const unameSvc = usernameService as unknown as {
  validateAvailability: jest.Mock;
};

const auth = () => bearer(makeAccessToken());

function profileRecord(overrides: Record<string, unknown> = {}) {
  return {
    userId: TEST_USER_ID,
    username: "johndoe",
    account: "johndoe",
    isGoogleLogin: false,
    firstName: "John",
    lastName: "Doe",
    bio: "hi there",
    dateOfBirth: new Date("1995-06-15T00:00:00.000Z"),
    gender: "MALE",
    avatarUrl: null,
    lastUsernameChangeAt: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

describe("GET /api/v1/users/profiles/me", () => {
  it("returns the caller's profile → 200", async () => {
    repo.findByUserId.mockResolvedValue(profileRecord());

    const res = await request(app).get("/api/v1/users/profiles/me").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.userId).toBe(TEST_USER_ID);
    expect(res.body.data.username).toBe("johndoe");
    expect(res.body.data.dateOfBirth).toBe("1995-06-15");
    expect(res.body.data.avatarUrl).toBeNull();
    expect(repo.findByUserId).toHaveBeenCalledWith(TEST_USER_ID);
  });

  it("returns 404 when the profile does not exist", async () => {
    repo.findByUserId.mockResolvedValue(null);

    const res = await request(app).get("/api/v1/users/profiles/me").set(auth());

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("returns 404 when the profile is soft-deleted", async () => {
    repo.findByUserId.mockResolvedValue(
      profileRecord({ deletedAt: new Date("2026-03-01T00:00:00.000Z") })
    );

    const res = await request(app).get("/api/v1/users/profiles/me").set(auth());

    expect(res.status).toBe(404);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/users/profiles/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 with an expired token", async () => {
    const res = await request(app)
      .get("/api/v1/users/profiles/me")
      .set(bearer(makeExpiredAccessToken()));
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/v1/users/profiles/me", () => {
  beforeEach(() => {
    repo.findByUserId.mockResolvedValue(profileRecord());
    repo.updateProfile.mockImplementation(async (_id: string, data: any) => ({
      ...profileRecord(),
      ...data,
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    }));
    unameSvc.validateAvailability.mockResolvedValue({
      username: "newhandle",
      available: true,
    });
  });

  it("updates first/last name → 200", async () => {
    const res = await request(app)
      .patch("/api/v1/users/profiles/me")
      .set(auth())
      .send({ firstName: "Jane", lastName: "Smith" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.firstName).toBe("Jane");
    expect(res.body.data.lastName).toBe("Smith");
    expect(repo.updateProfile).toHaveBeenCalledTimes(1);
  });

  it("fans the change out to the user's other devices, excluding the editor", () => {
    return request(app)
      .patch("/api/v1/users/profiles/me")
      .set(auth())
      .send({ firstName: "Jane" })
      .expect(200)
      .then(() => {
        expect(emitProfileUpdatedSafe).toHaveBeenCalledWith(
          TEST_USER_ID,
          // The PERSISTED row's updatedAt, not the request time — it is the
          // client's ordering key.
          "2026-04-01T00:00:00.000Z",
          TEST_SESSION_ID
        );
      });
  });

  it("changes the username when available and no cooldown applies", async () => {
    const res = await request(app)
      .patch("/api/v1/users/profiles/me")
      .set(auth())
      .send({ username: "newhandle" });

    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe("newhandle");
    expect(unameSvc.validateAvailability).toHaveBeenCalled();
  });

  it("returns 409 when the requested username is taken", async () => {
    unameSvc.validateAvailability.mockResolvedValue({
      username: "newhandle",
      available: false,
    });

    const res = await request(app)
      .patch("/api/v1/users/profiles/me")
      .set(auth())
      .send({ username: "newhandle" });

    expect(res.status).toBe(409);
    expect(repo.updateProfile).not.toHaveBeenCalled();
  });

  it("returns 400 when changing username within the 30-day cooldown", async () => {
    repo.findByUserId.mockResolvedValue(
      profileRecord({ lastUsernameChangeAt: new Date(Date.now() - 1000) })
    );

    const res = await request(app)
      .patch("/api/v1/users/profiles/me")
      .set(auth())
      .send({ username: "newhandle" });

    expect(res.status).toBe(400);
    expect(repo.updateProfile).not.toHaveBeenCalled();
  });

  it("clears the avatar when avatarObjectKey is null", async () => {
    const res = await request(app)
      .patch("/api/v1/users/profiles/me")
      .set(auth())
      .send({ avatarObjectKey: null });

    expect(res.status).toBe(200);
    expect(repo.updateProfile).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ avatarUrl: null })
    );
  });

  it("returns 404 when updating a non-existent profile", async () => {
    repo.findByUserId.mockResolvedValue(null);

    const res = await request(app)
      .patch("/api/v1/users/profiles/me")
      .set(auth())
      .send({ firstName: "Jane" });

    expect(res.status).toBe(404);
  });

  it.each([
    ["empty body (no fields)", {}],
    ["firstName too long", { firstName: "a".repeat(51) }],
    ["empty firstName", { firstName: "   " }],
    ["bio too long", { bio: "a".repeat(281) }],
    ["bad date format", { dateOfBirth: "06-15-1995" }],
    ["underage dob", { dateOfBirth: "2020-01-01" }],
    ["invalid gender enum", { gender: "ROBOT" }],
    ["username too short", { username: "ab" }],
    ["username illegal chars", { username: "no spaces!" }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .patch("/api/v1/users/profiles/me")
      .set(auth())
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("accepts an emoji-containing bio at the boundary", async () => {
    const res = await request(app)
      .patch("/api/v1/users/profiles/me")
      .set(auth())
      .send({ bio: "hello 😀 world" });

    expect(res.status).toBe(200);
  });

  it("ignores extra/privileged fields (mass-assignment guard)", async () => {
    const res = await request(app)
      .patch("/api/v1/users/profiles/me")
      .set(auth())
      .send({
        firstName: "Jane",
        userId: "hacked",
        friendsCount: 9999,
        isOnline: true,
      });

    expect(res.status).toBe(200);
    const passed = repo.updateProfile.mock.calls[0][1];
    expect(passed).not.toHaveProperty("friendsCount");
    expect(passed).not.toHaveProperty("isOnline");
    // userId is the path param/auth id, never taken from the body.
    expect(repo.updateProfile.mock.calls[0][0]).toBe(TEST_USER_ID);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .patch("/api/v1/users/profiles/me")
      .send({ firstName: "Jane" });
    expect(res.status).toBe(401);
  });
});
