/**
 * A push is rendered in the RECIPIENT's language, not the sender's.
 *
 * The same `friendCopy.requested(...)` builder is handed to `pushToUser` three
 * times; only the recipient's stored `AppSettings.language` differs. Asserting
 * on what actually reaches FCM (`sendPush`) proves the language is applied at
 * delivery, not at the consumer that produced the event.
 */
jest.mock("../../src/repositories/device-token.repository.js", () => ({
  deviceTokenRepository: {
    findTokensByUserId: jest.fn(async () => ["token-1"]),
    deleteByToken: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/providers/firebase/sendPush.js", () => ({
  sendPush: jest.fn(async () => ({ invalidToken: false })),
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
import { pushToUser } from "../../src/services/push.service.js";
import { sendPush } from "../../src/providers/firebase/sendPush.js";

const send = sendPush as unknown as jest.Mock;
const USER_ID = "11111111-1111-4111-8111-111111111111";

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

async function bodyForLanguage(language: string): Promise<string> {
  jest.clearAllMocks();
  send.mockResolvedValue({ invalidToken: false });
  mockUserSettingsClient.getNotificationSettings.mockResolvedValue(
    settings(language)
  );
  await pushToUser({
    userId: USER_ID,
    category: "friendRequestEnabled",
    type: "friend.requested",
    copy: friendCopy.requested("John"),
    skipInbox: true,
  });
  expect(send).toHaveBeenCalledTimes(1);
  return (send.mock.calls[0][0] as { body: string }).body;
}

describe("pushToUser — recipient language", () => {
  it("renders one shared copy builder into each recipient's own language", async () => {
    const en = await bodyForLanguage("en");
    const vi = await bodyForLanguage("vi");
    const th = await bodyForLanguage("th");

    expect(en).toBe("John sent you a friend request");
    expect(vi).toBe("John đã gửi cho bạn lời mời kết bạn");
    expect(th).toBe("Johnส่งคำขอเป็นเพื่อนถึงคุณ");
    expect(new Set([en, vi, th]).size).toBe(3);
  });

  it("falls back safely when the user never chose a language", async () => {
    const body = await bodyForLanguage("");
    expect(body.trim()).not.toBe("");
    expect(body).toContain("John");
  });
});
