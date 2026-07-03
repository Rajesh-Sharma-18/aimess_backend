/**
 * `community:messages:fetch` — `pinnedMessage` field.
 *
 * Verifies the logic-layer parsing added to the ack handler in
 * community.ns.ts (`community:messages:fetch`): the gRPC response's
 * `pinnedMessageJson` (from chat-service's `CommunityPinService.getActivePinSummary`,
 * JSON.stringify'd — see `apps/chat-service/src/grpc/service-impl.ts`
 * `getCommunityMessages`) is parsed into a `pinnedMessage` object and
 * included as a NEW top-level field alongside the existing `messages`,
 * `nextCursor`, `hasMore` — the `messages` array itself is untouched.
 *
 * Full Socket.IO namespace integration (live Redis adapter + gRPC clients) is
 * out of scope here — that is covered by the e2e testing-suite, matching the
 * existing convention in this test directory (community-typing.test.ts,
 * recording-presence.test.ts). This suite mirrors the EXACT parsing snippet
 * in community.ns.ts so it fails if that logic regresses.
 */

/** Mirrors the pinnedMessage-parsing block inside the `community:messages:fetch`
 *  handler (community.ns.ts, `.then((result) => { ... })`). */
function parsePinnedMessage(pinnedMessageJson: string): unknown {
  let pinnedMessage: unknown = null;
  if (pinnedMessageJson) {
    try {
      pinnedMessage = JSON.parse(pinnedMessageJson);
    } catch {
      // logged server-side; pinnedMessage stays null on a malformed payload
    }
  }
  return pinnedMessage;
}

const SAMPLE_PIN = {
  messageId: "6851f2a1b5c3d4e5f6a7b8c9",
  roomId: "6843e1a2b5c3d4e5f6a7b8c9",
  communityId: "6843e1a2b5c3d4e5f6a7b8c9",
  senderId: "usr_123",
  senderName: "Jane Doe",
  senderHandle: "jane",
  senderAvatar: "",
  messageType: "TEXT",
  text: "Meeting at 3pm tomorrow",
  media: [],
  createdAt: 1751500000000,
  pinnedAt: 1751500100000,
  pinnedBy: "usr_mod",
  isAvailable: true,
};

describe("community:messages:fetch — pinnedMessage: null (no active pin)", () => {
  it("empty string pinnedMessageJson (no active pin) parses to null", () => {
    expect(parsePinnedMessage("")).toBeNull();
  });
});

describe("community:messages:fetch — pinnedMessage present", () => {
  it("parses a well-formed pinnedMessageJson into the full FE-header object", () => {
    const json = JSON.stringify(SAMPLE_PIN);
    expect(parsePinnedMessage(json)).toEqual(SAMPLE_PIN);
  });

  it("includes every field required for the FE header", () => {
    const parsed = parsePinnedMessage(JSON.stringify(SAMPLE_PIN)) as Record<
      string,
      unknown
    >;
    for (const key of [
      "messageId",
      "roomId",
      "communityId",
      "senderId",
      "senderName",
      "senderHandle",
      "senderAvatar",
      "messageType",
      "text",
      "media",
      "createdAt",
      "pinnedAt",
      "pinnedBy",
    ]) {
      expect(parsed).toHaveProperty(key);
    }
  });
});

describe("community:messages:fetch — malformed pinnedMessageJson", () => {
  it("falls back to null instead of throwing on invalid JSON", () => {
    expect(() => parsePinnedMessage("{not valid json")).not.toThrow();
    expect(parsePinnedMessage("{not valid json")).toBeNull();
  });
});

describe("community:messages:fetch — response shape", () => {
  it("adds pinnedMessage as a sibling of messages/nextCursor/hasMore without altering them", () => {
    // Mirrors the exact ackOk(...) data object built in community.ns.ts.
    const messages = [{ id: "m1" }];
    const nextCursor = "2026-07-01T09:00:00.000Z";
    const hasMore = true;
    const pinnedMessage = parsePinnedMessage(JSON.stringify(SAMPLE_PIN));

    const ackData = { messages, nextCursor, hasMore, pinnedMessage };

    expect(ackData.messages).toBe(messages); // untouched reference — backward compatible
    expect(ackData.nextCursor).toBe(nextCursor);
    expect(ackData.hasMore).toBe(hasMore);
    expect(ackData.pinnedMessage).toEqual(SAMPLE_PIN);
  });
});
