/**
 * A push is rendered in each DEVICE's language, not once per account.
 *
 * `push-recipient-locale.test.ts` next door proves the per-USER half: one
 * builder fanned out to three users leaves in three languages. This proves the
 * per-DEVICE half, which is what the multi-session scenario actually needs —
 * one account signed in on five devices in three languages, where
 * `AppSettings.language` is a single account-wide column that the last session
 * to change it overwrites for everyone.
 *
 * Asserting on what reaches FCM (`sendPush`) rather than on an intermediate
 * value is deliberate: the regression this guards against is someone hoisting
 * the render back above the token fan-out, which no unit-level assertion on
 * `pushToUser`'s inputs would catch.
 */
jest.mock("../../src/repositories/device-token.repository.js", () => ({
  deviceTokenRepository: {
    findTokensByUserId: jest.fn(),
    deleteByToken: jest.fn(async () => undefined),
    touchLastSeen: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/providers/firebase/sendPush.js", () => ({
  sendPush: jest.fn(async () => ({ invalidToken: false, messageId: "m1" })),
}));
const mockChatNotificationClient = { createNotification: jest.fn() };
const mockUserSettingsClient = { getNotificationSettings: jest.fn() };
jest.mock("../../src/grpc/chat-notification.client.js", () => ({
  createChatNotificationClient: () => mockChatNotificationClient,
}));
jest.mock("../../src/grpc/user-settings.client.js", () => ({
  createUserSettingsClient: () => mockUserSettingsClient,
}));

import { friendCopy } from "../../src/lib/notification-copy.js";
import { deviceTokenRepository } from "../../src/repositories/device-token.repository.js";
import { pushToUser } from "../../src/services/push.service.js";
import { sendPush } from "../../src/providers/firebase/sendPush.js";

const send = sendPush as unknown as jest.Mock;
const findTokens = (
  deviceTokenRepository as unknown as Record<string, jest.Mock>
).findTokensByUserId;

const USER_ID = "11111111-1111-4111-8111-111111111111";

const EN = "John sent you a friend request";
const VI = "John đã gửi cho bạn lời mời kết bạn";
const TH = "Johnส่งคำขอเป็นเพื่อนถึงคุณ";

const settings = (language: string) => ({
  chatEnabled: true,
  callEnabled: true,
  friendRequestEnabled: true,
  systemEnabled: true,
  communityEnabled: true,
  liveStreamEnabled: true,
  showPreview: true,
  quietHoursEnabled: false,
  quietHoursStart: "",
  quietHoursEnd: "",
  quietHoursDays: [],
  language,
});

const deviceRow = (token: string, locale: string | null) => ({
  token,
  tokenType: "FCM",
  platform: "ANDROID",
  deviceId: token,
  // A live session per device — the send path prunes tokens of revoked ones.
  sessionId: null,
  locale,
  lastSeenAt: new Date(),
});

/** token → body, as it actually reached the provider. */
async function deliver(
  rows: ReturnType<typeof deviceRow>[],
  accountLanguage: string
): Promise<Record<string, string>> {
  jest.clearAllMocks();
  send.mockResolvedValue({ invalidToken: false, messageId: "m1" });
  findTokens.mockResolvedValue(rows);
  mockUserSettingsClient.getNotificationSettings.mockResolvedValue(
    settings(accountLanguage)
  );

  await pushToUser({
    userId: USER_ID,
    category: "friendRequestEnabled",
    type: "friend.requested",
    copy: friendCopy.requested("John"),
    skipInbox: true,
  });

  return Object.fromEntries(
    send.mock.calls.map(([arg]) => [
      (arg as { token: string }).token,
      (arg as { body: string }).body,
    ])
  );
}

describe("pushToUser — per-device language", () => {
  it("sends one push per device, each in that device's own language", async () => {
    const bodies = await deliver(
      [
        deviceRow("t-en", "en"),
        deviceRow("t-th", "th"),
        deviceRow("t-vi", "vi"),
      ],
      // Account language deliberately disagrees with every device: if it leaked
      // into delivery, all three would come out English.
      "en"
    );

    expect(bodies["t-en"]).toBe(EN);
    expect(bodies["t-th"]).toBe(TH);
    expect(bodies["t-vi"]).toBe(VI);
    expect(new Set(Object.values(bodies)).size).toBe(3);
  });

  it("falls back to the account language for a device that never declared one", async () => {
    // The pre-upgrade population. Falling back to DEFAULT_LOCALE instead would
    // flip every existing device to Vietnamese in production — a worse bug than
    // the one per-device locale fixes.
    const bodies = await deliver(
      [deviceRow("t-legacy", null), deviceRow("t-th", "th")],
      "vi"
    );

    expect(bodies["t-legacy"]).toBe(VI);
    expect(bodies["t-th"]).toBe(TH);
  });

  it("ignores an unsupported stored tag rather than answering in the default", async () => {
    // A row written by a client that shipped a locale this build does not
    // carry. `parseSupportedLocale` returns null for it, so it lands on the
    // account language — never on DEFAULT_LOCALE.
    const bodies = await deliver([deviceRow("t-fr", "fr")], "en");

    expect(bodies["t-fr"]).toBe(EN);
  });

  it("renders once per language, not once per device", async () => {
    // Six devices, two languages. The copy thunk is pure, so the memo means a
    // user with a large device fleet still costs at most SUPPORTED_LOCALES
    // renders — the reason this fan-out can afford to be per-device at all.
    const bodies = await deliver(
      [
        deviceRow("a", "en"),
        deviceRow("b", "en"),
        deviceRow("c", "en"),
        deviceRow("d", "th"),
        deviceRow("e", "th"),
        deviceRow("f", "th"),
      ],
      "vi"
    );

    expect(send).toHaveBeenCalledTimes(6);
    expect(new Set(Object.values(bodies))).toEqual(new Set([EN, TH]));
  });
});
