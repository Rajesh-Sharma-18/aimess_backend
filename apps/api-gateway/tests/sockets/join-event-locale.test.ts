/**
 * One action, one language.
 *
 * Adding a member emits TWO events to that member's own channel — the
 * `community:added` list row and the `community:message:new` timeline line —
 * and they were built by different code. The line was rebuilt per receiving
 * socket; the row shipped whatever language the producer baked in. On a session
 * that was not English that produced the reported split: an English
 * "You joined the community" row above a Vietnamese system line, seconds apart,
 * for the same add.
 *
 * `group:added` is the group twin of the same shape and is covered here too.
 */
import { t } from "@aimess/constants";

import { emitPersonalizedSender } from "../../src/sockets/emit-personalized.js";
import {
  personalizeCommunityAddedPreview,
  personalizeCommunitySocketMessage,
  personalizeConvUpdatedPreview,
} from "../../src/sockets/system-message-personalize.js";

/** The MEMBER_ADDED event both the list row and the chat line carry. */
const ADD_META = {
  actorName: "Harshil Vekariya 5",
  actorUserId: "bff2848c-614e-4162-b228-e2c4ce3f74f8",
  targetUserId: "u1",
  targetName: "Mind Flayer",
  communityName: "Flute Class10",
};

/** "{actor} added {target} to {community}", with `target` already resolved. */
const added = (locale: "en" | "vi" | "th", target: string) =>
  t("SYS_MEMBER_ADDED_TO", locale, {
    actor: "Harshil Vekariya 5",
    target,
    entity: "Flute Class10",
  });
const selfLine = (locale: "en" | "vi" | "th") =>
  added(locale, t("SYS_SENDER_YOU", locale));
const modLine = (locale: "en" | "vi" | "th") => added(locale, "Mind Flayer");

/** The payload community-service publishes for an admin-initiated add. */
const COMMUNITY_ADDED = {
  communityId: "c1",
  name: "Flute Class10",
  role: "MEMBER",
  via: "add_members",
  lastActivity: {
    type: "system",
    userId: null,
    username: null,
    preview: selfLine("en"),
    systemMessageType: "MEMBER_ADDED",
    systemMetadata: ADD_META,
    dateTime: 1787741385949,
  } as Record<string, unknown>,
};

/**
 * The system line the SAME add posts, as chat-service publishes it: the added
 * member's own PERSONAL copy, addressed to them via `systemMetadata.targetUserId`
 * — which is what makes it render second-person for that one recipient.
 */
const COMMUNITY_JOIN_LINE = {
  contentType: "SYSTEM",
  systemMessageType: "MEMBER_ADDED",
  systemMetadata: ADD_META,
  message: selfLine("en"),
  content: { text: selfLine("en") },
  isPersonal: true,
  communityId: "c1",
};

const previewOf = (payload: unknown): string =>
  (payload as { lastActivity: { preview: string } }).lastActivity.preview;
const lineOf = (payload: unknown): string =>
  (payload as { message: string }).message;

