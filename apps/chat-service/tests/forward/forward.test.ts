/**
 * Unified forward — POST /api/chat/forward (ForwardService → orchestrator send path).
 * Real routes/validators/services; mock repos via the app-factory harness.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import {
  bearer,
  makeAccessToken,
  TEST_PEER_ID,
  TEST_USER_ID,
} from "../helpers/auth.js";
import {
  createMessagingImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const URL = "/api/chat/forward";
const PRV_SRC = "prv_src";
const GRP_SRC = "grp_src";
const COM_SRC = "c".repeat(24);
const PRV_TGT = "prv_tgt";
const GRP_TGT = "grp_tgt";
const COM_TGT = "d".repeat(24);
const OLD = new Date("2026-01-01T00:00:00Z");

let seq = 0;
const oid = () => (++seq).toString(16).padStart(24, "a");
const cmid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

type Kind = "PRIVATE" | "GROUP" | "COMMUNITY";
const SRC_ROOM: Record<Kind, string> = {
  PRIVATE: PRV_SRC,
  GROUP: GRP_SRC,
  COMMUNITY: COM_SRC,
};
const TGT_ROOM: Record<Kind, string> = {
  PRIVATE: PRV_TGT,
  GROUP: GRP_TGT,
  COMMUNITY: COM_TGT,
};

interface Content {
  text?: string;
  files?: Array<Record<string, unknown>>;
  location?: Record<string, unknown>;
  contact?: Record<string, unknown>;
  sticker?: Record<string, unknown>;
}

/** Seed a readable source row of `kind` and return its id. */
function seedSource(
  kind: Kind,
  messageType = "TEXT",
  content: Content = { text: "hello" },
  extra: Record<string, unknown> = {}
): string {
  const id = oid();
  const base = { id, roomId: SRC_ROOM[kind], messageType, createdAt: OLD };
  if (kind === "COMMUNITY") {
    const attachments = [
      ...(content.files ?? []),
      ...(["location", "contact", "sticker"] as const)
        .filter((k) => content[k])
        .map((k) => ({ type: k, ...content[k] })),
    ];
    rows.COMMUNITY.set(id, {
      ...base,
      sentBy: TEST_PEER_ID,
      senderName: "Peer Name",
      message: content.text ?? "",
      attachments,
      deletedForAll: false,
      deletedBy: [],
      ...extra,
    });
  } else {
    rows[kind].set(id, {
      ...base,
      senderId: TEST_PEER_ID,
      ...(kind === "GROUP" ? { senderName: "Peer Name" } : {}),
      content: { text: "", urls: [], files: [], ...content },
      isDeleted: false,
      ...extra,
    });
  }
  return id;
}

const rows: Record<Kind, Map<string, Record<string, unknown>>> = {
  PRIVATE: new Map(),
  GROUP: new Map(),
  COMMUNITY: new Map(),
};
const created: Record<Kind, Array<Record<string, unknown>>> = {
  PRIVATE: [],
  GROUP: [],
  COMMUNITY: [],
};

function arm(): void {
  for (const k of ["PRIVATE", "GROUP", "COMMUNITY"] as Kind[]) {
    rows[k].clear();
    created[k] = [];
  }
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.privateMessageRepo.findById.mockImplementation(
    async (id: string) => rows.PRIVATE.get(id) ?? null
  );
  mocks.groupMessageRepo.findById.mockImplementation(
    async (id: string) => rows.GROUP.get(id) ?? null
  );
  mocks.generalRoomMessageRepo.findById.mockImplementation(
    async (id: string) => rows.COMMUNITY.get(id) ?? null
  );
  mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
    userId: TEST_USER_ID,
    role: "MEMBER",
    status: "ACTIVE",
    joinedAt: new Date("2025-01-01T00:00:00Z"),
  });
  mocks.groupRoomRepo.allocateSequence.mockImplementation(async () => ++seq);
  mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
    userId: TEST_USER_ID,
    status: "active",
    role: "member",
  });
  mocks.generalRoomRepo.allocateSequenceAndRevision.mockImplementation(
    async () => ({ sequenceNumber: ++seq, revision: seq })
  );
  const insert = (kind: Kind) => async (entity: Record<string, unknown>) => {
    const row = { id: oid(), createdAt: new Date(), ...entity };
    created[kind].push(row);
    return row;
  };
  mocks.privateMessageRepo.createMessage.mockImplementation(insert("PRIVATE"));
  mocks.groupMessageRepo.create.mockImplementation(insert("GROUP"));
  mocks.generalRoomMessageRepo.save.mockImplementation(insert("COMMUNITY"));
}

