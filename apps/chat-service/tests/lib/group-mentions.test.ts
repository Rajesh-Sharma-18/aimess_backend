/**
 * Unit coverage for the server-authoritative group @mention resolver
 * (src/lib/group-mentions.ts). Deps are plain jest.fn()s: one roster query and
 * one batched snapshot lookup are the only I/O the resolver may perform.
 */
import {
  MAX_MENTIONS_PER_MESSAGE,
  mentionedUserIdsOf,
  resolveGroupMentions,
} from "../../src/lib/group-mentions.js";

const SNAPSHOTS: Record<string, { memberId: string; isDeletedUser?: boolean }> =
  {
    u_kristi: { memberId: "kristi" },
    u_bob: { memberId: "bob" },
    u_smiley: { memberId: "Smiley_Creatures" },
    u_gone: { memberId: "gone", isDeletedUser: true },
    u_left: { memberId: "lefty" },
    u_nohandle: { memberId: "" },
  };
const ACTIVE = ["u_kristi", "u_bob", "u_smiley", "u_gone", "u_nohandle"];

function makeDeps() {
  return {
    memberRepo: {
      findActiveUserIds: jest.fn(async (_roomId: string, ids: string[]) =>
        ids.filter((id) => ACTIVE.includes(id))
      ),
    },
    userSnapshotService: {
      getUserSnapshotsMap: jest.fn(
        async (ids: string[]) =>
          new Map<string, Record<string, unknown>>(
            ids
              .filter((id) => SNAPSHOTS[id])
              .map((id) => [
                id,
                { userId: id, isDeletedUser: false, ...SNAPSHOTS[id] },
              ])
          )
      ),
    },
    cacheRepo: {} as never,
  };
}

let deps: ReturnType<typeof makeDeps>;
beforeEach(() => {
  deps = makeDeps();
});

const entity = (userId: string, text: string, token: string, from = 0) => ({
  userId,
  username: "client-claim",
  offset: text.indexOf(token, from),
  length: token.length,
});

const resolve = (text: string, raw: unknown) =>
  resolveGroupMentions({ raw, text, roomId: "grp_1", ...deps });

describe("resolveGroupMentions — valid mentions", () => {
  it("single mention, username overwritten by the server handle", async () => {
    const text = "Hello @kristi";
    expect(await resolve(text, [entity("u_kristi", text, "@kristi")])).toEqual([
      { userId: "u_kristi", username: "kristi", offset: 6, length: 7 },
    ]);
  });

  it("beginning, middle and end; output sorted by offset", async () => {
    const text = "@kristi hi @bob and @Smiley_Creatures";
    const out = await resolve(text, [
      entity("u_smiley", text, "@Smiley_Creatures"),
      entity("u_kristi", text, "@kristi"),
      entity("u_bob", text, "@bob"),
    ]);
    expect(out.map((m) => [m.userId, m.offset])).toEqual([
      ["u_kristi", 0],
      ["u_bob", 11],
      ["u_smiley", 20],
    ]);
  });

  it("same user twice keeps both entities; recipients dedupe", async () => {
    const text = "@kristi hi @kristi";
    const out = await resolve(text, [
      entity("u_kristi", text, "@kristi"),
      entity("u_kristi", text, "@kristi", 1),
    ]);
    expect(out.map((m) => m.offset)).toEqual([0, 11]);
    expect(mentionedUserIdsOf([{ text, mentions: out }], "sender")).toEqual([
      "u_kristi",
    ]);
    // One roster query + one snapshot batch, with the id deduped.
    expect(deps.memberRepo.findActiveUserIds).toHaveBeenCalledTimes(1);
    expect(deps.memberRepo.findActiveUserIds).toHaveBeenCalledWith("grp_1", [
      "u_kristi",
    ]);
    expect(deps.userSnapshotService.getUserSnapshotsMap).toHaveBeenCalledTimes(
      1
    );
  });

  it("emoji before the mention: offsets are UTF-16 code units", async () => {
    const text = "Hello 👋 @kristi";
    const out = await resolve(text, [entity("u_kristi", text, "@kristi")]);
    expect(out).toEqual([
      { userId: "u_kristi", username: "kristi", offset: 9, length: 7 },
    ]);
  });

  it.each(["สวัสดี @kristi", "Xin chào @kristi"])(
    "unicode text with a space boundary is accepted: %s",
    async (text) => {
      expect(
        await resolve(text, [entity("u_kristi", text, "@kristi")])
      ).toHaveLength(1);
    }
  );

  it("handle match is case-insensitive", async () => {
    const text = "hey @KRISTI";
    expect(await resolve(text, [entity("u_kristi", text, "@KRISTI")])).toEqual([
      { userId: "u_kristi", username: "kristi", offset: 4, length: 7 },
    ]);
  });

  it("exactly MAX_MENTIONS_PER_MESSAGE is accepted", async () => {
    const text = "@kristi ".repeat(MAX_MENTIONS_PER_MESSAGE);
    const raw = Array.from({ length: MAX_MENTIONS_PER_MESSAGE }, (_, i) => ({
      userId: "u_kristi",
      offset: i * 8,
      length: 7,
    }));
    expect(await resolve(text, raw)).toHaveLength(MAX_MENTIONS_PER_MESSAGE);
  });
});

