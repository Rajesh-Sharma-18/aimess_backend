// GET /api/v1/search — the unified fan-out. Guards the contract the clients rely
// on: `filter` decides which legs run, every category row is passed through
// verbatim from the service that owns it, the page carries the `pagination` block
// infinite scroll stops on, cursors advance per leg and never restart, and a
// rejected or banned token is not laundered into an empty result set.
import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";
import type { MediaClient } from "../../src/grpc/clients/media.client.js";

const app = createApp(
  {} as unknown as MessagingClient,
  {} as unknown as MediaClient
);

const BASE = "/api/v1/search";
const AUTH = "Bearer test-token";

const json = (data: unknown) =>
  ({ ok: true, json: async () => ({ data }) }) as unknown as Response;
const failure = (status: number, code?: string) =>
  ({
    ok: false,
    status,
    json: async () => (code ? { code } : {}),
  }) as unknown as Response;

const MESSAGE_CURSOR = "1782133107521_507f1f77bcf86cd799439011";
const COMMUNITY_CURSOR = "68b0f1c2a4d3e5f6a7b8c9d0";
const PEOPLE_CURSOR = "Sm9objBfdTE";
const GROUP_CURSOR = "Z3JwXzk";

const HITS = [
  {
    messageId: "m1",
    conversationType: "GROUP",
    roomId: "grp_1",
    conversationName: "Johnson Family",
    senderName: "Mary",
    text: "john is here",
  },
];

// community-service's ONLY list envelope — { pagination, data }, no `items`.
const communityEnvelope = (
  rows: { id: string; name?: string }[],
  nextCursor: string | null
) => ({
  pagination: {
    totalData: rows.length,
    totalPage: 1,
    currentPage: 1,
    limit: 5,
    nextCursor,
    hasMore: nextCursor !== null,
  },
  data: rows,
});

const peopleEnvelope = (nextCursor: string | null) => ({
  chat: [{ type: "USER", userId: "u1", username: "john" }],
  other: [{ type: "GROUP", roomId: "grp_9", name: "Johnson Fans" }],
  hasMore: nextCursor !== null,
  nextCursor,
});

// user-service's group leg — its OWN endpoint and envelope, keyed `groups`,
// not the `chat`/`other` buckets the people leg returns.
const groupEnvelope = (nextCursor: string | null) => ({
  groups: [
    { type: "GROUP", roomId: "grp_9", name: "Johnson Fans", isActiveMember: true },
  ],
  hasMore: nextCursor !== null,
  nextCursor,
});

type LegName = "users" | "groups" | "communities" | "messages";

const routeFetch = (per: Partial<Record<LegName, Response>>) =>
  jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // Checked FIRST: "/api/v1/users/search/groups" also contains "/users/search",
    // so testing the people leg first would swallow every group call.
    if (url.includes("/users/search/groups"))
      return per.groups ?? json(groupEnvelope(null));
    if (url.includes("/users/search"))
      return per.users ?? json(peopleEnvelope(null));
    if (url.includes("/communities/mine"))
      return per.communities ?? json(communityEnvelope([], null));
    return per.messages ?? json({ data: [], hasMore: false, nextCursor: null });
  });

const urlsOf = (spy: ReturnType<typeof routeFetch>) =>
  spy.mock.calls.map((call) => String(call[0]));

const paramOf = (url: string, key: string) =>
  new URL(url).searchParams.get(key);