function forward(body: unknown) {
  return request(app).post(URL).set(bearer(makeAccessToken())).send(body);
}

function body(
  sources: Array<{ id: string; kind: Kind }>,
  targets: Kind[],
  base = 0
) {
  return {
    sources: sources.map((s) => ({
      messageId: s.id,
      conversationType: s.kind,
    })),
    targets: targets.map((t, ti) => ({
      conversationType: t,
      roomId: TGT_ROOM[t],
      clientMessageIds: sources.map((_, si) => cmid(base + ti * 100 + si)),
    })),
  };
}

const newEvents = () =>
  (mocks.redis.publish.mock.calls as unknown[][])
    .filter(
      (c) =>
        typeof c[1] === "string" &&
        /"event":"(community:)?message:new"/.test(c[1] as string) &&
        /^(conv|community):/.test(c[0] as string)
    )
    .map((c) => ({ channel: c[0] as string, ...JSON.parse(c[1] as string) }));

const allCreated = () => [
  ...created.PRIVATE,
  ...created.GROUP,
  ...created.COMMUNITY,
];

beforeEach(() => {
  ({ app, mocks } = buildApp());
  arm();
});

describe("POST /forward — content types", () => {
  const cases: Array<[string, string, Content]> = [
    ["text", "TEXT", { text: "hello" }],
    [
      "image",
      "IMAGE",
      { files: [{ objectKey: "chat/u/img.jpg", mimeType: "image/jpeg" }] },
    ],
    [
      "video",
      "VIDEO",
      {
        files: [
          {
            objectKey: "chat/u/v.mp4",
            thumbnailObjectKey: "chat/u/v.jpg",
            mimeType: "video/mp4",
          },
        ],
      },
    ],
    [
      "document",
      "DOCUMENT",
      { files: [{ objectKey: "chat/u/a.pdf", mimeType: "application/pdf" }] },
    ],
    [
      "audio",
      "AUDIO",
      { files: [{ objectKey: "chat/u/a.m4a", mimeType: "audio/mp4" }] },
    ],
    ["sticker", "STICKER", { sticker: { objectKey: "chat/u/s.webp" } }],
    ["location", "LOCATION", { location: { latitude: 1, longitude: 2 } }],
  ];

  it.each(cases)(
    "forwards %s and copies content",
    async (_n, type, content) => {
      const id = seedSource("PRIVATE", type, content);
      const res = await forward(body([{ id, kind: "PRIVATE" }], ["GROUP"]));
      expect(res.status).toBe(200);
      const [r] = res.body.data.results;
      expect(r).toMatchObject({ roomId: GRP_TGT, ok: true, error: null });
      expect(r.messages).toHaveLength(1);
      expect(r.messages[0].contentType).toBe(type);
      expect(r.messages[0].isForwarded).toBe(true);
      const row = created.GROUP[0]!;
      expect(row.isForwarded).toBe(true);
      const stored = row.content as Content;
      if (content.files)
        expect(stored.files?.[0]?.objectKey).toBe(content.files[0]!.objectKey);
      if (content.sticker) expect(stored.sticker).toEqual(content.sticker);
      if (content.location) expect(stored.location).toEqual(content.location);
      if (content.text) expect(stored.text).toBe(content.text);
    }
  );

  it("skips the uploader/room media check for a forward (source access was verified)", async () => {
    const { getMediaVerifyClient } = jest.requireMock(
      "../../src/grpc/media.client.js"
    );
    const id = seedSource("PRIVATE", "IMAGE", {
      files: [{ objectKey: "chat/peer/img.jpg" }],
    });
    const res = await forward(body([{ id, kind: "PRIVATE" }], ["PRIVATE"]));
    expect(res.body.data.results[0].ok).toBe(true);
    expect(getMediaVerifyClient().checkMediaStatus).not.toHaveBeenCalled();
  });
});

