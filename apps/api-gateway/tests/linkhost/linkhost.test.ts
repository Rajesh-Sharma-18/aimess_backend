/**
 * Community link host (aimess.me) — host-gated `.well-known` proofs + the
 * server-rendered "Open in app" preview. On a non-link host the same paths must
 * fall through to normal routing (→ 404 here, since nothing else claims them).
 *
 * detectLink() is also unit-tested to guarantee parity with the spec (§4.2).
 */
import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";
import type { MediaClient } from "../../src/grpc/clients/media.client.js";
import {
  detectLink,
  detectFromSegment,
} from "../../src/linkhost/detect-link.js";

const app = createApp(
  {} as unknown as MessagingClient,
  {} as unknown as MediaClient
);
const LINK_HOST = "aimess.me";

describe("detectLink (spec §4.2 parity)", () => {
  it("bare segment → public handle", () => {
    expect(detectFromSegment("backend_devs")).toEqual({
      kind: "public",
      handle: "backend_devs",
    });
  });
  it("+segment → private code (strips +)", () => {
    expect(detectFromSegment("+AbC123")).toEqual({
      kind: "private",
      code: "AbC123",
    });
  });
  it("empty → invalid", () => {
    expect(detectFromSegment("")).toEqual({ kind: "invalid" });
  });
  it("https public url", () => {
    expect(detectLink("https://aimess.me/backend_devs")).toEqual({
      kind: "public",
      handle: "backend_devs",
    });
  });
  it("https private url", () => {
    expect(detectLink("https://aimess.me/+AbC123")).toEqual({
      kind: "private",
      code: "AbC123",
    });
  });
  it("scheme join url → private", () => {
    expect(detectLink("aimess://join?code=XYZ")).toEqual({
      kind: "private",
      code: "XYZ",
    });
  });
  it("scheme resolve url → public", () => {
    expect(detectLink("aimess://resolve?handle=devs")).toEqual({
      kind: "public",
      handle: "devs",
    });
  });
});

describe("link host (Host: aimess.me)", () => {
  it("serves assetlinks.json as application/json", async () => {
    const res = await request(app)
      .get("/.well-known/assetlinks.json")
      .set("Host", LINK_HOST);
    expect(res.status).toBe(200);
    expect(res.type).toBe("application/json");
    expect(res.body[0].relation).toContain(
      "delegate_permission/common.handle_all_urls"
    );
  });

  it("serves apple-app-site-association as application/json", async () => {
    const res = await request(app)
      .get("/.well-known/apple-app-site-association")
      .set("Host", LINK_HOST);
    expect(res.status).toBe(200);
    expect(res.type).toBe("application/json");
    expect(res.body.applinks.details[0].components[0]["/"]).toBe("/*");
  });

  it("renders a public preview with OG tags + open-in-app", async () => {
    const res = await request(app).get("/backend_devs").set("Host", LINK_HOST);
    expect(res.status).toBe(200);
    expect(res.text).toContain('property="og:title"');
    expect(res.text).toContain("Open in app");
  });

  it("renders a generic private preview (no metadata leak)", async () => {
    const res = await request(app).get("/+SECRETCODE").set("Host", LINK_HOST);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Private community");
  });

  it("redirects root to the web app", async () => {
    const res = await request(app).get("/").set("Host", LINK_HOST);
    expect(res.status).toBe(302);
  });
});

describe("non-link host falls through", () => {
  it("does NOT serve assetlinks.json on a normal host", async () => {
    const res = await request(app).get("/.well-known/assetlinks.json");
    expect(res.status).toBe(404);
  });
});
