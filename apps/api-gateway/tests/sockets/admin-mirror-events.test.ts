/**
 * What the /admin namespace mirrors into the read-only conversation viewer.
 *
 * Two properties are asserted here, both of them security- rather than
 * feature-shaped:
 *
 *  - The relay is an ALLOWLIST. Group events travel on the shared `conv:<id>`
 *    channel that private DMs also use, so anything not explicitly listed must
 *    stay off the panel even when the admin is in the room.
 *
 *  - A reaction broadcast carries every reactor inline. The viewer renders
 *    counts and pages the reactor list through its own endpoint, so the
 *    identities and avatar URLs must be stripped before the event leaves the
 *    gateway — a monitoring socket is not a firehose of who reacted to what.
 *
 * Drives the REAL `registerAdminNamespace`, because the behaviour under test is
 * what the relay does with a payload, which a re-implementation cannot capture.
 */
import { registerAdminNamespace } from "../../src/sockets/namespaces/admin.ns.js";

jest.mock("../../src/sockets/auth.middleware.js", () => ({
  createGatewayAdminSocketAuthMiddleware: () => () => undefined,
}));

const GROUP_ID = `grp_${"a".repeat(16)}`;
const COMMUNITY_ID = "c".repeat(24);

/** Build the namespace with `watching` already joined as rooms. */
function harness(watching: string[]) {
  const localEmit = jest.fn();
  const ns = {
    use: jest.fn(),
    on: jest.fn(),
    adapter: { rooms: new Map(watching.map((room) => [room, new Set()])) },
    local: { to: jest.fn(() => ({ emit: localEmit })) },
    to: () => ({ emit: jest.fn() }),
    in: () => ({ fetchSockets: async () => [] }),
  };

  let pmessage: ((p: string, c: string, m: string) => void) | undefined;
  const redis = {
    get: jest.fn(async () => JSON.stringify(["groups.moderate"])),
    psubscribe: jest.fn(async () => undefined),
    on: jest.fn((event: string, fn: never) => {
      if (event === "pmessage") {
        pmessage = fn as unknown as (p: string, c: string, m: string) => void;
      }
    }),
  };

  registerAdminNamespace(
    { of: () => ns } as never,
    redis as never,
    redis as never
  );

  /** Publish one Redis event on `channel` and return what reached the panel. */
  const publish = (channel: string, event: string, data: unknown) => {
    localEmit.mockClear();
    pmessage!("*", channel, JSON.stringify({ event, data }));
    return localEmit.mock.calls;
  };

  return { publish, localEmit, ns };
}

describe("group conversation mirror", () => {
  it("relays the pin and reaction events the viewer needs", () => {
    const h = harness([`conv:${GROUP_ID}`]);

    expect(
      h.publish(`conv:${GROUP_ID}`, "pin:updated", {
        roomId: GROUP_ID,
        action: "pinned",
      })
    ).toHaveLength(1);
    expect(
      h.publish(`conv:${GROUP_ID}`, "message:reaction", {
        messageId: "m1",
        reactions: [],
      })
    ).toHaveLength(1);
  });

  it("still refuses an event that is not on the allowlist", () => {
    const h = harness([`conv:${GROUP_ID}`]);

    // Typing indicators and read receipts are participant traffic; a read-only
    // monitor has no business receiving them.
    expect(h.publish(`conv:${GROUP_ID}`, "message:read", { roomId: GROUP_ID }))
      .toHaveLength(0);
    expect(h.publish(`conv:${GROUP_ID}`, "typing", { roomId: GROUP_ID })).toHaveLength(
      0
    );
  });

  it("relays nothing at all for a room no admin is watching", () => {
    const h = harness([]);

    expect(
      h.publish(`conv:${GROUP_ID}`, "message:new", { roomId: GROUP_ID })
    ).toHaveLength(0);
  });

  it("strips the reactor list, keeping only emoji + count", () => {
    const h = harness([`conv:${GROUP_ID}`]);

    const calls = h.publish(`conv:${GROUP_ID}`, "message:reaction", {
      messageId: "m1",
      conversationId: GROUP_ID,
      reactions: [
        {
          emoji: "❤️",
          count: 2,
          users: [
            { userId: "u1", displayName: "Tom", avatarUrl: "https://x/1" },
            { userId: "u2", displayName: "Kristi", avatarUrl: "https://x/2" },
          ],
        },
        { emoji: "👍", count: 3, users: [{ userId: "u3" }] },
      ],
    });

    const [event, payload] = calls[0] as [string, Record<string, unknown>];
    expect(event).toBe("message:reaction");
    expect(payload.messageId).toBe("m1");
    expect(payload.reactions).toEqual([
      { emoji: "❤️", count: 2 },
      { emoji: "👍", count: 3 },
    ]);
    // Belt and braces: no reactor identity survives anywhere in the payload.
    expect(JSON.stringify(payload)).not.toContain("u1");
    expect(JSON.stringify(payload)).not.toContain("avatarUrl");
  });

  it("falls back to the inline list length when the count is missing", () => {
    const h = harness([`conv:${GROUP_ID}`]);

    const calls = h.publish(`conv:${GROUP_ID}`, "message:reaction", {
      messageId: "m1",
      reactions: [{ emoji: "😂", users: [{ userId: "u1" }, { userId: "u2" }] }],
    });

    const [, payload] = calls[0] as [string, Record<string, unknown>];
    expect(payload.reactions).toEqual([{ emoji: "😂", count: 2 }]);
  });

  it("leaves a non-reaction event's payload untouched", () => {
    const h = harness([`conv:${GROUP_ID}`]);

    const data = { roomId: GROUP_ID, messageId: "m1", action: "pinned", text: "hi" };
    const calls = h.publish(`conv:${GROUP_ID}`, "pin:updated", data);

    expect(calls[0][1]).toEqual(data);
  });
});

describe("community conversation mirror", () => {
  it("relays pin, unpin and reaction events", () => {
    const h = harness([`community:${COMMUNITY_ID}`]);

    for (const event of [
      "community:message:pinned",
      "community:message:unpinned",
      "community:message:reaction",
    ]) {
      expect(
        h.publish(`community:${COMMUNITY_ID}`, event, {
          communityId: COMMUNITY_ID,
        })
      ).toHaveLength(1);
    }
  });

  it("strips the reactor list on the community event too", () => {
    const h = harness([`community:${COMMUNITY_ID}`]);

    const calls = h.publish(
      `community:${COMMUNITY_ID}`,
      "community:message:reaction",
      {
        messageId: "m1",
        communityId: COMMUNITY_ID,
        reactions: [
          { emoji: "🔥", count: 1, users: [{ userId: "u9", avatarUrl: "https://x/9" }] },
        ],
      }
    );

    const [, payload] = calls[0] as [string, Record<string, unknown>];
    expect(payload.reactions).toEqual([{ emoji: "🔥", count: 1 }]);
    expect(JSON.stringify(payload)).not.toContain("u9");
  });
});