describe("POST /forward — every source × target kind", () => {
  const kinds: Kind[] = ["PRIVATE", "GROUP", "COMMUNITY"];
  const combos = kinds.flatMap((s) => kinds.map((t) => [s, t] as const));

  it.each(combos)("%s → %s", async (src, tgt) => {
    const id = seedSource(src, "IMAGE", {
      text: "cap",
      files: [{ objectKey: "chat/u/x.jpg" }],
    });
    const res = await forward(body([{ id, kind: src }], [tgt]));
    expect(res.status).toBe(200);
    const [r] = res.body.data.results;
    expect(r.ok).toBe(true);
    const wire = r.messages[0];
    expect(wire.isForwarded).toBe(true);
    expect(wire.forwardData).toMatchObject({
      originalMessageId: id,
      originalRoomId: SRC_ROOM[src],
      originalConversationType: src,
      originalSenderId: TEST_PEER_ID,
      originalCreatedAt: OLD.getTime(),
      originalContentType: "IMAGE",
    });
    const row = created[tgt][0]!;
    expect(row.forwardData).toEqual(wire.forwardData);
    const files =
      tgt === "COMMUNITY"
        ? (row.attachments as unknown[])
        : (row.content as Content).files;
    expect(files).toEqual([{ objectKey: "chat/u/x.jpg" }]);
    expect(newEvents()).toHaveLength(1);
    expect(newEvents()[0]!.channel).toBe(
      tgt === "COMMUNITY" ? `community:${COM_TGT}` : `conv:${TGT_ROOM[tgt]}`
    );
    // Media stays filed under its source room; the target gets a grant.
    expect(mocks.forwardedMediaGrantRepo.grant).toHaveBeenCalledWith(
      TGT_ROOM[tgt],
      {
        PRIVATE: "PRIVATE_CHAT",
        GROUP: "GROUP_CHAT",
        COMMUNITY: "COMMUNITY_CHAT",
      }[tgt],
      ["chat/u/x.jpg"]
    );
  });

  it("uses the row's sender name, else resolves it (private rows carry none)", async () => {
    mocks.cacheRepo.getUserSnapshots.mockResolvedValue(
      new Map([[TEST_PEER_ID, { displayName: "Resolved Peer" }]])
    );
    const p = seedSource("PRIVATE");
    const g = seedSource("GROUP");
    const res = await forward(
      body(
        [
          { id: p, kind: "PRIVATE" },
          { id: g, kind: "GROUP" },
        ],
        ["GROUP"]
      )
    );
    const [a, b] = res.body.data.results[0].messages;
    expect(a.forwardData.originalSenderName).toBe("Resolved Peer");
    expect(b.forwardData.originalSenderName).toBe("Peer Name");
  });
});

describe("POST /forward — ordering, fan-out, isolation", () => {
  it("keeps multi-source order within a target", async () => {
    const ids = [1, 2, 3].map((n) =>
      seedSource("GROUP", "TEXT", { text: `m${n}` })
    );
    const res = await forward(
      body(
        ids.map((id) => ({ id, kind: "GROUP" as Kind })),
        ["PRIVATE"]
      )
    );
    const msgs = res.body.data.results[0].messages;
    expect(msgs.map((m: any) => m.content.text)).toEqual(["m1", "m2", "m3"]);
    expect(msgs.map((m: any) => m.clientMessageId)).toEqual([
      cmid(0),
      cmid(1),
      cmid(2),
    ]);
    expect(created.PRIVATE.map((r) => (r.content as Content).text)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
  });

  it("fans one source out to several targets", async () => {
    const id = seedSource("COMMUNITY");
    const res = await forward(
      body([{ id, kind: "COMMUNITY" }], ["PRIVATE", "GROUP", "COMMUNITY"])
    );
    expect(res.body.data.results.map((r: any) => [r.roomId, r.ok])).toEqual([
      [PRV_TGT, true],
      [GRP_TGT, true],
      [COM_TGT, true],
    ]);
    expect(allCreated()).toHaveLength(3);
  });

  it("isolates a per-target failure; other targets still succeed", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockImplementation(
      async (roomId: string) =>
        roomId === GRP_TGT
          ? null
          : { userId: TEST_USER_ID, role: "MEMBER", status: "ACTIVE" }
    );
    const id = seedSource("PRIVATE");
    const res = await forward(
      body([{ id, kind: "PRIVATE" }], ["GROUP", "COMMUNITY"])
    );
    expect(res.status).toBe(200);
    const [g, c] = res.body.data.results;
    expect(g).toMatchObject({ ok: false, messages: [] });
    expect(g.error.code).toBe("CHAT_NOT_A_MEMBER");
    expect(typeof g.error.message).toBe("string");
    expect(c.ok).toBe(true);
    expect(created.GROUP).toHaveLength(0);
    expect(created.COMMUNITY).toHaveLength(1);
  });

  it("reports an inaccessible PRIVATE target per-target", async () => {
    mocks.privateRoomRepo.findByRoomId.mockImplementation(
      async (roomId: string) =>
        roomId === PRV_TGT
          ? { roomId, participants: ["x", "y"] }
          : { roomId, participants: [TEST_USER_ID, TEST_PEER_ID] }
    );
    const id = seedSource("PRIVATE");
    const res = await forward(body([{ id, kind: "PRIVATE" }], ["PRIVATE"]));
    expect(res.status).toBe(200);
    expect(res.body.data.results[0].ok).toBe(false);
    expect(created.PRIVATE).toHaveLength(0);
    expect(newEvents()).toHaveLength(0);
  });

  it("a duplicate request (same clientMessageIds) creates and broadcasts nothing new", async () => {
    const id = seedSource("GROUP");
    const req = body([{ id, kind: "GROUP" }], ["PRIVATE"]);
    const first = await forward(req);
    expect(first.body.data.results[0].ok).toBe(true);
    const row = created.PRIVATE[0]!;
    mocks.privateMessageRepo.findByClientMessageId.mockResolvedValue(row);
    mocks.redis.publish.mockClear();

    const second = await forward(req);
    expect(second.body.data.results[0].ok).toBe(true);
    expect(second.body.data.results[0].messages[0].id).toBe(row.id);
    expect(created.PRIVATE).toHaveLength(1);
    expect(newEvents()).toHaveLength(0);
  });
});

