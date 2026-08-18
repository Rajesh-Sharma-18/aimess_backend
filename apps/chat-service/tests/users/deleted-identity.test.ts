/**
 * Deleted-account identity scrubbing.
 *
 * The product rule: an account is never hard-deleted, so its userId keeps
 * appearing everywhere history is preserved — conversation rows, member lists,
 * message senders, quoted replies, system lines. Every one of those surfaces
 * must render "Deleted Account" and must NOT render the old name, username or
 * avatar. These tests pin the two chokepoints that make that true for
 * chat-service:
 *
 *  - `resolveDisplayName` — the single name resolver behind the private list,
 *    private room details, group member list, group roster, pins, reactions and
 *    read receipts;
 *  - `lib/deleted-identity` — the read-time scrubber for group and community
 *    message rows, which denormalize senderName/senderAvatar at WRITE time and
 *    would otherwise keep the old name frozen into history forever.
 */
import { DELETED_ACCOUNT_DISPLAY_NAME } from "@aimess/constants";

import {
  anonymizeSystemData,
  anonymizeWireSender,
  collectDeletedUserIds,
  refreshWireSenderAvatar,
  collectRowUserIds,
} from "../../src/lib/deleted-identity.js";
import { resolveDisplayName } from "../../src/services/user-snapshot.service.js";

const DELETED = "11111111-1111-4111-8111-111111111111";
const ALIVE = "22222222-2222-4222-8222-222222222222";

describe("resolveDisplayName", () => {
  it("returns the deleted-account label for a deleted snapshot", () => {
    expect(
      resolveDisplayName({
        userId: DELETED,
        displayName: "Jane Cooper",
        memberId: "janecooper02",
        isDeletedUser: true,
      })
    ).toBe(DELETED_ACCOUNT_DISPLAY_NAME);
  });

  it("wins over EVERY fallback in the chain, including a stale memberId", () => {
    // The whole point: a snapshot cached before the deletion still carries the
    // old fullName/username/memberId. None of them may surface.
    expect(
      resolveDisplayName({
        fullName: "Jane Cooper",
        displayName: "Jane Cooper",
        username: "janecooper02",
        memberId: "janecooper02",
        isDeletedUser: true,
      })
    ).toBe(DELETED_ACCOUNT_DISPLAY_NAME);
  });

  it("leaves a live user's name untouched", () => {
    expect(
      resolveDisplayName({ displayName: "Wade Warren", isDeletedUser: false })
    ).toBe("Wade Warren");
  });
});

describe("collectRowUserIds", () => {
  it("finds the sender under both the group and community column names", () => {
    expect(collectRowUserIds({ senderId: ALIVE })).toContain(ALIVE);
    expect(collectRowUserIds({ sentBy: ALIVE })).toContain(ALIVE);
  });

  it("finds quoted senders and system actors/targets", () => {
    const ids = collectRowUserIds({
      senderId: "s",
      quoteData: { senderId: "q" },
      systemData: {
        actorId: "a",
        targetUserId: "t",
        targetUserIds: ["g1", "g2"],
      },
    });
    expect(ids).toEqual(
      expect.arrayContaining(["s", "q", "a", "t", "g1", "g2"])
    );
  });
});

describe("collectDeletedUserIds", () => {
  const cacheRepo = {} as never;

  it("returns only the ids whose snapshot reports the account deleted", async () => {
    const service = {
      getUserSnapshotsMap: jest.fn(
        async () =>
          new Map<string, Record<string, unknown>>([
            [DELETED, { isDeletedUser: true }],
            [ALIVE, { isDeletedUser: false }],
          ])
      ),
    } as never as Parameters<typeof collectDeletedUserIds>[1];

    const result = await collectDeletedUserIds(
      [DELETED, ALIVE, DELETED, null, undefined, ""],
      service,
      cacheRepo
    );
    expect([...result]).toEqual([DELETED]);
  });

  it("does not look anything up when the page names nobody", async () => {
    const getUserSnapshotsMap = jest.fn();
    const result = await collectDeletedUserIds(
      [null, undefined, ""],
      { getUserSnapshotsMap } as never as Parameters<
        typeof collectDeletedUserIds
      >[1],
      cacheRepo
    );
    expect(result.size).toBe(0);
    expect(getUserSnapshotsMap).not.toHaveBeenCalled();
  });
});

