/**
 * /api/v1/users/settings/me — GET (read bundle) + PATCH (partial update).
 *
 * The settings service runs for real. We mock the settings repository and the
 * settings-updated publisher. The service loads a full bundle, maps it to the
 * API shape, applies a partial update, reloads, and republishes.
 */
jest.mock("../../src/repositories/user-settings.repository.js", () => ({
  userSettingsRepository: {
    findSettingsBundle: jest.fn(),
    ensureDefaultSettings: jest.fn(async () => undefined),
    updateSettings: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/messaging/publish-settings-updated.js", () => ({
  publishSettingsUpdatedSafe: jest.fn(),
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { userSettingsRepository } from "../../src/repositories/user-settings.repository.js";
import { publishSettingsUpdatedSafe } from "../../src/messaging/publish-settings-updated.js";
import { TEST_USER_ID, bearer, makeAccessToken } from "../helpers/auth.js";

const repo = userSettingsRepository as unknown as Record<string, jest.Mock>;
const publish = publishSettingsUpdatedSafe as unknown as jest.Mock;

const auth = () => bearer(makeAccessToken());

function fullBundle(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    deletedAt: null,
    privacySettings: {
      whoCanFindMe: "EVERYONE",
      whoCanSendFriendRequests: "EVERYONE",
      whoCanSeeOnlineStatus: "EVERYONE",
      whoCanViewProfile: "EVERYONE",
      whoCanCallMe: "FRIENDS",
      updatedAt: now,
    },
    chatSettings: {
      autoDeleteTimer: "OFF",
      typingIndicators: true,
      readReceipts: true,
      updatedAt: now,
    },
    appSettings: { language: "en", theme: "LIGHT", updatedAt: now },
    notificationSettings: {
      chatEnabled: true,
      callEnabled: true,
      friendRequestEnabled: true,
      systemEnabled: true,
      communityEnabled: true,
      liveStreamEnabled: true,
      quietHoursEnabled: false,
      quietHoursStart: null,
      quietHoursEnd: null,
      quietHoursDays: [],
      updatedAt: now,
    },
    liveStreamSettings: { defaultVideoQuality: "AUTO", updatedAt: now },
    callPrivacyAllowList: [],
    ...overrides,
  };
}

describe("GET /api/v1/users/settings/me", () => {
  it("returns the full settings bundle → 200", async () => {
    repo.findSettingsBundle.mockResolvedValue(fullBundle());

    const res = await request(app).get("/api/v1/users/settings/me").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.privacy.whoCanFindMe).toBe("EVERYONE");
    expect(res.body.data.chat.autoDeleteTimer).toBe("OFF");
    expect(res.body.data.app.language).toBe("en");
    expect(res.body.data.notifications.chat).toBe(true);
    expect(res.body.data.liveStream.defaultVideoQuality).toBe("AUTO");
  });

  it("ensures defaults then returns when sub-settings are missing", async () => {
    // First load is incomplete (no privacy), second load (after ensure) is full.
    repo.findSettingsBundle
      .mockResolvedValueOnce(fullBundle({ privacySettings: null }))
      .mockResolvedValueOnce(fullBundle());

    const res = await request(app).get("/api/v1/users/settings/me").set(auth());

    expect(res.status).toBe(200);
    expect(repo.ensureDefaultSettings).toHaveBeenCalledWith(TEST_USER_ID);
  });

  it("returns 404 when the profile (settings owner) does not exist", async () => {
    repo.findSettingsBundle.mockResolvedValue(null);

    const res = await request(app).get("/api/v1/users/settings/me").set(auth());

    expect(res.status).toBe(404);
  });

  it("returns 404 when the profile is soft-deleted", async () => {
    repo.findSettingsBundle.mockResolvedValue(
      fullBundle({ deletedAt: new Date("2026-02-01T00:00:00.000Z") })
    );

    const res = await request(app).get("/api/v1/users/settings/me").set(auth());

    expect(res.status).toBe(404);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/users/settings/me");
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/v1/users/settings/me", () => {
  beforeEach(() => {
    repo.findSettingsBundle.mockResolvedValue(fullBundle());
  });

  it("updates a privacy field → 200 and publishes settings.updated", async () => {
    const res = await request(app)
      .patch("/api/v1/users/settings/me")
      .set(auth())
      .send({ privacy: { whoCanFindMe: "NO_ONE" } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(repo.updateSettings).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("updates a nested quiet-hours notification setting", async () => {
    const res = await request(app)
      .patch("/api/v1/users/settings/me")
      .set(auth())
      .send({
        notifications: {
          quietHours: {
            enabled: true,
            start: "22:00",
            end: "07:00",
            days: [1, 2, 3],
          },
        },
      });

    expect(res.status).toBe(200);
  });

  it("updates the call allow-list", async () => {
    const res = await request(app)
      .patch("/api/v1/users/settings/me")
      .set(auth())
      .send({
        privacy: {
          whoCanCallMe: "SELECTED_FRIENDS",
          callAllowedFriendIds: ["33333333-3333-4333-8333-333333333333"],
        },
      });

    expect(res.status).toBe(200);
    expect(repo.updateSettings).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({
        callAllowedFriendIds: ["33333333-3333-4333-8333-333333333333"],
      })
    );
  });

  it("returns 400 when the call allow-list includes the caller's own id", async () => {
    const res = await request(app)
      .patch("/api/v1/users/settings/me")
      .set(auth())
      .send({
        privacy: {
          whoCanCallMe: "SELECTED_FRIENDS",
          callAllowedFriendIds: [TEST_USER_ID],
        },
      });

    expect(res.status).toBe(400);
    expect(repo.updateSettings).not.toHaveBeenCalled();
  });

  it("returns 404 when updating settings for a missing profile", async () => {
    repo.findSettingsBundle.mockResolvedValue(null);

    const res = await request(app)
      .patch("/api/v1/users/settings/me")
      .set(auth())
      .send({ chat: { readReceipts: false } });

    expect(res.status).toBe(404);
    expect(repo.updateSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["empty body (no group)", {}],
    ["empty privacy group", { privacy: {} }],
    ["empty chat group", { chat: {} }],
    ["unknown top-level key", { wibble: true }],
    ["unknown privacy key (strict)", { privacy: { wibble: "x" } }],
    ["invalid privacy enum", { privacy: { whoCanFindMe: "MARS" } }],
    ["invalid theme enum", { app: { theme: "NEON" } }],
    ["invalid language enum", { app: { language: "xx" } }],
    ["non-boolean typingIndicators", { chat: { typingIndicators: "yes" } }],
    ["bad time format", { notifications: { quietHours: { start: "9pm" } } }],
    [
      "non-uuid in call allow-list",
      { privacy: { callAllowedFriendIds: ["not-a-uuid"] } },
    ],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .patch("/api/v1/users/settings/me")
      .set(auth())
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .patch("/api/v1/users/settings/me")
      .send({ chat: { readReceipts: false } });
    expect(res.status).toBe(401);
  });
});
