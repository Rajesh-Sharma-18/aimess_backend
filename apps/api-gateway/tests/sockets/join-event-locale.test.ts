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
    preview: t("SYS_COMMUNITY_MEMBER_ADDED_SELF_SHORT", "en"),
    previewKey: "SYS_COMMUNITY_MEMBER_ADDED_SELF_SHORT",
    dateTime: 1787741385949,
  },
};

/** The system line the SAME add posts, as chat-service publishes it. */
const COMMUNITY_JOIN_LINE = {
  contentType: "SYSTEM",
  systemMessageType: "MEMBER_ADDED",
  systemMetadata: {
    actorName: "Harshil Vekariya 5",
    actorUserId: "bff2848c-614e-4162-b228-e2c4ce3f74f8",
  },
  message: t("SYS_COMMUNITY_MEMBER_ADDED_SELF", "en", {
    actor: "Harshil Vekariya 5",
  }),
  content: {
    text: t("SYS_COMMUNITY_MEMBER_ADDED_SELF", "en", {
      actor: "Harshil Vekariya 5",
    }),
  },
  isPersonal: true,
  communityId: "c1",
};

const previewOf = (payload: unknown): string =>
  (payload as { lastActivity: { preview: string } }).lastActivity.preview;
const lineOf = (payload: unknown): string =>
  (payload as { message: string }).message;

describe("community:added — the list row follows the recipient's socket", () => {
  it.each(["en", "vi", "th"] as const)(
    "renders the row in %s from the key, not the baked English",
    (locale) => {
      expect(
        previewOf(
          personalizeCommunityAddedPreview(COMMUNITY_ADDED, "u1", locale)
        )
      ).toBe(t("SYS_COMMUNITY_MEMBER_ADDED_SELF_SHORT", locale));
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
      // Not the same sentence (the row is deliberately actor-less), but they
      // must never disagree about which LANGUAGE they are in.
      expect(row).toBe(t("SYS_COMMUNITY_MEMBER_ADDED_SELF_SHORT", locale));
      expect(line).toBe(
        t("SYS_COMMUNITY_MEMBER_ADDED_SELF", locale, {
          actor: "Harshil Vekariya 5",
        })
      );
    }
  });

  it("is the exact reported repro: an English session gets neither row nor line in Vietnamese", () => {
    const row = previewOf(
      personalizeCommunityAddedPreview(COMMUNITY_ADDED, "u1", "en")
    );
    const line = lineOf(
      personalizeCommunitySocketMessage(COMMUNITY_JOIN_LINE, "u1", "en")
    );
    expect(row).not.toBe(t("SYS_COMMUNITY_MEMBER_ADDED_SELF_SHORT", "vi"));
    expect(line).not.toBe(
      t("SYS_COMMUNITY_MEMBER_ADDED_SELF", "vi", {
        actor: "Harshil Vekariya 5",
      })
    );
  });

  it("keeps the baked sentence for an unknown key rather than showing the key", () => {
    const payload = {
      ...COMMUNITY_ADDED,
      lastActivity: {
        ...COMMUNITY_ADDED.lastActivity,
        preview: "Something happened",
        previewKey: "SYS_NOT_IN_THIS_BUILD",
      },
    };
    expect(
      previewOf(personalizeCommunityAddedPreview(payload, "u1", "vi"))
    ).toBe("Something happened");
  });

  it("keeps a legacy row (no key at all) exactly as published", () => {
    const legacy = {
      ...COMMUNITY_ADDED,
      lastActivity: { ...COMMUNITY_ADDED.lastActivity, previewKey: undefined },
    };
    expect(personalizeCommunityAddedPreview(legacy, "u1", "th")).toBe(legacy);
  });

  it("gives two devices of the SAME account two languages from one publish", async () => {
    const phone = { data: { userId: "u1", locale: "vi" }, emit: jest.fn() };
    const laptop = { data: { userId: "u1", locale: "en" }, emit: jest.fn() };
    const namespace = {
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

    expect(previewOf(phone.emit.mock.calls[0][1])).toBe(
      t("SYS_COMMUNITY_MEMBER_ADDED_SELF_SHORT", "vi")
    );
    expect(previewOf(laptop.emit.mock.calls[0][1])).toBe(
      t("SYS_COMMUNITY_MEMBER_ADDED_SELF_SHORT", "en")
    );
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
      "Alex added Jim"
    );
    expect(
      textOf(personalizeConvUpdatedPreview(GROUP_ADDED, "x", "vi"))
    ).not.toBe("Alex added Jim");
  });

  it("gives the ADDED member their own first-person line, in their language", () => {
    expect(
      textOf(personalizeConvUpdatedPreview(GROUP_ADDED, "target-1", "th"))
    ).toBe(t("SYS_GROUP_MEMBER_ADDED_SELF", "th", { actor: "Alex" }));
  });
});