describe("resolveGroupMentions — dropped entries", () => {
  it("Thai text glued to @ (no boundary) is not a mention", async () => {
    const text = "สวัสดี@kristi";
    expect(await resolve(text, [entity("u_kristi", text, "@kristi")])).toEqual(
      []
    );
  });

  it("email-like a@kristi is not a mention", async () => {
    const text = "mail a@kristi now";
    expect(await resolve(text, [entity("u_kristi", text, "@kristi")])).toEqual(
      []
    );
  });

  it("@kristi_new is neither a prefix match nor kristi's handle", async () => {
    const text = "hi @kristi_new";
    expect(
      await resolve(text, [
        { userId: "u_kristi", offset: 3, length: 7 },
        entity("u_kristi", text, "@kristi_new"),
      ])
    ).toEqual([]);
  });

  it("token that does not match the user's handle is dropped", async () => {
    const text = "hi @kristi";
    expect(await resolve(text, [entity("u_bob", text, "@kristi")])).toEqual([]);
  });

  it("invalid offsets: negative, past end, not '@', fractional, too short", async () => {
    const text = "hi @kristi";
    expect(
      await resolve(text, [
        { userId: "u_kristi", offset: -1, length: 7 },
        { userId: "u_kristi", offset: 4, length: 7 },
        { userId: "u_kristi", offset: 2, length: 7 },
        { userId: "u_kristi", offset: 3.5, length: 7 },
        { userId: "u_kristi", offset: 3, length: 1 },
        { userId: "", offset: 3, length: 7 },
        null,
        "junk",
      ])
    ).toEqual([]);
    expect(deps.memberRepo.findActiveUserIds).not.toHaveBeenCalled();
  });

  it("overlapping entity is dropped, the first one is kept", async () => {
    const text = "hi @kristi";
    const out = await resolve(text, [
      entity("u_kristi", text, "@kristi"),
      { userId: "u_bob", offset: 3, length: 4 },
    ]);
    expect(out.map((m) => m.userId)).toEqual(["u_kristi"]);
  });

  it("non-active (left/kicked/banned) and unknown users are dropped", async () => {
    const text = "@lefty @ghost @kristi";
    const out = await resolve(text, [
      entity("u_left", text, "@lefty"),
      entity("u_ghost", text, "@ghost"),
      entity("u_kristi", text, "@kristi"),
    ]);
    expect(out.map((m) => m.userId)).toEqual(["u_kristi"]);
  });

  it("deleted account and empty handle are dropped", async () => {
    const text = "@gone @x";
    expect(
      await resolve(text, [
        entity("u_gone", text, "@gone"),
        entity("u_nohandle", text, "@x"),
      ])
    ).toEqual([]);
  });

  it("/@handle inside a URL is not a mention; a space boundary still is", async () => {
    for (const text of [
      "read https://medium.com/@kristi/my-post",
      "x.com/@kristi",
    ]) {
      expect(
        await resolve(text, [entity("u_kristi", text, "@kristi")])
      ).toEqual([]);
    }
    const text = "see / @kristi";
    expect(
      await resolve(text, [entity("u_kristi", text, "@kristi")])
    ).toHaveLength(1);
  });

  it("snapshot lookup failure fails closed to []", async () => {
    deps.userSnapshotService.getUserSnapshotsMap.mockRejectedValueOnce(
      new Error("redis down")
    );
    const text = "hi @kristi";
    expect(await resolve(text, [entity("u_kristi", text, "@kristi")])).toEqual(
      []
    );
  });

  it("non-array or empty input is [] without any lookup", async () => {
    expect(await resolve("hi", undefined)).toEqual([]);
    expect(await resolve("hi", { userId: "u_kristi" })).toEqual([]);
    expect(await resolve("hi", [])).toEqual([]);
    expect(deps.memberRepo.findActiveUserIds).not.toHaveBeenCalled();
  });
});

