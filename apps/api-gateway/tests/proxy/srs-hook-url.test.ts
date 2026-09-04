/**
 * SRS_HOOK_SECRET must not travel in the URL of the upstream call.
 *
 * SRS's `http_hooks` cannot set request headers, so the shared secret can only
 * reach this gateway in the hook URL's query string. A query string is written
 * down by every hop that logs a URL — reverse proxy, CDN, APM — so the gateway
 * strips it before forwarding and re-attaches it as `x-srs-secret` (which
 * stream-service already accepts). Every other query parameter is preserved,
 * because stream-service reads them.
 */
import type { Request } from "express";

import { srsHookUrl } from "../../src/routes/internal-srs.routes.js";

function reqWith(originalUrl: string): Request {
  return { originalUrl } as Request;
}

describe("srsHookUrl", () => {
  it("strips `secret` from the forwarded query", () => {
    const url = srsHookUrl(reqWith("/internal/srs/hooks?secret=super-secret"));

    expect(url).not.toContain("super-secret");
    expect(url).not.toContain("secret=");
    expect(url).toMatch(/\/internal\/srs\/hooks$/);
  });

  it("keeps every other parameter", () => {
    const url = srsHookUrl(
      reqWith("/internal/srs/hooks?vhost=abr&secret=super-secret&app=live")
    );

    expect(url).toContain("vhost=abr");
    expect(url).toContain("app=live");
    expect(url).not.toContain("super-secret");
  });

  it("handles a request with no query at all", () => {
    expect(srsHookUrl(reqWith("/internal/srs/hooks"))).toMatch(
      /\/internal\/srs\/hooks$/
    );
  });

  it("strips a repeated secret parameter", () => {
    const url = srsHookUrl(
      reqWith("/internal/srs/hooks?secret=a&secret=b&app=live")
    );

    expect(url).not.toContain("secret=");
    expect(url).toContain("app=live");
  });
});