describe("GET /api/v1/search", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("rejects an unauthenticated call before any fan-out", async () => {
    const spy = routeFetch({});
    global.fetch = spy as unknown as typeof fetch;
    const res = await request(app).get(`${BASE}?q=john`);
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an empty term rather than scanning every service", async () => {
    const spy = routeFetch({});
    global.fetch = spy as unknown as typeof fetch;
    const res = await request(app)
      .get(`${BASE}?q=%20`)
      .set("authorization", AUTH);
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("filter=message issues exactly one downstream call", async () => {
    const spy = routeFetch({
      messages: json({ data: HITS, hasMore: true, nextCursor: MESSAGE_CURSOR }),
    });
    global.fetch = spy as unknown as typeof fetch;

    const res = await request(app)
      .get(`${BASE}?q=john&filter=message`)
      .set("authorization", AUTH)
      .set("x-lang", "th");

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url] = urlsOf(spy);
    expect(url).toContain("/api/chat/messages/search");
    // The whole page belongs to the one leg a single filter names.
    expect(paramOf(url as string, "limit")).toBe("20");
    const headers = (
      spy.mock.calls[0]?.[1] as { headers: Record<string, string> }
    ).headers;
    expect(headers.authorization).toBe(AUTH);
    // Localized downstream strings came back in the default locale without this.
    expect(headers["x-lang"]).toBe("th");

    expect(res.body.data.data).toEqual([
      { type: "message", id: "m1", message: HITS[0] },
    ]);
    // The frontend's shared stop condition reads these two and nothing else.
    expect(res.body.data.pagination.nextCursor).toBe(MESSAGE_CURSOR);
    expect(res.body.data.pagination.hasMore).toBe(true);
    expect(res.body.data.pagination.totalData).toBe(1);
    expect(res.body.data.nextCursor).toBe(MESSAGE_CURSOR);
  });

  it("filter=community reads community-service's real {pagination,data} envelope", async () => {
    const spy = routeFetch({
      communities: json(
        communityEnvelope([{ id: "c1", name: "Johns Club" }], COMMUNITY_CURSOR)
      ),
    });
    global.fetch = spy as unknown as typeof fetch;

    const res = await request(app)
      .get(`${BASE}?q=john&filter=community`)
      .set("authorization", AUTH);

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.body.data.data).toEqual([
      {
        type: "community",
        id: "c1",
        community: { id: "c1", name: "Johns Club" },
      },
    ]);
    expect(res.body.data.nextCursor).toBe(COMMUNITY_CURSOR);
  });

  it("filter=people carries the user rows verbatim and drops the groups", async () => {
    const spy = routeFetch({ users: json(peopleEnvelope(PEOPLE_CURSOR)) });
    global.fetch = spy as unknown as typeof fetch;

    const res = await request(app)
      .get(`${BASE}?q=john&filter=people`)
      .set("authorization", AUTH);

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    // The People tab is people. A GROUP row stamped `type: "person"` is a row no
    // client can render as either kind.
    expect(res.body.data.data).toEqual([
      {
        type: "person",
        id: "u1",
        bucket: "chat",
        person: { type: "USER", userId: "u1", username: "john" },
      },
    ]);
    expect(res.body.data.nextCursor).toBe(PEOPLE_CURSOR);
  });

  it("filter=group calls the group leg and pages it, not the people leg", async () => {
    const spy = routeFetch({ groups: json(groupEnvelope(GROUP_CURSOR)) });
    global.fetch = spy as unknown as typeof fetch;

    const res = await request(app)
      .get(`${BASE}?q=john&filter=group`)
      .set("authorization", AUTH);

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    // Its OWN endpoint. Groups reaching search as a side effect of the people
    // leg is what surfaced memberships the caller no longer holds.
    expect(urlsOf(spy)[0]).toContain("/users/search/groups");
    expect(res.body.data.data).toEqual([
      {
        type: "group",
        id: "grp_9",
        group: {
          type: "GROUP",
          roomId: "grp_9",
          name: "Johnson Fans",
          isActiveMember: true,
        },
      },
    ]);
    // A real cursor, so a group list actually walks past page 1.
    expect(res.body.data.nextCursor).toBe(GROUP_CURSOR);
    expect(res.body.data.hasMore).toBe(true);
  });

  it("filter=all splits the page by quota and emits sections in source order", async () => {
    const spy = routeFetch({
      messages: json({ data: HITS, hasMore: false, nextCursor: null }),
      communities: json(communityEnvelope([{ id: "c1" }], null)),
      users: json(peopleEnvelope(null)),
      groups: json(groupEnvelope(null)),
    });
    global.fetch = spy as unknown as typeof fetch;

    const res = await request(app)
      .get(`${BASE}?q=john&limit=20`)
      .set("authorization", AUTH);

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(4);

    const byLeg = Object.fromEntries(
      urlsOf(spy).map((url) => [
        url.includes("/messages/search")
          ? "message"
          : url.includes("/communities/mine")
            ? "community"
            : url.includes("/users/search/groups")
              ? "group"
              : "people",
        url,
      ])
    );
    // ceil(20/2) for messages; the other three share the half that is left, each
    // with a floor of 4. No category can consume the page.
    expect(paramOf(byLeg.message as string, "limit")).toBe("10");
    expect(paramOf(byLeg.community as string, "limit")).toBe("5");
    expect(paramOf(byLeg.people as string, "limit")).toBe("5");
    expect(paramOf(byLeg.group as string, "limit")).toBe("5");

    // People before groups inside the people leg, so the two categories arrive
    // contiguous rather than interleaved by whichever bucket they sat in.
    expect(
      res.body.data.data.map((item: { type: string }) => item.type)
    ).toEqual(["message", "community", "person", "group"]);
    // Every leg exhausted → the scroll ends rather than re-serving page 1.
    expect(res.body.data.nextCursor).toBeNull();
    expect(res.body.data.hasMore).toBe(false);
  });

  it("round-trips the composite cursor, advancing each leg independently", async () => {
    global.fetch = routeFetch({
      messages: json({ data: HITS, hasMore: true, nextCursor: MESSAGE_CURSOR }),
      communities: json(communityEnvelope([{ id: "c1" }], COMMUNITY_CURSOR)),
      users: json(peopleEnvelope(PEOPLE_CURSOR)),
      groups: json(groupEnvelope(GROUP_CURSOR)),
    }) as unknown as typeof fetch;

    const first = await request(app)
      .get(`${BASE}?q=john`)
      .set("authorization", AUTH);
    expect(first.body.data.hasMore).toBe(true);
    const cursor = first.body.data.pagination.nextCursor as string;

    const spy = routeFetch({});
    global.fetch = spy as unknown as typeof fetch;
    const second = await request(app)
      .get(`${BASE}?q=john&cursor=${encodeURIComponent(cursor)}`)
      .set("authorization", AUTH);

    expect(second.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(4);
    const sent = urlsOf(spy);
    expect(
      paramOf(
        sent.find((u) => u.includes("/messages/search")) as string,
        "cursor"
      )
    ).toBe(MESSAGE_CURSOR);
    expect(
      paramOf(
        sent.find((u) => u.includes("/communities/mine")) as string,
        "cursor"
      )
    ).toBe(COMMUNITY_CURSOR);
    expect(
      paramOf(
        sent.find(
          (u) => u.includes("/users/search") && !u.includes("/groups")
        ) as string,
        "cursor"
      )
    ).toBe(PEOPLE_CURSOR);
    expect(
      paramOf(
        sent.find((u) => u.includes("/users/search/groups")) as string,
        "cursor"
      )
    ).toBe(GROUP_CURSOR);
  });

  it("keeps an exhausted leg exhausted instead of re-serving its first page", async () => {
    global.fetch = routeFetch({
      messages: json({ data: HITS, hasMore: true, nextCursor: MESSAGE_CURSOR }),
      communities: json(communityEnvelope([], null)),
      users: json(peopleEnvelope(null)),
      groups: json(groupEnvelope(null)),
    }) as unknown as typeof fetch;

    const first = await request(app)
      .get(`${BASE}?q=john`)
      .set("authorization", AUTH);
    const cursor = first.body.data.pagination.nextCursor as string;

    const spy = routeFetch({});
    global.fetch = spy as unknown as typeof fetch;
    await request(app)
      .get(`${BASE}?q=john&cursor=${encodeURIComponent(cursor)}`)
      .set("authorization", AUTH);

    // Only the message leg still has a cursor — the other three are not called again.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(urlsOf(spy)[0]).toContain("/messages/search");
  });

  it("holds a failed leg's own page instead of rewinding it to page 1", async () => {
    // The message leg answers a different row per page, so a rewind shows up as
    // m1 arriving twice rather than only as a missing cursor on the wire.
    const messagePager = (onSecondPage: Response) =>
      jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/users/search"))
          return json(peopleEnvelope(PEOPLE_CURSOR));
        if (url.includes("/communities/mine"))
          return json(communityEnvelope([{ id: "c1" }], COMMUNITY_CURSOR));
        return paramOf(url, "cursor") === MESSAGE_CURSOR
          ? onSecondPage
          : json({ data: HITS, hasMore: true, nextCursor: MESSAGE_CURSOR });
      });
    const messageIds = (res: request.Response) =>
      (res.body.data.data as { type: string; id: string }[])
        .filter((item) => item.type === "message")
        .map((item) => item.id);

    global.fetch = messagePager(failure(500)) as unknown as typeof fetch;
    const first = await request(app)
      .get(`${BASE}?q=john`)
      .set("authorization", AUTH);
    expect(messageIds(first)).toEqual(["m1"]);

    // Mid-scroll blip: the message leg 500s on the page it was asked for.
    const second = await request(app)
      .get(
        `${BASE}?q=john&cursor=${encodeURIComponent(first.body.data.pagination.nextCursor as string)}`
      )
      .set("authorization", AUTH);
    expect(second.status).toBe(200);
    expect(messageIds(second)).toEqual([]);

    const spy = messagePager(
      json({
        data: [{ ...HITS[0], messageId: "m2" }],
        hasMore: false,
        nextCursor: null,
      })
    );
    global.fetch = spy as unknown as typeof fetch;
    const third = await request(app)
      .get(
        `${BASE}?q=john&cursor=${encodeURIComponent(second.body.data.pagination.nextCursor as string)}`
      )
      .set("authorization", AUTH);

    // The blip must not have rewound the leg: same cursor, and m1 never repeats.
    expect(
      paramOf(
        urlsOf(spy).find((u) => u.includes("/messages/search")) as string,
        "cursor"
      )
    ).toBe(MESSAGE_CURSOR);
    expect(messageIds(third)).toEqual(["m2"]);
  });

  it("refuses a hand-made all-exhausted cursor rather than answering 200", async () => {
    const spy = routeFetch({});
    global.fetch = spy as unknown as typeof fetch;

    // Every leg skipped = no downstream call = the token is never verified, and
    // this route only ever emits `nextCursor: null` once all four are done.
    const forged = Buffer.from(
      JSON.stringify({ v: 1, m: null, c: null, p: null, g: null })
    ).toString("base64url");
    const res = await request(app)
      .get(`${BASE}?q=john&cursor=${forged}`)
      .set("authorization", "Bearer totally-forged-garbage");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_CURSOR");
    expect(spy).not.toHaveBeenCalled();
  });

  it("400s a cursor it cannot read rather than silently restarting", async () => {
    const spy = routeFetch({});
    global.fetch = spy as unknown as typeof fetch;

    const garbled = await request(app)
      .get(`${BASE}?q=john&cursor=not-a-real-cursor`)
      .set("authorization", AUTH);
    expect(garbled.status).toBe(400);
    expect(garbled.body.code).toBe("INVALID_CURSOR");

    const wrongVersion = Buffer.from(JSON.stringify({ v: 2 })).toString(
      "base64url"
    );
    const stale = await request(app)
      .get(`${BASE}?q=john&cursor=${wrongVersion}`)
      .set("authorization", AUTH);
    expect(stale.status).toBe(400);
    expect(stale.body.code).toBe("INVALID_CURSOR");

    expect(spy).not.toHaveBeenCalled();
  });

  it("surfaces a rejected token instead of reporting no results", async () => {
    global.fetch = routeFetch({
      users: failure(401),
    }) as unknown as typeof fetch;
    const res = await request(app)
      .get(`${BASE}?q=john`)
      .set("authorization", AUTH);
    expect(res.status).toBe(401);
  });

  it("relays a downstream 403 as 403 with its own code", async () => {
    global.fetch = routeFetch({
      users: failure(403, "ACCOUNT_BANNED"),
    }) as unknown as typeof fetch;

    const res = await request(app)
      .get(`${BASE}?q=john`)
      .set("authorization", AUTH);

    // Collapsed into 401, this sent a banned user through the generic sign-out.
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_BANNED");
  });

  it("empties only the category whose leg failed", async () => {
    global.fetch = routeFetch({
      messages: failure(500),
      communities: json(communityEnvelope([{ id: "c1" }], null)),
      users: json(peopleEnvelope(null)),
    }) as unknown as typeof fetch;

    const res = await request(app)
      .get(`${BASE}?q=john`)
      .set("authorization", AUTH);

    expect(res.status).toBe(200);
    expect(
      res.body.data.data.map((item: { type: string }) => item.type)
    ).toEqual(["community", "person", "group"]);
  });

  it("surfaces a 400 on the sentinel this route sends itself", async () => {
    global.fetch = routeFetch({
      communities: failure(400),
    }) as unknown as typeof fetch;

    // Page 1 carries no caller cursor, but the community leg is always sent the
    // start sentinel — a 400 on it is a broken cursor, not an empty category.
    const res = await request(app)
      .get(`${BASE}?q=john`)
      .set("authorization", AUTH);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_CURSOR");
  });

  // The people tab 503ed in dev and nothing said why: user-service refused the
  // request and the 4xx fell through to the all-legs-failed branch, which is
  // declared retryable, so the client replayed a request that could never work.
  it("surfaces a leg's 4xx as a non-retryable 400 carrying its code", async () => {
    global.fetch = routeFetch({
      users: failure(400, "VALIDATION_FAILED"),
    }) as unknown as typeof fetch;

    const res = await request(app)
      .get(`${BASE}?q=john&filter=people&limit=20`)
      .set("authorization", AUTH);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.error.retryable).toBe(false);
  });

  it("falls back to a generic code when the leg's 4xx carries none", async () => {
    global.fetch = routeFetch({
      users: failure(404),
    }) as unknown as typeof fetch;

    const res = await request(app)
      .get(`${BASE}?q=john&filter=people`)
      .set("authorization", AUTH);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SEARCH_REQUEST_REJECTED");
  });

  // A 5xx is a real outage, so it keeps emptying its category rather than
  // failing the whole request — only the 4xx path above is deterministic.
  it("still empties a category on a leg 5xx rather than rejecting", async () => {
    global.fetch = routeFetch({
      users: failure(500),
      communities: json(communityEnvelope([{ id: "c1" }], null)),
      messages: json({ data: [], hasMore: false, nextCursor: null }),
    }) as unknown as typeof fetch;

    const res = await request(app)
      .get(`${BASE}?q=john`)
      .set("authorization", AUTH);

    expect(res.status).toBe(200);
  });

  it("503s when every leg fails", async () => {
    global.fetch = routeFetch({
      users: failure(500),
      // "Every leg" is four now. Leaving this one answering made the route
      // return a 200 with a group section, which is the correct behaviour for
      // three-down-one-up — just not what this case is about.
      groups: failure(500),
      communities: failure(500),
      messages: failure(500),
    }) as unknown as typeof fetch;
    const res = await request(app)
      .get(`${BASE}?q=john`)
      .set("authorization", AUTH);
    expect(res.status).toBe(503);
  });
});