describe("anonymizeWireSender", () => {
  it("replaces the frozen sender name and avatar on a deleted sender's message", () => {
    const wire: Record<string, unknown> = {
      senderId: DELETED,
      senderName: "Jane Cooper",
      senderAvatar: "avatars/jane/abc.webp",
      contentType: "TEXT",
    };
    anonymizeWireSender(wire, new Set([DELETED]));
    expect(wire.senderName).toBe(DELETED_ACCOUNT_DISPLAY_NAME);
    expect(wire.senderAvatar).toBe("");
    expect(wire.isDeletedUser).toBe(true);
  });

  it("resolves the community column name (sentBy) too", () => {
    const wire: Record<string, unknown> = {
      sentBy: DELETED,
      senderName: "Jane Cooper",
      senderAvatar: "avatars/jane/abc.webp",
      contentType: "IMAGE",
    };
    anonymizeWireSender(wire, new Set([DELETED]));
    expect(wire.senderName).toBe(DELETED_ACCOUNT_DISPLAY_NAME);
    expect(wire.isDeletedUser).toBe(true);
  });

  it("stamps isDeletedUser=false on a live sender and changes nothing else", () => {
    const wire: Record<string, unknown> = {
      senderId: ALIVE,
      senderName: "Wade Warren",
      senderAvatar: "avatars/wade/abc.webp",
      contentType: "TEXT",
    };
    anonymizeWireSender(wire, new Set([DELETED]));
    expect(wire.senderName).toBe("Wade Warren");
    expect(wire.senderAvatar).toBe("avatars/wade/abc.webp");
    expect(wire.isDeletedUser).toBe(false);
  });

  it("does NOT give a SYSTEM row a sender", () => {
    // Both serializers deliberately blank senderName/senderAvatar on SYSTEM
    // rows (the actor lives in systemData). Filling them in here would render
    // the line as if "Deleted Account" had sent it.
    const wire: Record<string, unknown> = {
      senderId: DELETED,
      senderName: "",
      senderAvatar: "",
      contentType: "SYSTEM",
    };
    anonymizeWireSender(wire, new Set([DELETED]));
    expect(wire.senderName).toBe("");
    expect(wire.senderAvatar).toBe("");
  });

  it("scrubs the quoted sender of a reply independently of the sender", () => {
    const wire: Record<string, unknown> = {
      senderId: ALIVE,
      senderName: "Wade Warren",
      contentType: "TEXT",
      quoteData: {
        senderId: DELETED,
        senderName: "Jane Cooper",
        senderAvatar: "avatars/jane/abc.webp",
        preview: "see you tomorrow",
      },
    };
    anonymizeWireSender(wire, new Set([DELETED]));
    const quote = wire.quoteData as Record<string, unknown>;
    expect(wire.senderName).toBe("Wade Warren");
    expect(quote.senderName).toBe(DELETED_ACCOUNT_DISPLAY_NAME);
    expect(quote.senderAvatar).toBe("");
    expect(quote.isDeletedUser).toBe(true);
    // The quoted CONTENT survives — deletion anonymizes identity, not history.
    expect(quote.preview).toBe("see you tomorrow");
  });
});

