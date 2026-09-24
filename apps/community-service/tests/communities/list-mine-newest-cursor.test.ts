/**
 * `GET /api/v1/communities/mine?cursor=…` — which clock decides the boundary.
 *
 * The joined list pages on `lastActivityAt < cursor`, and `lastActivityAt` is
 * written from the message's server-side `createdAt`. A client that stamps that
 * cursor with its OWN wall clock is asking the server to hide everything that
 * happened between the two clocks: on a browser a few seconds behind the API
 * host, the community the user has just posted in sorts NEWER than its idea of
 * "now" and drops out of its own list — while the chat room stays open beside
 * it, because membership was never involved. An account with one membership
 * renders the empty state next to the room it names.
 *
 * `cursor=now` is how a client asks for the newest page without guessing: the
 * server resolves it against the clock that wrote the column. Routing, Zod
 * validation and real JWT verify run for real; the service is mocked so these
 * assertions are about the boundary the controller computes, nothing else.
 */
jest.mock("../../src/services/community.service.js", () => ({
  communityService: {
    listMineKeyset: jest.fn(),
    listMine: jest.fn(),
    discover: jest.fn(),
  },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { communityService } from "../../src/services/community.service.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

const svc = communityService as unknown as Record<string, jest.Mock>;
const auth = () => bearer(makeAccessToken());

const emptyPage = {
  pagination: {
    totalData: 0,
    totalPage: 1,
    currentPage: 1,
    limit: 50,
    nextCursor: null,
    hasMore: false,
  },
  data: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  svc.listMineKeyset.mockResolvedValue(emptyPage);
  svc.listMine.mockResolvedValue(emptyPage);
  svc.discover.mockResolvedValue(emptyPage);
});

describe("GET /communities/mine — joined-list cursor", () => {
  it("resolves cursor=now against the SERVER clock, with no id tiebreaker", async () => {
    const before = Date.now();
    const res = await request(app)
      .get("/api/v1/communities/mine?limit=50&cursor=now")
      .set(auth());
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(svc.listMineKeyset).toHaveBeenCalledTimes(1);
    const { cursor } = svc.listMineKeyset.mock.calls[0][1];
    expect(cursor.ts.getTime()).toBeGreaterThanOrEqual(before);
    expect(cursor.ts.getTime()).toBeLessThanOrEqual(after);
    // A coarse first jump has nothing to tie-break on, so the compound boundary
    // degrades to a pure `lastActivityAt <` bound.
    expect(cursor.id).toBe("ffffffffffffffffffffffff");
  });

  it("keeps cursor=now out of search mode", async () => {
    await request(app)
      .get("/api/v1/communities/mine?limit=50&cursor=now")
      .set(auth());

    expect(svc.discover).not.toHaveBeenCalled();
    expect(svc.listMine).not.toHaveBeenCalled();
  });

  it("still honours an explicit epoch-ms cursor — a real seek is not a first jump", async () => {
    const ts = 1_780_000_000_000;

    await request(app)
      .get(`/api/v1/communities/mine?limit=50&cursor=${ts}`)
      .set(auth());

    expect(svc.listMineKeyset.mock.calls[0][1].cursor.ts.getTime()).toBe(ts);
  });

  it("still honours the compound nextCursor it handed out", async () => {
    const id = "a".repeat(24);

    await request(app)
      .get(`/api/v1/communities/mine?limit=50&cursor=1780000000000_${id}`)
      .set(auth());

    expect(svc.listMineKeyset.mock.calls[0][1].cursor).toEqual({
      ts: new Date(1_780_000_000_000),
      id,
    });
  });

  it("rejects 'now' in search mode, where the cursor is a community id", async () => {
    const res = await request(app)
      .get("/api/v1/communities/mine?limit=50&q=devs&cursor=now")
      .set(auth());

    expect(res.status).toBe(400);
    expect(svc.discover).not.toHaveBeenCalled();
  });

  it("rejects a cursor that is neither 'now', epoch-ms nor the compound token", async () => {
    const res = await request(app)
      .get("/api/v1/communities/mine?limit=50&cursor=yesterday")
      .set(auth());

    expect(res.status).toBe(400);
    expect(svc.listMineKeyset).not.toHaveBeenCalled();
  });
});