describe("POST /forward — source access (whole-request errors, nothing sent)", () => {
  const expectNothingSent = () => {
    expect(allCreated()).toHaveLength(0);
    expect(newEvents()).toHaveLength(0);
  };

  it("404 when the caller is not in the source private room", async () => {
    mocks.privateRoomRepo.findByRoomId.mockImplementation(
      async (roomId: string) =>
        roomId === PRV_SRC
          ? { roomId, participants: [TEST_PEER_ID, "other"] }
          : { roomId, participants: [TEST_USER_ID, TEST_PEER_ID] }
    );
    const id = seedSource("PRIVATE");
    const res = await forward(body([{ id, kind: "PRIVATE" }], ["GROUP"]));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("CHAT_MESSAGE_NOT_FOUND");
    expectNothingSent();
  });

  it("404 for another user's group message in a group the caller isn't in", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockImplementation(
      async (roomId: string) =>
        roomId === GRP_SRC
          ? null
          : { userId: TEST_USER_ID, role: "MEMBER", status: "ACTIVE" }
    );
    const id = seedSource("GROUP");
    const res = await forward(body([{ id, kind: "GROUP" }], ["GROUP"]));
    expect(res.status).toBe(404);
    expectNothingSent();
  });

  it("404 for a group message from before the caller joined", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      userId: TEST_USER_ID,
      role: "MEMBER",
      status: "ACTIVE",
      joinedAt: new Date("2026-06-01T00:00:00Z"),
    });
    const id = seedSource("GROUP");
    const res = await forward(body([{ id, kind: "GROUP" }], ["PRIVATE"]));
    expect(res.status).toBe(404);
    expectNothingSent();
  });

  it("404 for a private message hidden by the caller's delete-for-me", async () => {
    const id = seedSource(
      "PRIVATE",
      "TEXT",
      { text: "x" },
      {
        deletedFor: { [TEST_USER_ID]: new Date().toISOString() },
      }
    );
    const res = await forward(body([{ id, kind: "PRIVATE" }], ["PRIVATE"]));
    expect(res.status).toBe(404);
    expectNothingSent();
  });

  it("404 for a private community the caller is not a member of", async () => {
    const { getCommunityReconcileClient } = jest.requireMock(
      "../../src/grpc/community.client.js"
    );
    getCommunityReconcileClient.mockReturnValueOnce({
      checkCommunityMembership: jest.fn(async () => ({ isMember: false })),
    });
    mocks.roomMemberRepo.findByRoomAndUser.mockImplementation(
      async (roomId: string) =>
        roomId === COM_SRC ? null : { status: "active", role: "member" }
    );
    const id = seedSource("COMMUNITY");
    const res = await forward(body([{ id, kind: "COMMUNITY" }], ["GROUP"]));
    expect(res.status).toBe(404);
    expectNothingSent();
  });

  it("404 when the declared conversationType does not match the message", async () => {
    const id = seedSource("GROUP");
    const res = await forward(body([{ id, kind: "PRIVATE" }], ["PRIVATE"]));
    expect(res.status).toBe(404);
    expectNothingSent();
  });

  it("404 for a non-existent message", async () => {
    const res = await forward(
      body([{ id: "f".repeat(24), kind: "PRIVATE" }], ["PRIVATE"])
    );
    expect(res.status).toBe(404);
    expectNothingSent();
  });

  it("400 CHAT_MESSAGE_ALREADY_DELETED for a deleted-for-everyone source", async () => {
    const id = seedSource("GROUP", "TEXT", { text: "x" }, { isDeleted: true });
    const res = await forward(body([{ id, kind: "GROUP" }], ["PRIVATE"]));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CHAT_MESSAGE_ALREADY_DELETED");
    expectNothingSent();
  });

  it("one bad source fails the whole request even when others are fine", async () => {
    const ok = seedSource("PRIVATE");
    const gone = seedSource(
      "COMMUNITY",
      "TEXT",
      { text: "x" },
      {
        deletedForAll: true,
      }
    );
    const res = await forward(
      body(
        [
          { id: ok, kind: "PRIVATE" },
          { id: gone, kind: "COMMUNITY" },
        ],
        ["GROUP", "PRIVATE"]
      )
    );
    expect(res.status).toBe(400);
    expectNothingSent();
  });

  it.each([
    ["SYSTEM", {}],
    ["VOICE_CALL", {}],
    ["VIDEO_CALL", {}],
    ["GROUP_INVITE", {}],
    ["TEXT", { autoDeleteAfterView: true }],
  ])("400 CHAT_FORWARD_NOT_ALLOWED for %s %j", async (type, extra) => {
    const id = seedSource("PRIVATE", type, { text: "x" }, extra);
    const res = await forward(body([{ id, kind: "PRIVATE" }], ["GROUP"]));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CHAT_FORWARD_NOT_ALLOWED");
    expectNothingSent();
  });

  it("400 CHAT_FORWARD_NOT_ALLOWED for a community system line", async () => {
    const id = seedSource(
      "COMMUNITY",
      "SYSTEM",
      { text: "x" },
      {
        systemMessageType: "MEMBER_JOINED",
      }
    );
    const res = await forward(body([{ id, kind: "COMMUNITY" }], ["GROUP"]));
    expect(res.body.error.code).toBe("CHAT_FORWARD_NOT_ALLOWED");
    expectNothingSent();
  });
});

