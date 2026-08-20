/**
 * The write half of "a notification reads in the user's CURRENT language".
 *
 * `pushToUser` still bakes the recipient's language into `title`/`body` — that
 * stays the fallback every pre-existing row depends on — but it must ALSO
 * persist the replay ticket (`data.copyRef` / `data.dataRef`) that lets the read
 * side rebuild the same sentence in a different language later. Without the
 * ticket the row is frozen at write time, which is the original bug.
 */
jest.mock("../../src/repositories/device-token.repository.js", () => ({
  deviceTokenRepository: {
    findTokensByUserId: jest.fn(async () => ["token-1"]),
    deleteByToken: jest.fn(async () => undefined),
    touchLastSeen: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/providers/firebase/sendPush.js", () => ({
  sendPush: jest.fn(async () => ({ invalidToken: false })),
}));
const mockChatNotificationClient = {
  createNotification: jest.fn(async () => ({ id: "n1" })),
};
const mockUserSettingsClient = { getNotificationSettings: jest.fn() };
jest.mock("../../src/grpc/chat-notification.client.js", () => ({
  createChatNotificationClient: () => mockChatNotificationClient,
}));
jest.mock("../../src/grpc/user-settings.client.js", () => ({
  createUserSettingsClient: () => mockUserSettingsClient,
}));

import {
  renderNotificationCopy,
  renderNotificationData,
  t,
} from "@aimess/constants";

import {
  callCopy,
  friendCopy,
  resolutionCopy,
} from "../../src/lib/notification-copy.js";
import { pushToUser } from "../../src/services/push.service.js";

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

type InboxWrite = {
  title: string;
  body: string;
  data: Record<string, string>;
};

async function writeInbox(
  language: string,
  input: Parameters<typeof pushToUser>[0]
): Promise<InboxWrite> {
  jest.clearAllMocks();
  mockChatNotificationClient.createNotification.mockResolvedValue({ id: "n1" });
  mockUserSettingsClient.getNotificationSettings.mockResolvedValue(
    settings(language)
  );
  await pushToUser(input);
  expect(mockChatNotificationClient.createNotification).toHaveBeenCalledTimes(
    1
  );
  return mockChatNotificationClient.createNotification.mock
    .calls[0][0] as InboxWrite;
}

describe("pushToUser — inbox replay ticket", () => {
  it("stores a ticket that rebuilds the call line in any language", async () => {
    const written = await writeInbox("vi", {
      userId: USER_ID,
      category: "callEnabled",
      type: "call.activity",
      copy: callCopy.activity("Mohit", "AUDIO", "MISSED", "INCOMING", 0, 0),
      inboxTitle: "Mohit",
      skipPush: true,
      data: { callId: "c1", callType: "AUDIO", callStatus: "MISSED" },
    });

    // Baked text is still the recipient's write-time language.
    expect(written.body).toBe(t("NOTIF_CALL_MISSED_VOICE", "vi"));

    // …and the ticket reproduces it in every other one.
    for (const locale of ["en", "vi", "th"] as const) {
      expect(renderNotificationCopy(written.data.copyRef, locale)?.body).toBe(
        t("NOTIF_CALL_MISSED_VOICE", locale)
      );
    }
    // The canonical call fields the client maps from are untouched.
    expect(written.data.callStatus).toBe("MISSED");
    expect(written.data.callType).toBe("AUDIO");
  });

  it("stores a ticket for the friend card's resolution line too", async () => {
    const written = await writeInbox("en", {
      userId: USER_ID,
      category: "friendRequestEnabled",
      type: "friend.accepted",
      copy: friendCopy.acceptedForRequester("Ana"),
      localizedData: resolutionCopy.friendAccepted("Ana"),
      data: {},
    });

    expect(renderNotificationData(written.data.dataRef, "vi")?.resolution).toBe(
      t("NOTIF_FRIEND_RESOLUTION_ACCEPTED", "vi", { name: "Ana" })
    );
    // The name is an argument to the builder, so it survives verbatim.
    expect(
      renderNotificationData(written.data.dataRef, "th")?.resolution
    ).toContain("Ana");
  });

  it("stores no ticket for admin-authored text", async () => {
    const written = await writeInbox("vi", {
      userId: USER_ID,
      category: "systemEnabled",
      type: "ANNOUNCEMENT",
      title: "Scheduled maintenance",
      body: "We will be down 02:00-03:00 UTC.",
      data: {},
    });

    expect(written.data.copyRef).toBeUndefined();
    expect(written.data.dataRef).toBeUndefined();
    expect(written.body).toBe("We will be down 02:00-03:00 UTC.");
  });
});
