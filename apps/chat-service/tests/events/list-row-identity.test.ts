/**
 * Offline-first list identity + tombstone contract.
 *
 * The client merges each incoming list row field-by-field against its local
 * cache using a monotonic freshness rule. These are the fields that make that
 * merge possible, and the ONLY thing worth pinning down is that they are
 * always present with their documented defaults — an absent field and a
 * `null`/`0` field mean different things to that merge.
 */
import {
  buildDeletePayload,
  tombstoneWireFields,
} from "../../src/lib/chat-message.serializer.js";
import { listRowIdentity } from "../../src/lib/list-row-identity.js";

describe("listRowIdentity", () => {
  it("reads the quartet off a stored message row", () => {
    expect(
      listRowIdentity({
        id: "m1",
        clientMessageId: "cmid-1",
        sequenceNumber: 42,
        revision: 7,
      })
    ).toEqual({
      messageId: "m1",
      clientMessageId: "cmid-1",
      seq: 42,
      revision: 7,
    });
  });

  it("accepts the raw Mongo `_id` shape the repositories pass", () => {
    expect(listRowIdentity({ _id: "m2" }).messageId).toBe("m2");
  });

  it("defaults a pre-backfill / server-generated row to null + 0, never undefined", () => {
    // `undefined` would be dropped by JSON.stringify, which the client reads as
    // "field absent" (keep my cached value) rather than "no information".
    const out = listRowIdentity({ id: "m3" });
    expect(out).toEqual({
      messageId: "m3",
      clientMessageId: null,
      seq: 0,
      revision: 0,
    });
    expect(JSON.parse(JSON.stringify(out))).toHaveProperty("clientMessageId");
  });
});

describe("tombstoneWireFields", () => {
  it("normalizes the private/group shape (isDeleted + deletedAt)", () => {
    const at = new Date(1_700_000_000_000);
    expect(tombstoneWireFields({ isDeleted: true, deletedAt: at })).toEqual({
      deletedForEveryone: true,
      deletedAt: 1_700_000_000_000,
    });
  });

  it("normalizes the community shape (deletedForAll + deletedForAllAt)", () => {
    const at = new Date(1_700_000_000_000);
    expect(
      tombstoneWireFields({ deletedForAll: true, deletedForAllAt: at })
    ).toEqual({ deletedForEveryone: true, deletedAt: 1_700_000_000_000 });
  });

  it("reports a live message as not-deleted with a null timestamp", () => {
    expect(tombstoneWireFields({ isDeleted: false })).toEqual({
      deletedForEveryone: false,
      deletedAt: null,
    });
  });
});

describe("buildDeletePayload — replay safety", () => {
  it("carries revision/clientMessageId/deletedAt on the PRIVATE shape", () => {
    const payload = buildDeletePayload({
      conversationType: "PRIVATE",
      messageId: "m1",
      roomId: "r1",
      scope: "forEveryone",
      deletedBy: "u1",
      sequenceNumber: 5,
      revision: 9,
      clientMessageId: "cmid-1",
      deletedAt: 1_700_000_000_000,
    });
    expect(payload).toMatchObject({
      // Pre-existing fields, unchanged.
      messageId: "m1",
      conversationId: "r1",
      type: "forEveryone",
      deletedBy: "u1",
      sequenceNumber: 5,
      // Additive tombstone metadata.
      revision: 9,
      clientMessageId: "cmid-1",
      deletedAt: 1_700_000_000_000,
      deletedForEveryone: true,
    });
  });

  it("carries the same metadata on the COMMUNITY shape", () => {
    expect(
      buildDeletePayload({
        conversationType: "COMMUNITY",
        messageId: "m1",
        roomId: "c1",
        scope: "forEveryone",
        deletedBy: "u1",
        revision: 3,
      })
    ).toMatchObject({
      messageId: "m1",
      communityId: "c1",
      roomId: "c1",
      deleteType: "forEveryone",
      revision: 3,
      deletedForEveryone: true,
    });
  });

  it("marks a delete-for-me as NOT deletedForEveryone", () => {
    expect(
      buildDeletePayload({
        conversationType: "GROUP",
        messageId: "m1",
        roomId: "r1",
        scope: "forMe",
        deletedBy: "u1",
      })
    ).toMatchObject({ deletedForEveryone: false });
  });

  it("defaults revision to 0 for a caller that has none in hand", () => {
    // 0 is the documented "unknown — apply it" value; it must never be absent.
    const payload = buildDeletePayload({
      conversationType: "PRIVATE",
      messageId: "m1",
      roomId: "r1",
      scope: "forEveryone",
      deletedBy: "u1",
    });
    expect(payload.revision).toBe(0);
    expect(payload.clientMessageId).toBeNull();
  });
});