describe("POST /forward — forward of a forward", () => {
  it("keeps the FIRST origin", async () => {
    const origin = {
      originalMessageId: "e".repeat(24),
      originalRoomId: "grp_first",
      originalConversationType: "GROUP",
      originalSenderId: "first-user",
      originalSenderName: "First Sender",
      originalCreatedAt: 1234,
      originalContentType: "TEXT",
    };
    const id = seedSource(
      "PRIVATE",
      "TEXT",
      { text: "x" },
      {
        isForwarded: true,
        forwardData: origin,
      }
    );
    const res = await forward(body([{ id, kind: "PRIVATE" }], ["COMMUNITY"]));
    expect(res.body.data.results[0].messages[0].forwardData).toEqual(origin);
    expect(created.COMMUNITY[0]!.forwardData).toEqual(origin);
  });

  it("normalizes a legacy per-kind forwardData (ISO time, no name)", async () => {
    mocks.cacheRepo.getUserSnapshots.mockResolvedValue(
      new Map([["legacy-user", { displayName: "Legacy" }]])
    );
    const id = seedSource(
      "GROUP",
      "TEXT",
      { text: "x" },
      {
        isForwarded: true,
        forwardData: {
          originalMessageId: "e".repeat(24),
          originalRoomId: "grp_first",
          originalSenderId: "legacy-user",
          originalCreatedAt: "2026-01-02T00:00:00.000Z",
          originalContentType: "text",
        },
      }
    );
    const res = await forward(body([{ id, kind: "GROUP" }], ["GROUP"]));
    expect(res.body.data.results[0].messages[0].forwardData).toEqual({
      originalMessageId: "e".repeat(24),
      originalRoomId: "grp_first",
      originalConversationType: "GROUP",
      originalSenderId: "legacy-user",
      originalSenderName: "Legacy",
      originalCreatedAt: Date.parse("2026-01-02T00:00:00.000Z"),
      originalContentType: "TEXT",
    });
  });
});