describe("community:added — the list row follows the recipient's socket", () => {
  it.each(["en", "vi", "th"] as const)(
    "renders the row in %s from the event, not the baked English",
    (locale) => {
      expect(
        previewOf(
          personalizeCommunityAddedPreview(COMMUNITY_ADDED, "u1", locale)
        )
      ).toBe(selfLine(locale));
    }
  );

  it("agrees with the system line of the SAME add, in every language", () => {
    for (const locale of ["en", "vi", "th"] as const) {
      const row = previewOf(
        personalizeCommunityAddedPreview(COMMUNITY_ADDED, "u1", locale)
      );
      const line = lineOf(
        personalizeCommunitySocketMessage(COMMUNITY_JOIN_LINE, "u1", locale)
      );
      // The SAME sentence, in the SAME language: one event, one rendering.
      expect(row).toBe(selfLine(locale));
      expect(line).toBe(selfLine(locale));
    }
  });

  it("renders the SAME add's moderator-only audit copy in the third person, per locale", () => {
    // The add posts two rows of one subtype: the member's own notice (above) and
    // the MODERATION audit line the community's owner/admin/moderators read. A
    // moderator is not the target, so their copy names both sides — and it is
    // still rebuilt for THEIR socket's language, never the adding admin's.
    for (const locale of ["en", "vi", "th"] as const) {
      const line = lineOf(
        personalizeCommunitySocketMessage(
          COMMUNITY_JOIN_LINE,
          "moderator-1",
          locale
        )
      );
      expect(line).toBe(modLine(locale));
    }
  });
  it("is the exact reported repro: an English session gets neither row nor line in Vietnamese", () => {
    const row = previewOf(
      personalizeCommunityAddedPreview(COMMUNITY_ADDED, "u1", "en")
    );
    const line = lineOf(
      personalizeCommunitySocketMessage(COMMUNITY_JOIN_LINE, "u1", "en")
    );
    expect(row).not.toBe(selfLine("vi"));
    expect(line).not.toBe(selfLine("vi"));
  });

  it("keeps the baked sentence for an unknown key rather than showing the key", () => {
    const payload = {
      ...COMMUNITY_ADDED,
      lastActivity: {
        ...COMMUNITY_ADDED.lastActivity,
        preview: "Something happened",
        previewKey: "SYS_NOT_IN_THIS_BUILD",
        systemMessageType: undefined,
        systemMetadata: undefined,
      },
    };
    expect(
      previewOf(personalizeCommunityAddedPreview(payload, "u1", "vi"))
    ).toBe("Something happened");
  });

  it("keeps a legacy row (retired key, no event) exactly as published", () => {
    // What community-service published before the add carried its event.
    const legacy = {
      ...COMMUNITY_ADDED,
      lastActivity: {
        type: "system",
        userId: null,
        username: null,
        preview: "You were added to the community",
        previewKey: "SYS_COMMUNITY_MEMBER_ADDED_SELF_SHORT",
        dateTime: 1787741385949,
      },
    };
    expect(personalizeCommunityAddedPreview(legacy, "u1", "th")).toBe(legacy);
  });

  it("gives two devices of the SAME account two languages from one publish", async () => {
    const phone = { data: { userId: "u1", locale: "vi" }, emit: jest.fn() };
    const laptop = { data: { userId: "u1", locale: "en" }, emit: jest.fn() };
    const namespace = {
      // `local` is what the emitters use: every gateway node receives the same
      // Redis event, so each one personalises only the sockets IT holds.
      local: { in: () => ({ fetchSockets: async () => [phone, laptop] }) },
      in: () => ({ fetchSockets: async () => [phone, laptop] }),
      to: () => ({ emit: jest.fn() }),
    } as never;

    await emitPersonalizedSender(
      namespace,
      "user:u1",
      "community:added",
      COMMUNITY_ADDED,
      personalizeCommunityAddedPreview
    );

    expect(previewOf(phone.emit.mock.calls[0][1])).toBe(selfLine("vi"));
    expect(previewOf(laptop.emit.mock.calls[0][1])).toBe(selfLine("en"));
  });
});

describe("group:added — the same rebuild on the DB snapshot shape", () => {
  // `group:added` republishes `GroupRoom.lastMessagePreview` verbatim, which
  // spells the field `messageType`; only the `conv:updated` bump normalizes it
  // to `contentType`.
  const GROUP_ADDED = {
    type: "GROUP",
    roomId: "grp_1",
    lastMessage: {
      messageType: "SYSTEM",
      text: "Alex added Jim",
      systemEvent: "MEMBER_ADDED",
      systemData: {
        actorId: "admin-1",
        actorName: "Alex",
        targetUserId: "target-1",
        targetName: "Jim",
      },
    },
  };
  const textOf = (p: unknown): string =>
    (p as { lastMessage: { text: string } }).lastMessage.text;

  it("rebuilds a SYSTEM snapshot that names its type `messageType`", () => {
    expect(textOf(personalizeConvUpdatedPreview(GROUP_ADDED, "x", "en"))).toBe(
      "Alex added Jim to the group"
    );
    expect(
      textOf(personalizeConvUpdatedPreview(GROUP_ADDED, "x", "vi"))
    ).not.toBe("Alex added Jim");
  });

  it("gives the ADDED member their own first-person line, in their language", () => {
    expect(
      textOf(personalizeConvUpdatedPreview(GROUP_ADDED, "target-1", "th"))
    ).toBe("Alexเพิ่มคุณเข้ากลุ่ม");
  });
});
