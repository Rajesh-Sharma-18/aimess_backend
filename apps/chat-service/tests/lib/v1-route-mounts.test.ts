/**
 * ROUTE-MOUNT guard for the endpoints folded onto V1 when `/api/v2` was deleted.
 *
 * The consolidation moved five routes onto the V1 routers and removed the four
 * `/api/v2/chat/*` mounts. A wrong mount path or a stale `/api/v2` reference does
 * not fail a typecheck and does not fail a controller unit test — it only shows up
 * as a 404 at runtime, which is exactly the regression this file exists to catch.
 *
 * These assert only ROUTING, never business logic. Status code alone cannot tell
 * the two apart: a MOUNTED handler running against this suite's empty repo mocks
 * legitimately answers 404 (`CHAT_ROOM_NOT_FOUND`). The reliable discriminator is
 * the response SHAPE — Express's default no-route handler emits `text/html`
 * ("Cannot GET /…"), whereas any route that reached a handler goes through the
 * service's `errorHandler` and emits the JSON `{ success: false, error }` envelope.
 * So: mounted ⇒ JSON, unmounted ⇒ HTML, whatever the status.
 */
import request from "supertest";

import { buildApp } from "../helpers/app-factory.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

let app: import("express").Express;

beforeEach(() => {
  ({ app } = buildApp());
});

const ROOM = "grp_room_1";
const PRIVATE_ROOM = "prv_room_1";
const MESSAGE = "msg_1";

type Method = "get" | "post" | "delete" | "patch";

/**
 * Did this request reach a handler at all?
 *
 * `isJson` is the load-bearing signal: the service's `errorHandler` always answers
 * JSON, so anything that reached a route is JSON regardless of status. Express's
 * no-route fallback answers `text/html`. `noRoute` corroborates it by finding the
 * default handler's "Cannot GET /…" text — note it sits inside a `<pre>`, so it is
 * NOT at the start of a line and must not be anchored with `^`.
 */
async function reachedAHandler(method: Method, path: string) {
  const res = await request(app)[method](path).set(bearer(makeAccessToken()));
  return {
    isJson: String(res.headers["content-type"] ?? "").includes(
      "application/json"
    ),
    noRoute: /Cannot (GET|POST|PUT|PATCH|DELETE) \//.test(String(res.text)),
    status: res.status,
  };
}

/** Every route the V2 removal moved onto V1, at its V1 path shape. */
const MOUNTED: ReadonlyArray<readonly [Method, string]> = [
  // Zero-loss changes feed — all three room kinds.
  ["get", `/api/chat/private/rooms/${PRIVATE_ROOM}/changes`],
  ["get", `/api/chat/groups/rooms/${ROOM}/changes`],
  ["get", `/api/chat/community/rooms/${ROOM}/changes`],
  // Room-inferred SET reaction.
  ["post", `/api/chat/private/messages/${MESSAGE}/react`],
  ["post", `/api/chat/groups/messages/${MESSAGE}/react`],
  // Path-param group delete (the body-carried POST form stays; see below).
  ["delete", `/api/chat/groups/messages/${MESSAGE}`],
];

/**
 * The V1 routes these sit BESIDE. Regression guard: folding V2 in must not have
 * shadowed or replaced any of them — `DELETE /groups/messages/:id` in particular
 * shares a mount prefix with `DELETE /groups/rooms/:roomId` on the group-room router,
 * which is registered FIRST.
 */
const STILL_MOUNTED: ReadonlyArray<readonly [Method, string]> = [
  ["post", "/api/chat/groups/messages/delete"],
  ["patch", `/api/chat/groups/messages/${MESSAGE}`],
  ["delete", `/api/chat/groups/rooms/${ROOM}`],
  ["get", `/api/chat/groups/rooms/${ROOM}/messages`],
  ["get", `/api/chat/private/rooms/${PRIVATE_ROOM}/messages`],
  ["get", `/api/chat/community/rooms/${ROOM}/messages`],
  ["get", `/api/chat/community/rooms/${ROOM}/sync?since_ts=1`],
  ["get", "/api/chat/inbox"],
  [
    "post",
    `/api/chat/private/rooms/${PRIVATE_ROOM}/messages/${MESSAGE}/reactions`,
  ],
  [
    "delete",
    `/api/chat/private/rooms/${PRIVATE_ROOM}/messages/${MESSAGE}/reactions/%F0%9F%91%8D`,
  ],
];

/** The `/api/v2/chat/*` mounts the consolidation removed from this service. */
const RETIRED = [
  `/api/v2/chat/private/rooms/${PRIVATE_ROOM}/messages`,
  `/api/v2/chat/private/rooms/${PRIVATE_ROOM}/changes`,
  `/api/v2/chat/group/rooms/${ROOM}/messages`,
  `/api/v2/chat/group/rooms/${ROOM}/changes`,
  `/api/v2/chat/community/rooms/${ROOM}/messages`,
  `/api/v2/chat/community/rooms/${ROOM}/changes`,
  `/api/v2/chat/community/rooms/${ROOM}/sync`,
  "/api/v2/chat/inbox",
  // V2's singular `group` + `/rooms/` shape. Nothing should answer on it now, even
  // under /api/chat — this is the exact mistake a blind `v2`→`v1` search-and-replace
  // in a client would make, so pin it.
  `/api/chat/group/rooms/${ROOM}/messages`,
  `/api/chat/group/rooms/${ROOM}/changes`,
] as const;

describe("routes folded onto V1 are mounted", () => {
  it.each(MOUNTED)("%s %s reaches a handler", async (method, path) => {
    const { isJson, noRoute } = await reachedAHandler(method, path);
    expect(noRoute).toBe(false);
    expect(isJson).toBe(true);
  });
});

describe("the V1 routes they sit beside are untouched", () => {
  it.each(STILL_MOUNTED)(
    "%s %s still reaches a handler",
    async (method, path) => {
      const { isJson, noRoute } = await reachedAHandler(method, path);
      expect(noRoute).toBe(false);
      expect(isJson).toBe(true);
    }
  );
});

describe("the retired /api/v2 (and singular-group) paths are gone", () => {
  it.each(RETIRED)("GET %s → no route", async (path) => {
    const { isJson, noRoute, status } = await reachedAHandler("get", path);
    expect(status).toBe(404);
    expect(isJson).toBe(false);
    expect(noRoute).toBe(true);
  });
});