describe("POST /forward — validation", () => {
  const id = "a".repeat(24);
  const good = () => body([{ id, kind: "PRIVATE" }], ["PRIVATE"]);

  it.each([
    ["no sources", { ...good(), sources: [] }],
    [
      "51 sources",
      body(
        Array.from({ length: 51 }, (_, i) => ({
          id: i.toString(16).padStart(24, "0"),
          kind: "PRIVATE" as Kind,
        })),
        ["PRIVATE"]
      ),
    ],
    ["no targets", { ...good(), targets: [] }],
    [
      "21 targets",
      {
        ...good(),
        targets: Array.from({ length: 21 }, (_, i) => ({
          conversationType: "GROUP",
          roomId: `grp_${i}`,
          clientMessageIds: [cmid(i)],
        })),
      },
    ],
    [
      "duplicate sources",
      body(
        [
          { id, kind: "PRIVATE" },
          { id, kind: "PRIVATE" },
        ],
        ["PRIVATE"]
      ),
    ],
    [
      "duplicate target rooms",
      {
        ...good(),
        targets: [good().targets[0], good().targets[0]],
      },
    ],
    [
      "clientMessageIds length mismatch",
      {
        ...good(),
        targets: [
          { ...good().targets[0], clientMessageIds: [cmid(1), cmid(2)] },
        ],
      },
    ],
    [
      "non-uuid clientMessageId",
      {
        ...good(),
        targets: [{ ...good().targets[0], clientMessageIds: ["x"] }],
      },
    ],
    [
      "bad conversationType",
      {
        ...good(),
        sources: [{ messageId: id, conversationType: "CHANNEL" }],
      },
    ],
    [
      "malformed messageId",
      body([{ id: "tmp-1", kind: "PRIVATE" }], ["PRIVATE"]),
    ],
  ])("400 VALIDATION_FAILED: %s", async (_n, payload) => {
    const res = await forward(payload);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    expect(mocks.privateMessageRepo.findById).not.toHaveBeenCalled();
  });

  it("401 without a token", async () => {
    const res = await request(app).post(URL).send(good());
    expect(res.status).toBe(401);
  });
});

describe("checkMediaAccess — forwarded media grants", () => {
  type Handler = (
    call: { request: unknown },
    cb: (err: unknown, res?: unknown) => void
  ) => void;
  const invoke = (h: Handler, req: unknown) =>
    new Promise<any>((resolve) => h({ request: req }, (_e, r) => resolve(r)));

  function deps(grants: Array<{ roomId: string; scope: string }>) {
    return {
      // Registry scope = the source group; the target user is not in it.
      groupMemberRepo: {
        findByRoomAndUser: jest.fn(async (roomId: string, userId: string) =>
          roomId === GRP_TGT && userId === "target-member"
            ? { status: "ACTIVE" }
            : null
        ),
      },
      forwardedMediaGrantRepo: {
        findByObjectKey: jest.fn(async () => grants),
      },
    } as unknown as GrpcDeps;
  }

  const req = (userId: string) => ({
    userId,
    scope: "GROUP_CHAT",
    resourceId: GRP_SRC,
    objectKey: "chat/u/x.jpg",
  });

  it("allows a target-room member through a grant", async () => {
    const { checkMediaAccess } = createMessagingImpl(
      deps([{ roomId: GRP_TGT, scope: "GROUP_CHAT" }])
    );
    expect(
      await invoke(checkMediaAccess as unknown as Handler, req("target-member"))
    ).toEqual({ allowed: true });
  });

  it("still denies an outsider", async () => {
    const { checkMediaAccess } = createMessagingImpl(
      deps([{ roomId: GRP_TGT, scope: "GROUP_CHAT" }])
    );
    expect(
      await invoke(checkMediaAccess as unknown as Handler, req("outsider"))
    ).toEqual({ allowed: false });
  });

  it("fails closed when the grant lookup throws", async () => {
    const d = deps([]) as unknown as Record<string, any>;
    d.forwardedMediaGrantRepo.findByObjectKey.mockRejectedValue(
      new Error("db down")
    );
    const { checkMediaAccess } = createMessagingImpl(d as GrpcDeps);
    expect(
      await invoke(checkMediaAccess as unknown as Handler, req("target-member"))
    ).toEqual({ allowed: false });
  });
});