describe("anonymizeSystemData", () => {
  it("is a no-op (same reference) when nobody on the row is deleted", () => {
    const data = { actorId: ALIVE, actorName: "Wade Warren" };
    expect(anonymizeSystemData(data, new Set([DELETED]))).toBe(data);
    expect(anonymizeSystemData(data, new Set())).toBe(data);
  });

  it("replaces the actor's name but keeps the id", () => {
    const out = anonymizeSystemData(
      { actorId: DELETED, actorName: "Jane Cooper" },
      new Set([DELETED])
    );
    expect(out.actorName).toBe(DELETED_ACCOUNT_DISPLAY_NAME);
    // The id drives the renderer's "You were added" second-person wording.
    expect(out.actorId).toBe(DELETED);
  });

  it("replaces the single target's name", () => {
    const out = anonymizeSystemData(
      {
        actorId: ALIVE,
        actorName: "Wade Warren",
        targetUserId: DELETED,
        targetName: "Jane Cooper",
      },
      new Set([DELETED])
    );
    expect(out.actorName).toBe("Wade Warren");
    expect(out.targetName).toBe(DELETED_ACCOUNT_DISPLAY_NAME);
  });

  it("replaces only the deleted entries of a grouped batch-add line", () => {
    const out = anonymizeSystemData(
      {
        actorId: ALIVE,
        actorName: "Wade Warren",
        targetUserIds: [DELETED, ALIVE],
        targetNames: ["Jane Cooper", "Nguyen Van A"],
      },
      new Set([DELETED])
    );
    expect(out.targetNames).toEqual([
      DELETED_ACCOUNT_DISPLAY_NAME,
      "Nguyen Van A",
    ]);
  });
});

describe("refreshWireSenderAvatar", () => {
  const LIVE = new Map([
    ["u1", { isDeleted: false, avatar: "avatars/new.png" }],
    ["u2", { isDeleted: false, avatar: "" }],
    ["gone", { isDeleted: true, avatar: "" }],
  ]);

  it("swaps the frozen sender avatar key for the sender's current one", () => {
    const wire: Record<string, unknown> = {
      senderId: "u1",
      contentType: "TEXT",
      senderAvatar: "avatars/old.png",
    };
    refreshWireSenderAvatar(wire, LIVE);
    expect(wire.senderAvatar).toBe("avatars/new.png");
  });

  it("clears the frozen key when the sender removed their picture", () => {
    const wire: Record<string, unknown> = {
      sentBy: "u2",
      contentType: "IMAGE",
      senderAvatar: "avatars/old.png",
    };
    refreshWireSenderAvatar(wire, LIVE);
    expect(wire.senderAvatar).toBe("");
  });

  it("leaves SYSTEM rows and unknown senders alone", () => {
    const system: Record<string, unknown> = {
      senderId: "u1",
      contentType: "SYSTEM",
      senderAvatar: "",
    };
    refreshWireSenderAvatar(system, LIVE);
    expect(system.senderAvatar).toBe("");

    // Snapshot lookup degraded for this sender — stale beats blank.
    const unknown: Record<string, unknown> = {
      senderId: "nobody",
      contentType: "TEXT",
      senderAvatar: "avatars/old.png",
    };
    refreshWireSenderAvatar(unknown, LIVE);
    expect(unknown.senderAvatar).toBe("avatars/old.png");
  });

  it("does not resurrect a deleted account's avatar", () => {
    const wire: Record<string, unknown> = {
      senderId: "gone",
      contentType: "TEXT",
      senderAvatar: "avatars/old.png",
    };
    refreshWireSenderAvatar(wire, LIVE);
    // Untouched here; anonymizeWireSender is what blanks it.
    expect(wire.senderAvatar).toBe("avatars/old.png");
    anonymizeWireSender(wire, new Set(["gone"]));
    expect(wire.senderAvatar).toBe("");
  });

  it("refreshes the quoted sender's avatar too", () => {
    const wire: Record<string, unknown> = {
      senderId: "u2",
      contentType: "TEXT",
      senderAvatar: "",
      quoteData: { senderId: "u1", senderAvatar: "avatars/old.png" },
    };
    refreshWireSenderAvatar(wire, LIVE);
    expect((wire.quoteData as Record<string, unknown>).senderAvatar).toBe(
      "avatars/new.png"
    );
  });
});
