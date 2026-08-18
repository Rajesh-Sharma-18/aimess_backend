/**
 * `sourceUrl` is broadcaster-supplied and every client — website, Android, iOS
 * and the backoffice livestream monitor — renders it in a player or an iframe.
 * A `javascript:` value stored here is therefore stored XSS against whoever
 * opens the stream, executing in the embedder's origin. This validator is the
 * single point of entry, so the scheme check has to hold here.
 */
import { createStreamSchema } from "../../src/api/validators/index.js";

const base = {
  communityId: "C-1",
  title: "Test stream",
  sourceType: "URL" as const,
};

describe("createStreamSchema.sourceUrl", () => {
  it.each([
    ["javascript:alert(1)"],
    ["JavaScript:fetch('https://evil.tld')"],
    ["data:text/html;base64,PHNjcmlwdD4x"],
    ["vbscript:msgbox(1)"],
    ["file:///etc/passwd"],
    // Scheme-less: `new URL` throws, and a raw relative string in an iframe
    // src makes the panel frame itself.
    ["example.com/live.m3u8"],
    ["//evil.tld/live"],
  ])("rejects %s", (sourceUrl) => {
    expect(createStreamSchema.safeParse({ ...base, sourceUrl }).success).toBe(
      false
    );
  });

  it.each([
    ["https://www.youtube.com/watch?v=abc123"],
    ["http://10.0.0.5:8080/live/stream.m3u8"],
    ["https://cdn.example.com/live/index.m3u8?token=x"],
  ])("accepts %s", (sourceUrl) => {
    expect(createStreamSchema.safeParse({ ...base, sourceUrl }).success).toBe(
      true
    );
  });

  it("still allows sourceUrl to be omitted for SRS-ingested streams", () => {
    const parsed = createStreamSchema.safeParse({
      communityId: "C-1",
      title: "Phone stream",
      sourceType: "PHONE_CAMERA",
    });
    expect(parsed.success).toBe(true);
  });
});
