/**
 * AIMESS-268: a signed-in app re-resolves every invite card it shows, so a
 * verified user must not share the anonymous 30/IP enumeration bucket.
 */
import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";
import type { MediaClient } from "../../src/grpc/clients/media.client.js";
import { makeAccessToken } from "../helpers/auth.js";

const PATH = "/api/v1/communities/invite-links/abcdefghijklmnop";

async function firstThrottle(app: ReturnType<typeof createApp>, count: number, auth?: string, ip = "10.0.0.1") {
  for (let i = 1; i <= count; i += 1) {
    const req = request(app).get(PATH).set("X-Forwarded-For", ip);
    const res = await (auth ? req.set("Authorization", `Bearer ${auth}`) : req);
    if (res.status === 429) return i;
  }
  return null;
}

describe("invite preview limiter", () => {
  const app = createApp({} as unknown as MessagingClient, {} as unknown as MediaClient);

  it("throttles anonymous callers after 30", async () => {
    expect(await firstThrottle(app, 31, undefined, "10.0.0.31")).toBe(31);
  });

  it("an unverifiable token is still anonymous", async () => {
    expect(await firstThrottle(app, 31, "garbage.token.value", "10.0.0.32")).toBe(31);
  });

  it("a verified user is not held to the anonymous bucket", async () => {
    const token = makeAccessToken({ userId: "u-268", sessionId: "s-268" });
    expect(await firstThrottle(app, 40, token, "10.0.0.33")).toBeNull();
  });
});
