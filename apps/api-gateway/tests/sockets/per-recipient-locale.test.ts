/**
 * The cross-user requirement: ONE broadcast, three languages.
 *
 * `emitPersonalizedSender` is the only place a room fan-out visits sockets
 * individually, so it is where per-recipient locale has to land. This drives it
 * with three fake sockets (en / vi / th) joined to the same room and asserts
 * each one receives the SYSTEM line in its own language — and that the "You"
 * sender swap is localized too, not a hard-coded English word.
 */
import { t } from "@aimess/constants";

import { emitPersonalizedSender } from "../../src/sockets/emit-personalized.js";
import { personalizeGroupSocketMessage } from "../../src/sockets/system-message-personalize.js";

interface FakeSocket {
  data: { userId: string; locale: string };
  emit: jest.Mock;
}

function fakeNamespace(sockets: FakeSocket[]) {
  return {
    // `local` is what the emitters use: every gateway node receives the same
    // Redis event, so each one personalises only the sockets IT holds.
    local: { in: () => ({ fetchSockets: async () => sockets }) },
    in: () => ({ fetchSockets: async () => sockets }),
    to: () => ({ emit: jest.fn() }),
  } as never;
}

const socket = (userId: string, locale: string): FakeSocket => ({
  data: { userId, locale },
  emit: jest.fn(),
});

const SYSTEM_MESSAGE = {
  conversationType: "GROUP",
  contentType: "SYSTEM",
  systemEvent: "MEMBER_REMOVED",
  systemData: {
    actorId: "admin-1",
    actorName: "Alex",
    targetUserId: "target-1",
    targetName: "Jim",
  },
  contentText: "Alex removed Jim",
  content: { text: "Alex removed Jim", urls: [], files: [] },
};

describe("emitPersonalizedSender — one broadcast, one language per recipient", () => {
  it("delivers the SAME group SYSTEM event in en, vi and th", async () => {
    const bystanderEn = socket("bystander-en", "en");
    const bystanderVi = socket("bystander-vi", "vi");
    const bystanderTh = socket("bystander-th", "th");

    await emitPersonalizedSender(
      fakeNamespace([bystanderEn, bystanderVi, bystanderTh]),
      "conv:room-1",
      "message:new",
      SYSTEM_MESSAGE,
      personalizeGroupSocketMessage
    );

    const textOf = (s: FakeSocket): string =>
      (s.emit.mock.calls[0][1] as { contentText: string }).contentText;

    expect(textOf(bystanderEn)).toBe("Alex removed Jim");
    expect(textOf(bystanderVi)).toBe("Alex đã xóa Jim");
    expect(textOf(bystanderTh)).toBe("AlexนำJimออกจากกลุ่ม");
  });

  it("gives the removed member the first-person line in THEIR language", async () => {
    const target = socket("target-1", "th");

    await emitPersonalizedSender(
      fakeNamespace([target]),
      "conv:room-1",
      "message:new",
      SYSTEM_MESSAGE,
      personalizeGroupSocketMessage
    );

    const payload = target.emit.mock.calls[0][1] as { contentText: string };
    expect(payload.contentText).toBe(t("SYS_GROUP_MEMBER_REMOVED_SELF", "th"));
  });

  it("localizes the sender-is-you swap instead of always saying 'You'", async () => {
    const sender = socket("sender-1", "vi");

    await emitPersonalizedSender(
      fakeNamespace([sender]),
      "conv:room-1",
      "message:new",
      { senderId: "sender-1", senderName: "Alex", contentText: "hi" }
    );

    const payload = sender.emit.mock.calls[0][1] as { senderName: string };
    expect(payload.senderName).toBe(t("SYS_SENDER_YOU", "vi"));
    expect(payload.senderName).not.toBe("You");
  });
});
