/**
 * The community-list `lastActivity` ROLLBACK contract after a message is removed
 * (delete-for-everyone / auto-delete / pin-line retraction).
 *
 * Bug this pins down: community-service's canonical bump is forward-only
 * (`WHERE lastActivityAt < :at`), so it cannot move the pointer backward. Every
 * delete call site got past that guard by sending `Date.now()` — which wrote the
 * DELETION's timestamp. `GET /communities/mine` then showed the PREVIOUS
 * message's preview next to a just-now timestamp, and the community stayed
 * pinned to the top of a list ordered by `lastActivityAt`.
 *
 * Contract now: send the previous visible message's REAL `createdAt` plus
 * `rollbackNotNewerThan` (the removed message's own `createdAt`), which selects
 * community-service's backward path — guarded so anything that landed after the
 * delete wins (the auto-delete-sweeper-vs-new-message race).
 */
jest.mock("../../src/events/publish-community-activity.js", () => ({
  publishCommunityActivitySafe: jest.fn(),
}));
jest.mock("../../src/grpc/community.client.js", () => ({
  getCommunityReconcileClient: jest.fn(),
}));

import {
  reconcileCommunityLastActivityAfterDelete,
  bumpTimestampAfterDelete,
} from "../../src/events/community-last-activity.js";
import { publishCommunityActivitySafe } from "../../src/events/publish-community-activity.js";
import { getCommunityReconcileClient } from "../../src/grpc/community.client.js";

const pubActivity = publishCommunityActivitySafe as jest.Mock;
const reconcileClient = getCommunityReconcileClient as jest.Mock;
const updateMessageActivity = jest.fn(async () => true);

const COMMUNITY = "cmt-1";
/** The message that was just removed — 10:10. */
const REMOVED_AT = new Date("2026-08-10T10:10:00.000Z");
/** The previous still-visible message — 10:05. */
const PREV_AT = new Date("2026-08-10T10:05:00.000Z");

beforeEach(() => {
  jest.clearAllMocks();
  updateMessageActivity.mockClear().mockResolvedValue(true);
  reconcileClient.mockReturnValue({ updateMessageActivity });
});

const withPrev = {
  prevMessageId: "msg-prev",
  preview: "Hi",
  messageType: "text",
  sentBy: "peer-1",
  senderName: "Peer One",
  createdAt: PREV_AT,
  hasLastMessage: true,
  clientMessageId: "cmid-2",
  sequenceNumber: 7,
};

const emptied = {
  prevMessageId: null,
  preview: "",
  messageType: "",
  sentBy: "",
  senderName: "",
  createdAt: new Date(0),
  hasLastMessage: false,
};

describe("reconcileCommunityLastActivityAfterDelete", () => {
  it("rolls lastActivity BACK to the previous visible message's own timestamp — never the deletion time", async () => {
    const before = Date.now();
    await reconcileCommunityLastActivityAfterDelete({
      communityId: COMMUNITY,
      recalc: withPrev,
      removedAt: REMOVED_AT,
    });

    expect(updateMessageActivity).toHaveBeenCalledTimes(1);
    const sent = updateMessageActivity.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(sent.lastMessageAt).toBe(PREV_AT.getTime());
    expect(sent.lastMessageAt).toBeLessThan(before); // i.e. NOT Date.now()
    expect(sent.lastMessageId).toBe("msg-prev");
    expect(sent.messagePreview).toBe("Hi");
    expect(sent.contentType).toBe("TEXT");
    expect(sent.seq).toBe(7);
    // The rollback guard: only apply while the stored pointer is not newer than
    // the message we removed.
    expect(sent.rollbackNotNewerThan).toBe(REMOVED_AT.getTime());
  });

  it("carries the previous message's real timestamp on the async backstop too, so the queue can never re-write a fabricated 'now'", async () => {
    await reconcileCommunityLastActivityAfterDelete({
      communityId: COMMUNITY,
      recalc: withPrev,
      removedAt: REMOVED_AT,
    });

    expect(pubActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: COMMUNITY,
        lastMessageAt: PREV_AT.toISOString(),
        lastMessageId: "msg-prev",
      })
    );
  });

  it("room emptied by the delete: sends lastMessageAt 0 (community-service falls back to the community's createdAt), not 'now'", async () => {
    await reconcileCommunityLastActivityAfterDelete({
      communityId: COMMUNITY,
      recalc: emptied,
      removedAt: REMOVED_AT,
    });

    expect(updateMessageActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: COMMUNITY,
        lastMessageAt: 0,
        lastMessageId: "",
        messagePreview: "",
        rollbackNotNewerThan: REMOVED_AT.getTime(),
      })
    );
    // Nothing to point at → no async bump at all.
    expect(pubActivity).not.toHaveBeenCalled();
  });

  it("falls back to 'now' as the rollback guard when the caller has no removed-message timestamp (pin-line retraction)", async () => {
    const before = Date.now();
    await reconcileCommunityLastActivityAfterDelete({
      communityId: COMMUNITY,
      recalc: withPrev,
    });

    const sent = updateMessageActivity.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(sent.lastMessageAt).toBe(PREV_AT.getTime());
    expect(sent.rollbackNotNewerThan as number).toBeGreaterThanOrEqual(before);
  });
});

describe("bumpTimestampAfterDelete (realtime community:updated / conv:updated)", () => {
  it("uses the previous visible message's timestamp", () => {
    expect(bumpTimestampAfterDelete(withPrev)).toBe(PREV_AT.getTime());
  });

  it("uses 0 — never Date.now() — when nothing visible remains, so a client sorting on it does not pin an emptied room to the top", () => {
    expect(bumpTimestampAfterDelete(emptied)).toBe(0);
  });
});
