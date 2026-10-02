const isUserBanned = jest.fn<Promise<boolean>, [unknown, string]>();

jest.mock("@aimess/redis", () => ({
  __esModule: true,
  ...jest.requireActual("@aimess/redis"),
  getRedis: () => ({}),
  isUserBanned: (client: unknown, userId: string) => isUserBanned(client, userId),
}));

import request from "supertest";

import { createApp } from "../../src/app.js";
import { listCustomCredentials } from "../../src/grpc/clients/backoffice.client.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";
import {
  bearer,
  makeAccessToken,
  makeExpiredAccessToken,
  makeForgedAccessToken,
} from "../helpers/auth.js";

const app = createApp({} as unknown as MessagingClient);
const listCredentials = listCustomCredentials as jest.Mock;
const CHECK = "/api/v1/app-version/check";
const CREDENTIALS = { GIPHY_API_KEY: "giphy-android-key" };

beforeEach(() => {
  jest.clearAllMocks();
  isUserBanned.mockResolvedValue(false);
  listCredentials.mockResolvedValue(CREDENTIALS);
});

describe("POST /api/v1/app-version/check — credentials", () => {
  it("returns the platform's credentials to a signed-in user", async () => {
    const res = await request(app)
      .post(CHECK)
      .set(bearer(makeAccessToken()))
      .send({ platform: "android", version: "2.0.3" });

    expect(res.status).toBe(200);
    expect(res.body.data.credentials).toEqual(CREDENTIALS);
    expect(res.body.data.isUpToDate).toBe(true);
    expect(listCredentials).toHaveBeenCalledWith("ANDROID");
  });

  it("asks for the iOS set on an iOS check", async () => {
    await request(app)
      .post(CHECK)
      .set(bearer(makeAccessToken()))
      .send({ platform: "ios", version: "2.0.3" })
      .expect(200);

    expect(listCredentials).toHaveBeenCalledWith("IOS");
  });

  it.each([
    ["no token", undefined],
    ["an expired token", makeExpiredAccessToken()],
    ["a forged token", makeForgedAccessToken()],
  ])("gives nothing to a caller with %s, but still answers the version check", async (_label, token) => {
    const req = request(app).post(CHECK);
    if (token) req.set(bearer(token));
    const res = await req.send({ platform: "android", version: "2.0.3" });

    expect(res.status).toBe(200);
    expect(res.body.data.credentials).toEqual({});
    expect(res.body.data.isUpToDate).toBe(true);
    expect(listCredentials).not.toHaveBeenCalled();
  });

  it("gives nothing to a banned user", async () => {
    isUserBanned.mockResolvedValue(true);
    const res = await request(app)
      .post(CHECK)
      .set(bearer(makeAccessToken()))
      .send({ platform: "android", version: "2.0.3" });

    expect(res.body.data.credentials).toEqual({});
    expect(listCredentials).not.toHaveBeenCalled();
  });

  it("fails closed when the ban check cannot run", async () => {
    isUserBanned.mockRejectedValue(new Error("redis down"));
    const res = await request(app)
      .post(CHECK)
      .set(bearer(makeAccessToken()))
      .send({ platform: "android", version: "2.0.3" });

    expect(res.status).toBe(200);
    expect(res.body.data.credentials).toEqual({});
  });
});
