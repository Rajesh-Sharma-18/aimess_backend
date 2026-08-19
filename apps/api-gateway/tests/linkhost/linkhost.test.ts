/**
 * Community link host — host-gated `.well-known` proofs + the server-rendered
 * "Open in app" preview. On a non-link host the same paths must fall through to
 * normal routing (→ 404 here, since nothing else claims them).
 *
 * `detectFromPath` is also unit-tested: it is the single owner of the canonical
 * grammar and must stay in lockstep with the Android parser and the web's
 * `aimess_website/src/utils/linkGrammar.ts`.
 */
import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";
import type { MediaClient } from "../../src/grpc/clients/media.client.js";
import {
  detectFromPath,
  detectFromSegment,
  detectLink,
  deferredToken,
} from "../../src/linkhost/detect-link.js";

const app = createApp(
  {} as unknown as MessagingClient,
  {} as unknown as MediaClient
);
const LINK_HOST = "ai5dev.tech";

describe("detectFromPath (canonical grammar)", () => {
  it("bare segment → public handle", () => {
    expect(detectFromPath(["backend_devs"])).toEqual({
      kind: "public",
      handle: "backend_devs",
    });
  });
  it("+segment → private code (strips +)", () => {
    expect(detectFromPath(["+AbC123"])).toEqual({
      kind: "private",
      code: "AbC123",
    });
  });
  it("/g/<token> → group", () => {
    expect(detectFromPath(["g", "qBc4eEtQ6bopGcwU-HodCHCk"])).toEqual({
      kind: "group",
      token: "qBc4eEtQ6bopGcwU-HodCHCk",
    });
  });
  it("/community/@<handle> and /community/<handle> are the same target", () => {
    expect(detectFromPath(["community", "@backend_devs"])).toEqual({
      kind: "public",
      handle: "backend_devs",
    });
    expect(detectFromPath(["community", "backend_devs"])).toEqual({
      kind: "public",
      handle: "backend_devs",
    });
  });
  it("malformed INSIDE our path space → invalid, never a browser bounce", () => {
    expect(detectFromPath(["g"])).toEqual({ kind: "invalid" });
    expect(detectFromPath(["g", "a", "b"])).toEqual({ kind: "invalid" });
    expect(detectFromPath(["+"])).toEqual({ kind: "invalid" });
    expect(detectFromPath(["community", "@"])).toEqual({ kind: "invalid" });
  });
  it("marketing routes are NOT ours (null), so the site keeps serving them", () => {
    // The link host is shared with the marketing site — the single most
    // damaging regression would be AIMESS swallowing its own legal pages.
    for (const path of [
      ["terms-of-service"],
      ["privacy-policy"],
      ["login"],
      ["signup"],
      ["about"],
      ["docs"],
      ["community"],
      ["community", "create"],
      ["unknown", "path"],
      [],
    ]) {
      expect(detectFromPath(path)).toBeNull();
    }
  });
  it("charset violations never produce a target", () => {
    expect(detectFromPath(["<script>alert(1)</script>"])).toBeNull();
    expect(detectFromPath(["g", "<script>"])).toEqual({ kind: "invalid" });
    expect(detectFromPath(["g", "a".repeat(101)])).toEqual({ kind: "invalid" });
    expect(detectFromPath(["community", "@<script>"])).toEqual({
      kind: "invalid",
    });
  });
  it("empty segment → invalid via the single-segment helper", () => {
    expect(detectFromSegment("")).toEqual({ kind: "invalid" });
  });
});

describe("detectLink (full URLs)", () => {
  it("https public url", () => {
    expect(detectLink("https://ai5dev.tech/backend_devs")).toEqual({
      kind: "public",
      handle: "backend_devs",
    });
  });
  it("https private url — bare and percent-encoded + are the same link", () => {
    expect(detectLink("https://ai5dev.tech/+AbC123")).toEqual({
      kind: "private",
      code: "AbC123",
    });
    expect(detectLink("https://ai5dev.tech/%2BAbC123")).toEqual({
      kind: "private",
      code: "AbC123",
    });
  });
  it("https group url", () => {
    expect(detectLink("https://ai5dev.tech/g/TOK-en_1")).toEqual({
      kind: "group",
      token: "TOK-en_1",
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
  it("scheme joingroup url → group (host and path-segment forms)", () => {
    expect(detectLink("aimess://joingroup?token=TOK")).toEqual({
      kind: "group",
      token: "TOK",
    });
    expect(detectLink("aimess:///joingroup?token=TOK")).toEqual({
      kind: "group",
      token: "TOK",
    });
  });
});

describe("deferredToken (Play Install Referrer)", () => {
  it("prefixes by kind", () => {
    expect(deferredToken({ kind: "public", handle: "devs" })).toBe("h_devs");
    expect(deferredToken({ kind: "private", code: "AbC" })).toBe("p_AbC");
    expect(deferredToken({ kind: "group", token: "Tok" })).toBe("g_Tok");
    expect(deferredToken({ kind: "invalid" })).toBe("");
  });
});

describe(`link host (Host: ${LINK_HOST})`, () => {
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

  it("apple-app-site-association claims only the namespaced prefixes", async () => {
    const res = await request(app)
      .get("/.well-known/apple-app-site-association")
      .set("Host", LINK_HOST);
    expect(res.status).toBe(200);
    expect(res.type).toBe("application/json");
    const paths = res.body.applinks.details[0].components.map(
      (c: Record<string, string>) => c["/"]
    );
    // "/*" would claim the whole marketing site (spec §2/§6.6).
    expect(paths).toEqual(["/+*", "/g/*", "/community/*"]);
    expect(paths).not.toContain("/*");
  });

  it("renders a public preview with OG tags + open-in-app", async () => {
    const res = await request(app).get("/backend_devs").set("Host", LINK_HOST);
    expect(res.status).toBe(200);
    expect(res.text).toContain('property="og:title"');
    expect(res.text).toContain("Open in app");
  });

  it("renders /community/@<handle> too (two-segment link)", async () => {
    const res = await request(app)
      .get("/community/@backend_devs")
      .set("Host", LINK_HOST);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Open in app");
  });

  it("renders a generic private preview (no metadata leak)", async () => {
    const res = await request(app).get("/+SECRETCODE").set("Host", LINK_HOST);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Private community");
  });

  it("renders a generic group preview and hands the token to the app", async () => {
    const res = await request(app).get("/g/SECRETTOKEN").set("Host", LINK_HOST);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Group invite");
    expect(res.text).toContain("S.token=");
    expect(res.text).toContain("joingroup?token=");
    expect(res.text).toContain('"webTarget":"/g/SECRETTOKEN"');
  });

  it("carries the invite target into the web fallback (no bare /login bounce)", async () => {
    const res = await request(app).get("/+SECRETCODE").set("Host", LINK_HOST);
    // "Continue on web" must deep-link the web app at the same canonical shape;
    // sending it to /login instead loses the code for already-signed-in users.
    expect(res.text).toContain('"webTarget":"/+SECRETCODE"');
    expect(res.text).not.toContain("/login?returnTo=");
  });

  it("404s a malformed link inside our path space", async () => {
    const res = await request(app).get("/g/").set("Host", LINK_HOST);
    expect(res.status).toBe(404);
  });

  it("hands marketing routes back to the site instead of claiming them", async () => {
    for (const path of ["/terms-of-service", "/privacy-policy", "/about"]) {
      const res = await request(app).get(path).set("Host", LINK_HOST);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain(path);
    }
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
