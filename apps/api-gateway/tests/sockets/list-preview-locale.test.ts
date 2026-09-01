/**
 * The list row and the transcript preview the SAME message, so they must agree
 * on language. `message:new` was rebuilt per recipient long before the bump was,
 * which is how a Thai reader ended up with a Thai transcript under an English
 * inbox row.
 */
import { t } from "@aimess/constants";

import { emitPersonalizedSender } from "../../src/sockets/emit-personalized.js";
import {
  personalizeCommunityUpdatedPreview,
  personalizeConvUpdatedPreview,
} from "../../src/sockets/system-message-personalize.js";

const GROUP_BUMP = {
  type: "GROUP",
  roomId: "grp_1",
  lastMessageId: "m1",
  lastMessage: {
    contentType: "SYSTEM",
    text: "Alex removed Jim",
    systemEvent: "MEMBER_REMOVED",
    systemData: {
      actorId: "admin-1",
      actorName: "Alex",
      targetUserId: "target-1",
      targetName: "Jim",
    },
  },
};

const previewOf = (payload: unknown): string =>
  ((payload as { lastMessage: { text: string } }).lastMessage ?? {}).text;

describe("personalizeConvUpdatedPreview", () => {
  it("renders the row in the reader's language", () => {
    expect(
      previewOf(personalizeConvUpdatedPreview(GROUP_BUMP, "x", "en"))
    ).toBe("Alex removed Jim");
    expect(
      previewOf(personalizeConvUpdatedPreview(GROUP_BUMP, "x", "vi"))
    ).toBe("Alex đã xóa Jim");
    expect(
      previewOf(personalizeConvUpdatedPreview(GROUP_BUMP, "x", "th"))
    ).toBe("AlexนำJimออกจากกลุ่ม");
  });

  it("gives the subject member the first-person row in THEIR language", () => {
    expect(
      previewOf(personalizeConvUpdatedPreview(GROUP_BUMP, "target-1", "th"))
    ).toBe(t("SYS_GROUP_MEMBER_REMOVED_SELF", "th"));
  });

  it("never translates the interpolated names", () => {
    const th = previewOf(personalizeConvUpdatedPreview(GROUP_BUMP, "x", "th"));
    expect(th).toContain("Alex");
    expect(th).toContain("Jim");
  });

  it("uses the PRIVATE renderer for a private room", () => {
    const bump = {
      type: "PRIVATE",
      lastMessage: {
        contentType: "SYSTEM",
        text: "Alice pinned a message",
        systemEvent: "MESSAGE_PINNED",
        systemData: { actorId: "member-1", actorName: "Alice" },
      },
    };
    expect(
      previewOf(personalizeConvUpdatedPreview(bump, "member-1", "en"))
    ).toBe("You pinned a message");
  });

  it("leaves a legacy bump (no systemEvent) exactly as published", () => {
    const legacy = {
      type: "GROUP",
      lastMessage: { contentType: "SYSTEM", text: "Alex removed Jim" },
    };
    expect(personalizeConvUpdatedPreview(legacy, "x", "th")).toBe(legacy);
  });

  it("leaves an ordinary message bump alone", () => {
    const chat = {
      type: "PRIVATE",
      lastMessage: { contentType: "TEXT", text: "sawadee" },
    };
    expect(personalizeConvUpdatedPreview(chat, "x", "th")).toBe(chat);
  });
});

describe("personalizeCommunityUpdatedPreview", () => {
  const bump = {
    communityId: "c1",
    lastMessage: {
      contentType: "SYSTEM",
      text: "Jim is now a moderator",
      systemMessageType: "ROLE_CHANGED",
      systemMetadata: {
        actorUserId: "admin-1",
        actorName: "Alex",
        targetUserId: "target-1",
        targetName: "Jim",
        newRole: "MODERATOR",
      },
    },
  };

  it("translates the community row per reader and keeps the name intact", () => {
    const th = previewOf(personalizeCommunityUpdatedPreview(bump, "x", "th"));
    expect(th).not.toBe("Jim is now a moderator");
    expect(th).toContain("Jim");
  });

  it("leaves a legacy community bump untouched", () => {
    const legacy = {
      communityId: "c1",
      lastMessage: { contentType: "SYSTEM", text: "Jim is now a moderator" },
    };
    expect(personalizeCommunityUpdatedPreview(legacy, "x", "th")).toBe(legacy);
  });
});

describe("one bump, one language per recipient", () => {
  const socket = (userId: string, locale: string) => ({
    data: { userId, locale },
    emit: jest.fn(),
  });

  it("fans a single conv:updated out as three languages", async () => {
    const en = socket("bystander-en", "en");
    const vi = socket("bystander-vi", "vi");
    const th = socket("bystander-th", "th");
    const namespace = {
      // `local` is what the emitters use: every gateway node receives the same
      // Redis event, so each one personalises only the sockets IT holds.
      local: { in: () => ({ fetchSockets: async () => [en, vi, th] }) },
      in: () => ({ fetchSockets: async () => [en, vi, th] }),
      to: () => ({ emit: jest.fn() }),
    } as never;

    await emitPersonalizedSender(
      namespace,
      "user:bystander-en",
      "conv:updated",
      GROUP_BUMP,
      personalizeConvUpdatedPreview
    );

    expect(previewOf(en.emit.mock.calls[0][1])).toBe("Alex removed Jim");
    expect(previewOf(vi.emit.mock.calls[0][1])).toBe("Alex đã xóa Jim");
    expect(previewOf(th.emit.mock.calls[0][1])).toBe("AlexนำJimออกจากกลุ่ม");
  });

  it("translates a media LABEL row per reader, and only the label", () => {
    const voiceBump = {
      type: "PRIVATE",
      lastMessage: { contentType: "VOICE", text: "🎤 Voice Message" },
    };
    expect(previewOf(personalizeConvUpdatedPreview(voiceBump, "x", "en"))).toBe(
      "🎤 Voice Message"
    );
    expect(previewOf(personalizeConvUpdatedPreview(voiceBump, "x", "vi"))).toBe(
      t("PREVIEW_VOICE", "vi")
    );
    expect(previewOf(personalizeConvUpdatedPreview(voiceBump, "x", "th"))).toBe(
      t("PREVIEW_VOICE", "th")
    );

    // A preview carrying user data (a filename) is never rewritten.
    const docBump = {
      type: "PRIVATE",
      lastMessage: { contentType: "DOCUMENT", text: "📄 q3-report.pdf" },
    };
    expect(previewOf(personalizeConvUpdatedPreview(docBump, "x", "th"))).toBe(
      "📄 q3-report.pdf"
    );

    // TEXT is user-written — never touched, in any language.
    const textBump = {
      type: "PRIVATE",
      lastMessage: { contentType: "TEXT", text: "Voice Message" },
    };
    expect(previewOf(personalizeConvUpdatedPreview(textBump, "x", "vi"))).toBe(
      "Voice Message"
    );
  });
});
