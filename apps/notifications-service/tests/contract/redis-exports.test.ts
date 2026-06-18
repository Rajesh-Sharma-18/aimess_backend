/**
 * Deploy-gap guard (commit e21dede class of bug): a consumer imports a named
 * export from `@aimess/redis` that the package does not actually export, so the
 * code typechecks against a stale build but blows up (or silently no-ops) at
 * runtime after a partial deploy.
 *
 * community-service consumes `publishCommunityRoomEvent` (the community:<id>
 * socket channel) and notifications-service consumes `publishUserSocketEvent`
 * (the notify:<userId> channel). Both MUST be present on the package barrel.
 *
 * The jest moduleNameMapper resolves `@aimess/redis` to the package's TS source
 * barrel, so this asserts the real source surface — no stale dist/ involved.
 */

// Override the global-mocks/`config/redis` stub is irrelevant here; we import the
// shared PACKAGE barrel, not the service's redis config. No service modules are
// pulled in, so no I/O seam needs faking.
import * as redisPkg from "@aimess/redis";

describe("@aimess/redis package contract", () => {
  it("exports publishUserSocketEvent as a function", () => {
    expect(typeof redisPkg.publishUserSocketEvent).toBe("function");
    // (redis, userId, event, data) → 4 declared params.
    expect(redisPkg.publishUserSocketEvent.length).toBe(4);
  });

  it("exports publishCommunityRoomEvent as a function", () => {
    expect(typeof redisPkg.publishCommunityRoomEvent).toBe("function");
    // (redis, communityId, event, data) → 4 declared params.
    expect(redisPkg.publishCommunityRoomEvent.length).toBe(4);
  });

  it("builds the notify:<userId> envelope shape via a fake client", async () => {
    const publish = jest.fn(async () => 1);
    const fakeRedis = { publish } as unknown as Parameters<
      typeof redisPkg.publishUserSocketEvent
    >[0];

    await redisPkg.publishUserSocketEvent(fakeRedis, "user-1", "evt", {
      a: 1,
    });

    expect(publish).toHaveBeenCalledWith(
      "notify:user-1",
      JSON.stringify({ event: "evt", data: { a: 1 } })
    );
  });

  it("builds the community:<communityId> envelope shape via a fake client", async () => {
    const publish = jest.fn(async () => 1);
    const fakeRedis = { publish } as unknown as Parameters<
      typeof redisPkg.publishCommunityRoomEvent
    >[0];

    await redisPkg.publishCommunityRoomEvent(fakeRedis, "comm-1", "evt", {
      b: 2,
    });

    expect(publish).toHaveBeenCalledWith(
      "community:comm-1",
      JSON.stringify({ event: "evt", data: { b: 2 } })
    );
  });
});
