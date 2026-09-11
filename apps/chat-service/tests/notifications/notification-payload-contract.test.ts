/**
 * The language-neutral half of a notification row.
 *
 * A row now says WHICH sentence it is (`templateId`) and WITH WHAT values
 * (`params`) alongside the rendered `title`/`body`, so a client can re-render a
 * cached row after an offline language switch. Authored content — an admin
 * announcement, a ban notice — has no template and keeps its stored text, which
 * is the whole backward-compatibility story: nothing is migrated and nothing is
 * removed.
 */
import { callCopy, friendCopy, DELETED_ACCOUNT_DISPLAY_NAME } from "@aimess/constants";

import type { Notification } from "../../src/generated/prisma/index.js";
import { serializeNotification } from "../../src/lib/notification-serializer.js";

function row(
  type: string,
  payload: Record<string, unknown>
): Notification {
  return {
    id: "n1",
    userId: "viewer-1",
    actorId: "",
    entity: {},
    actorSnapshot: {},
    isRead: false,
    readAt: null,
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date("2026-09-09T10:00:00Z"),
    updatedAt: new Date("2026-09-09T10:00:00Z"),
    loginSessionId: null,
    loginExpiresAt: null,
    loginResolvedAt: null,
    groupKey: null,
    version: 1,
    type,
    payload,
  } as unknown as Notification;
}

/** A row as `push.service.ts` writes it: rendered text PLUS a replay ticket. */
function ticketedRow(
  type: string,
  copy: { descriptor?: { ref: string; args: unknown[] } },
  rendered: { title: string; body: string }
): Notification {
  return row(type, {
    ...rendered,
    data: { copyRef: JSON.stringify(copy.descriptor) },
  });
}

describe("notification payload contract", () => {
  it("carries the catalogue id every client keys its chips on", async () => {
    const cases: [string, string][] = [
      ["friend.requested", "FRIEND_REQUEST"],
      ["community.member_banned", "COMMUNITY"],
      ["chat.mention", "MENTION"],
      ["call.activity", "CALLS"],
      ["auth.security_new_login", "SYSTEM"],
      ["ANNOUNCEMENT", "SYSTEM"],
      ["community.livestream_started", "LIVE_NOW"],
    ];
    for (const [type, expected] of cases) {
      const dto = await serializeNotification(row(type, {}), "viewer-1");
      expect(dto.categoryId).toBe(expected);
    }
  });

  it("keeps the legacy `category` field released clients already read", async () => {
    // A livestream row is LIVE_NOW on the new field and still COMMUNITIES on
    // the old one — moving the old value would retag rows under a shipped
    // client's feet.
    const dto = await serializeNotification(
      row("community.livestream_started", {}),
      "viewer-1"
    );
    expect(dto.category).toBe("COMMUNITIES");
    expect(dto.categoryId).toBe("LIVE_NOW");
  });

  it("names the template and its parameters", async () => {
    const dto = await serializeNotification(
      ticketedRow("friend.requested", friendCopy.requested("Viddhi"), {
        title: "Viddhi",
        body: "Viddhi has sent you a friend request.",
      }),
      "viewer-1"
    );

    expect(dto.templateId).toBe("friend.requested");
    expect(dto.params).toEqual({ requesterName: "Viddhi" });
  });

  it("still ships a rendered body beside the template, for clients that do not know it", async () => {
    const copy = callCopy.activity("Krish", "VIDEO", "ANSWERED", "OUTGOING", 42);
    const dto = await serializeNotification(
      ticketedRow("call.activity", copy, {
        title: "Krish",
        body: "written-at-publish-time",
      }),
      "viewer-1"
    );

    expect(dto.templateId).toBe("call.activity");
    expect(dto.params).toMatchObject({ peerName: "Krish", callType: "VIDEO" });
    // A ticketed row is re-rendered in the reader's language on every read, so
    // the fallback text a client sees is the CURRENT rendering of the same
    // template — never the sentence frozen into the row at publish time.
    expect(dto.body).toBe(copy("en").body);
    expect(dto.body).not.toBe("written-at-publish-time");
  });

  it("omits the template for authored content so it is never re-rendered", async () => {
    const dto = await serializeNotification(
      row("ANNOUNCEMENT", {
        title: "Scheduled maintenance",
        body: "We are upgrading tonight.",
      }),
      "viewer-1"
    );

    expect(dto.templateId).toBeUndefined();
    expect(dto.params).toBeUndefined();
    expect(dto.body).toBe("We are upgrading tonight.");
  });

  it("omits the template for a row written before replay tickets existed", async () => {
    const dto = await serializeNotification(
      row("friend.requested", {
        title: "Viddhi",
        body: "Viddhi has sent you a friend request.",
      }),
      "viewer-1"
    );

    expect(dto.templateId).toBeUndefined();
    expect(dto.body).toBe("Viddhi has sent you a friend request.");
  });

  it("anonymises a deleted actor's name in the params, not just the prose", async () => {
    // Otherwise a client rendering from `templateId` + `params` would print the
    // old name straight back onto a card whose own body says Deleted Account.
    const row = ticketedRow("friend.requested", friendCopy.requested("Alice"), {
      title: "Alice",
      body: "Alice has sent you a friend request.",
    });
    (row as { actorId: string }).actorId = "actor-1";
    // Producers write the actor's name into `data` as well as into the ticket;
    // that stored copy is what the scrub matches on.
    (row.payload as { data: Record<string, string> }).data.actorDisplayName = "Alice";

    const dto = await serializeNotification(row, "viewer-1", {
      actorById: new Map([
        [
          "actor-1",
          { displayName: DELETED_ACCOUNT_DISPLAY_NAME, avatarUrl: "", isDeleted: true },
        ],
      ]),
      communityById: new Map(),
    });

    expect(dto.params).toEqual({ requesterName: DELETED_ACCOUNT_DISPLAY_NAME });
    expect(dto.body).not.toContain("Alice");
  });

  it("refreshes a stale actor name in the params", async () => {
    // The producer wrote "Someone" because the profile was not ready yet; the
    // fresh snapshot has the real name, and both halves of the row must agree.
    const row = ticketedRow("friend.requested", friendCopy.requested("Someone"), {
      title: "Someone",
      body: "Someone has sent you a friend request.",
    });
    (row as { actorId: string }).actorId = "actor-2";
    (row.payload as { data: Record<string, string> }).data.actorDisplayName = "Someone";

    const dto = await serializeNotification(row, "viewer-1", {
      actorById: new Map([
        ["actor-2", { displayName: "Mohit", avatarUrl: "" }],
      ]),
      communityById: new Map(),
    });

    expect(dto.params).toEqual({ requesterName: "Mohit" });
  });

  it("does not leak the raw replay ticket onto the wire", async () => {
    const dto = await serializeNotification(
      ticketedRow("friend.requested", friendCopy.requested("Viddhi"), {
        title: "Viddhi",
        body: "Viddhi has sent you a friend request.",
      }),
      "viewer-1"
    );

    const data = (dto.payload as { data?: Record<string, unknown> }).data ?? {};
    expect(data.copyRef).toBeUndefined();
  });
});
