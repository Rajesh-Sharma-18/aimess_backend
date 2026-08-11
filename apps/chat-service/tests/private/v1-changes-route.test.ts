/**
 * Regression: the zero-loss `/changes` feed must be reachable on the V1 chat
 * surface. It used to exist ONLY under the `/api/v2/chat/*` mounts, so a client
 * calling `GET /api/v1/chat/private/rooms/:roomId/changes` (the gateway rewrites
 * that to `/api/chat/...`) got a bare Express `Cannot GET` 404 — no route, no
 * error envelope — and the room silently never caught up after a reopen.
 *
 * Asserts the V1 mount answers for private / group / community, and that an
 * unknown path under the same base still 404s (i.e. we mounted routes, not a
 * catch-all).
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

const ROOM = "prv_v1changes01";

let app: ReturnType<typeof buildApp>["app"];
let mocks: BuiltMocks;

beforeEach(() => {
  ({ app, mocks } = buildApp());
});

describe("GET /api/chat/private/rooms/:roomId/changes (V1 mount)", () => {
  it("POSITIVE: 200 with the changes envelope for a participant", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "peer_1"],
    });
    mocks.privateRoomRepo.getRoomRevision.mockResolvedValue(7);
    mocks.privateMessageRepo.findByRoomIdRevisionSince.mockResolvedValue({
      messages: [],
      hasMore: false,
      nextRevision: null,
    });

    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/changes?since_revision=0&limit=100`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        roomRevision: 7,
        resetRequired: false,
        items: [],
      })
    );
  });

  it("NEGATIVE: 401 (route exists, auth gate runs) without a token", async () => {
    const res = await request(app).get(
      `/api/chat/private/rooms/${ROOM}/changes`
    );
    expect(res.status).toBe(401);
  });
});

describe("V1 changes mount — group + community", () => {
  it.each([
    // Groups address rooms as `/:roomId` on V1 — the only shape now that the
    // parallel `/api/v2` routers (which used `/rooms/:roomId`) are gone.
    ["group", "/api/chat/groups/grp_x/changes"],
    ["community", "/api/chat/community/rooms/cmt_x/changes"],
  ])("%s: registered (401 from the auth gate, not a 404)", async (_n, path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
  });

  it("an unknown path under the same base is still 404", async () => {
    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/not-a-route`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(404);
  });
});
