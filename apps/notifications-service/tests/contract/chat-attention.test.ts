/**
 * The attention keys push delivery reads (`@aimess/redis` chat-attention).
 *
 * "Actively viewing this conversation" is the ONLY thing that may silence a
 * device. It is not "online", not "connected to the socket", not "joined the
 * room", and not "has the app open" — conflating those is what made one browser
 * tab anywhere in AIMess swallow a user's notifications on every device.
 *
 * Two properties carry that distinction and both are asserted here:
 *
 *  - the viewer set is keyed per SOCKET but reported per SESSION, because a
 *    browser login is one session shared by every tab (so tabs must not
 *    overwrite each other) while a push is delivered to a device (so the
 *    session is what delivery can exclude on);
 *  - every entry carries its OWN expiry, so a tab that crashed or a gateway
 *    that died cannot suppress for ever behind a TTL that other sockets keep
 *    refreshing.
 *
 * The jest moduleNameMapper resolves `@aimess/redis` to the package's TS source,
 * so this asserts the real helpers against a fake ioredis client.
 */
import {
  ATTENTION_TTL_SECONDS,
  chatRoomViewersKey,
  clearChatViewer,
  markChatViewer,
  sessionsViewingRoom,
} from "@aimess/redis";

const USER = "user-1";
const ROOM = "prv_room_1";

/** Minimal fake of the hash commands these helpers use. */
function fakeRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const expires = new Map<string, number>();
  const client = {
    hashes,
    expires,
    hgetall: jest.fn(async (key: string) =>
      Object.fromEntries(hashes.get(key) ?? new Map())
    ),
    hdel: jest.fn(async (key: string, field: string) => {
      hashes.get(key)?.delete(field);
      return 1;
    }),
    pipeline: () => {
      const ops: Array<() => void> = [];
      const pipeline = {
        hset: (key: string, field: string, value: string) => {
          ops.push(() => {
            const hash = hashes.get(key) ?? new Map<string, string>();
            hash.set(field, value);
            hashes.set(key, hash);
          });
          return pipeline;
        },
        expire: (key: string, seconds: number) => {
          ops.push(() => expires.set(key, seconds));
          return pipeline;
        },
        exec: async () => {
          ops.forEach((op) => op());
          return [];
        },
      };
      return pipeline;
    },
  };
  return client as unknown as Parameters<typeof markChatViewer>[0] &
    typeof client;
}

describe("chat attention — who is actively viewing a conversation", () => {
  it("reports the SESSION of a viewing socket, under the per-(user, room) key", async () => {
    const redis = fakeRedis();

    await markChatViewer(redis, USER, ROOM, "session-a", "socket-1");

    expect([...redis.hashes.keys()]).toEqual([chatRoomViewersKey(USER, ROOM)]);
    expect(await sessionsViewingRoom(redis, USER, ROOM)).toEqual(
      new Set(["session-a"])
    );
    // The key is re-stamped by every live socket, so a healthy view never lapses.
    expect(redis.expires.get(chatRoomViewersKey(USER, ROOM))).toBe(
      ATTENTION_TTL_SECONDS
    );
  });

  it("two tabs of ONE login: the tab that leaves does not speak for the tab still reading", async () => {
    const redis = fakeRedis();
    await markChatViewer(redis, USER, ROOM, "session-a", "socket-tab-1");
    await markChatViewer(redis, USER, ROOM, "session-a", "socket-tab-2");

    // Tab 2 navigates away / backgrounds. Tab 1 is still on the conversation.
    await clearChatViewer(redis, USER, ROOM, "socket-tab-2");

    expect(await sessionsViewingRoom(redis, USER, ROOM)).toEqual(
      new Set(["session-a"])
    );
  });

  it("a session stops viewing once its last socket goes", async () => {
    const redis = fakeRedis();
    await markChatViewer(redis, USER, ROOM, "session-a", "socket-tab-1");
    await markChatViewer(redis, USER, ROOM, "session-b", "socket-phone");

    await clearChatViewer(redis, USER, ROOM, "socket-tab-1");

    expect(await sessionsViewingRoom(redis, USER, ROOM)).toEqual(
      new Set(["session-b"])
    );
  });

  it("viewing one room says nothing about another", async () => {
    const redis = fakeRedis();
    await markChatViewer(redis, USER, "prv_other", "session-a", "socket-1");

    expect(await sessionsViewingRoom(redis, USER, ROOM)).toEqual(new Set());
  });

  it("an entry whose own stamp has lapsed is ignored, however fresh the key's TTL", async () => {
    const redis = fakeRedis();
    // A gateway died holding this field; another socket keeps re-stamping the
    // key's TTL, so only the per-field expiry can retire it.
    redis.hashes.set(
      chatRoomViewersKey(USER, ROOM),
      new Map([["dead-socket", `session-ghost|${String(Date.now() - 1)}`]])
    );

    expect(await sessionsViewingRoom(redis, USER, ROOM)).toEqual(new Set());
  });

  it("a malformed entry is ignored rather than read as a session id", async () => {
    const redis = fakeRedis();
    redis.hashes.set(
      chatRoomViewersKey(USER, ROOM),
      new Map([
        ["a", "no-separator"],
        ["b", "|123"],
        ["c", `session-ok|${String(Date.now() + 60_000)}`],
      ])
    );

    expect(await sessionsViewingRoom(redis, USER, ROOM)).toEqual(
      new Set(["session-ok"])
    );
  });

  it("fails OPEN when Redis is unreachable — a push nobody needed beats one nobody got", async () => {
    const redis = {
      hgetall: jest.fn(async () => {
        throw new Error("redis down");
      }),
    } as unknown as Parameters<typeof sessionsViewingRoom>[0];

    expect(await sessionsViewingRoom(redis, USER, ROOM)).toEqual(new Set());
  });
});