describe("resolveGroupMentions — previous (edit that omitted mentions)", () => {
  const withPrevious = (
    text: string,
    raw: unknown,
    previous: Array<{ userId: string; username: string }>
  ) =>
    resolveGroupMentions({
      raw,
      text,
      roomId: "grp_1",
      previous: previous.map((p) => ({ ...p, offset: 0, length: 0 })),
      ...deps,
    });

  it("roster query failure keeps entries matching previous, with the previous username", async () => {
    deps.memberRepo.findActiveUserIds.mockRejectedValueOnce(
      new Error("pool exhausted")
    );
    const text = "hi @Kristi and @bob";
    expect(
      await withPrevious(
        text,
        [entity("u_kristi", text, "@Kristi"), entity("u_bob", text, "@bob")],
        [
          { userId: "u_kristi", username: "kristi" },
          { userId: "u_bob", username: "robert" },
        ]
      )
    ).toEqual([
      { userId: "u_kristi", username: "kristi", offset: 3, length: 7 },
    ]);
  });

  it("snapshot lookup failure keeps entries matching previous", async () => {
    deps.userSnapshotService.getUserSnapshotsMap.mockRejectedValueOnce(
      new Error("redis down")
    );
    const text = "hi @kristi";
    expect(
      await withPrevious(
        text,
        [entity("u_kristi", text, "@kristi")],
        [{ userId: "u_kristi", username: "kristi" }]
      )
    ).toHaveLength(1);
  });

  it("placeholder memberId '' or a missing snapshot keeps a matching previous entry", async () => {
    deps.userSnapshotService.getUserSnapshotsMap.mockResolvedValueOnce(
      new Map([["u_kristi", { userId: "u_kristi", memberId: "" }]])
    );
    const text = "@kristi @bob";
    expect(
      await withPrevious(
        text,
        [entity("u_kristi", text, "@kristi"), entity("u_bob", text, "@bob")],
        [
          { userId: "u_kristi", username: "kristi" },
          { userId: "u_bob", username: "bob" },
        ]
      )
    ).toEqual([
      { userId: "u_kristi", username: "kristi", offset: 0, length: 7 },
      { userId: "u_bob", username: "bob", offset: 8, length: 4 },
    ]);
  });

  it("known inactive, deleted and known handle mismatch still drop", async () => {
    const text = "@lefty @gone @kristi";
    expect(
      await withPrevious(
        text,
        [
          entity("u_left", text, "@lefty"),
          entity("u_gone", text, "@gone"),
          entity("u_bob", text, "@kristi"),
        ],
        [
          { userId: "u_left", username: "lefty" },
          { userId: "u_gone", username: "gone" },
          { userId: "u_bob", username: "kristi" },
        ]
      )
    ).toEqual([]);
  });
});

describe("resolveGroupMentions — limit", () => {
  it("more than MAX_MENTIONS_PER_MESSAGE throws CHAT_MENTION_LIMIT_EXCEEDED before any lookup", async () => {
    const raw = Array.from({ length: MAX_MENTIONS_PER_MESSAGE + 1 }, () => ({
      userId: "junk",
      offset: 0,
      length: 2,
    }));
    await expect(resolve("x", raw)).rejects.toMatchObject({
      statusCode: 400,
      messageKey: "CHAT_MENTION_LIMIT_EXCEEDED",
    });
    expect(deps.memberRepo.findActiveUserIds).not.toHaveBeenCalled();
  });
});

describe("mentionedUserIdsOf", () => {
  it("dedupes across contents, excludes the sender, ignores junk", () => {
    expect(
      mentionedUserIdsOf(
        [
          { mentions: [{ userId: "a" }, { userId: "sender" }] },
          { mentions: [{ userId: "a" }, { userId: "b" }, null, { userId: 1 }] },
          { text: "no mentions" },
          null,
          "junk",
        ],
        "sender"
      )
    ).toEqual(["a", "b"]);
  });
});
