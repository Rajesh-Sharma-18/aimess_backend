/**
 * Suite: community-last-activity-identity
 *
 * The community list row used to carry a preview and a timestamp and nothing
 * else. An offline-first client merging that row against its local cache could
 * not tell the server's copy of its own optimistic message from a different
 * message sent in the same millisecond, and could not order two rows tying on
 * `lastActivityAt`.
 *
 * These pin the identity block `buildLastActivity` now emits â€” including on
 * SYSTEM rows, where `userId` is deliberately forced null (so the client never
 * prefixes the preview with a name) but `senderId` must still be populated,
 * because that is what the merge actually keys on.
 */

import {
  buildLastActivity,
  chatLastMessageToActivity,
  withLiveSenderName,
} from "../../src/services/community.service.js";

const CREATED_AT = new Date("2026-06-01T00:00:00.000Z");
const ACTIVITY_AT = new Date("2026-06-19T12:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: CREATED_AT,
    lastActivityAt: ACTIVITY_AT,
    lastActivityUsername: "Rajesh",
    lastActivityUserId: "actor-1",
    lastActivityMessageId: "msg-1",
    lastActivityClientMessageId: "cmid-1",
    lastActivitySeq: 42,
    lastActivityContentType: "TEXT",
    ...overrides,
  } as Parameters<typeof buildLastActivity>[0];
}

describe("buildLastActivity â€” message identity", () => {
  it("carries messageId/clientMessageId/seq/senderId/contentType on a USER message row", () => {
    expect(
      buildLastActivity(
        row({ lastActivityType: "message", lastActivityPreview: "hello" })
      )
    ).toMatchObject({
      type: "message",
      // Pre-existing fields, unchanged.
      userId: "actor-1",
      username: "Rajesh",
      preview: "hello",
      dateTime: ACTIVITY_AT.getTime(),
      // Additive identity block.
      messageId: "msg-1",
      clientMessageId: "cmid-1",
      seq: 42,
      senderId: "actor-1",
      contentType: "TEXT",
    });
  });

  it("keeps senderId on a SYSTEM row even though userId is forced null", () => {
    // `userId: null` is what stops the client rendering "<actor>: <system text>".
    // The merge still needs to know which message the row describes.
    const out = buildLastActivity(
      row({
        lastActivityType: "join",
        lastActivityPreview: "Someone joined",
        lastActivityContentType: "SYSTEM",
      })
    );
    expect(out.userId).toBeNull();
    expect(out.username).toBeNull();
    expect(out).toMatchObject({
      messageId: "msg-1",
      senderId: "actor-1",
      contentType: "SYSTEM",
      seq: 42,
    });
  });

  it("reports 'no information' (never undefined) for a pre-backfill row", () => {
    // A community that has not been bumped since the columns were added. The
    // client must read this as "I learned nothing", not "clear what I have".
    const out = buildLastActivity(
      row({
        lastActivityType: "message",
        lastActivityPreview: "hello",
        lastActivityMessageId: null,
        lastActivityClientMessageId: null,
        lastActivitySeq: null,
        lastActivityContentType: null,
      })
    );
    expect(out).toMatchObject({
      messageId: "",
      clientMessageId: null,
      seq: 0,
      contentType: "",
    });
    // Survives the wire: undefined would be dropped by JSON.stringify and read
    // by the client as "field absent" rather than "no information".
    const wire = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
    for (const key of ["messageId", "clientMessageId", "seq", "contentType"]) {
      expect(wire).toHaveProperty(key);
    }
  });

  it("emits an EMPTY identity for the senderless 'created' baseline", () => {
    // There is no message behind "Community created" â€” claiming one would let a
    // client believe a real message exists and never fetch it.
    expect(
      buildLastActivity(row({ lastActivityType: "created" }))
    ).toMatchObject({
      type: "created",
      messageId: "",
      clientMessageId: null,
      seq: 0,
      senderId: null,
      contentType: "",
    });
  });

  it("emits an EMPTY identity for a legacy ineligible activity type", () => {
    // Falls back to the "created" baseline â€” its identity must fall back too,
    // otherwise the row would point at a message the preview isn't describing.
    expect(
      buildLastActivity(row({ lastActivityType: "removal_legacy" }))
    ).toMatchObject({ messageId: "", seq: 0, senderId: null });
  });
});

describe("withLiveSenderName — renamed sender on the list preview", () => {
  const live = new Map([["actor-1", "Kohli Virat"]]);

  it("swaps the frozen column name for the live one", () => {
    const a = buildLastActivity(
      row({
        lastActivityType: "message",
        lastActivityPreview: "ok",
        lastActivityUsername: "Peter Parker",
      })
    );
    expect(withLiveSenderName(a, live).username).toBe("Kohli Virat");
  });

  it("swaps the name on chat-service's per-viewer last message too", () => {
    const a = chatLastMessageToActivity({
      username: "Peter Parker",
      message: "ok",
      dateTime: 1,
      userId: "actor-1",
    });
    expect(withLiveSenderName(a, live).username).toBe("Kohli Virat");
  });

  it("leaves sender-less lines and unknown senders alone", () => {
    const system = buildLastActivity(
      row({ lastActivityType: "system", lastActivityPreview: "X joined" })
    );
    expect(withLiveSenderName(system, live)).toBe(system);
    const other = buildLastActivity(
      row({
        lastActivityType: "message",
        lastActivityPreview: "hi",
        lastActivityUserId: "actor-2",
      })
    );
    expect(withLiveSenderName(other, live)).toBe(other);
  });
});
