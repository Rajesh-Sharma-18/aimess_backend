/**
 * toActiveSessionItem — the single source of truth for the session-list DTO,
 * shared by GET /auth/sessions and the realtime session:list_updated event.
 */
import { toActiveSessionItem } from "../../src/lib/session-serializer.js";
import type { SerializableSession } from "../../src/lib/session-serializer.js";

const ROW: SerializableSession = {
  id: "sess-1",
  deviceId: "dev-1",
  deviceName: "iOS",
  deviceType: "IOS" as SerializableSession["deviceType"],
  osVersion: null,
  appVersion: null,
  ipAddress: "122.167.198.202",
  countryCode: null,
  lastActiveAt: new Date("2026-07-14T08:23:57.653Z"),
  createdAt: new Date("2026-07-14T08:23:57.653Z"),
};

describe("toActiveSessionItem", () => {
  it("maps the row and serializes dates to ISO", () => {
    expect(toActiveSessionItem(ROW, "sess-1")).toEqual({
      sessionId: "sess-1",
      deviceId: "dev-1",
      deviceName: "iOS",
      deviceType: "IOS",
      osVersion: null,
      appVersion: null,
      ipAddress: "122.167.198.202",
      countryCode: null,
      lastActiveAt: "2026-07-14T08:23:57.653Z",
      createdAt: "2026-07-14T08:23:57.653Z",
      isCurrent: true,
    });
  });

  it("isCurrent is false when the row is not the current session (broadcast case)", () => {
    expect(toActiveSessionItem(ROW).isCurrent).toBe(false);
    expect(toActiveSessionItem(ROW, "other").isCurrent).toBe(false);
  });

  it("REST (GET /auth/sessions) and the session:list_updated broadcast are byte-for-byte identical for every shared field", () => {
    // GET /auth/sessions passes the viewer's own sessionId (session.service.ts);
    // the socket broadcast (token.ts) passes none. Both go through this exact
    // same function on the exact same row — only isCurrent may legitimately differ.
    const restPayload = toActiveSessionItem(ROW, "sess-1");
    const socketPayload = toActiveSessionItem(ROW);

    const { isCurrent: _restCurrent, ...restRest } = restPayload;
    const { isCurrent: _socketCurrent, ...socketRest } = socketPayload;
    expect(restRest).toEqual(socketRest);
  });
});
