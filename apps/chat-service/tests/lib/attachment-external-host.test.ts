/**
 * AIM-69 / AIM-41 / AIM-09 — what an attachment is allowed to point at.
 *
 * The guard skipped verification for anything matching `^https?://`, on the
 * reasoning that it was "an external provider — not our object". With no host
 * check, any sender could point an attachment at their own server: every
 * recipient's client fetched attacker-controlled content the moment the message
 * rendered — no magic-byte validation, no antivirus scan, no size cap — and the
 * attacker's host learned each recipient's address, user agent and read timing.
 * The same field reaches push payloads.
 *
 * Separately, URL fields were validated with Zod's plain `.url()`, which
 * applies no scheme constraint, so `javascript:` and `data:` passed; the socket
 * attachment schemas had no URL validation at all.
 */
import {
  isAllowedExternalMediaHost,
  isAllowedExternalMediaUrl,
  isHttpUrl,
} from "@aimess/utils";

import { editMessageSchema } from "../../src/api/validators/private-message.validator.js";
import { editGroupMessageSchema } from "../../src/api/validators/group-message.validator.js";

describe("external media host allowlist", () => {
  it.each([
    "https://media.giphy.com/media/abc/giphy.gif",
    "https://i.giphy.com/abc.gif",
    "https://media.tenor.com/x/y.gif",
    "https://tenor.com/view/abc",
  ])("allows the provider URL %s", (url) => {
    expect(isAllowedExternalMediaUrl(url)).toBe(true);
  });

  it("refuses an arbitrary attacker-controlled host", () => {
    expect(
      isAllowedExternalMediaUrl("https://attacker.example/beacon.png")
    ).toBe(false);
  });

  it("is not fooled by an allowed host appearing as a prefix of another", () => {
    // The check must be on the parsed hostname's suffix boundary, not a
    // substring: otherwise registering `giphy.com.attacker.example` defeats it.
    expect(
      isAllowedExternalMediaUrl("https://giphy.com.attacker.example/x.gif")
    ).toBe(false);
    expect(isAllowedExternalMediaHost("giphy.com.attacker.example")).toBe(
      false
    );
    expect(isAllowedExternalMediaHost("evilgiphy.com")).toBe(false);
  });

  it("refuses a non-http scheme even on an allowed host", () => {
    expect(isAllowedExternalMediaUrl("javascript:alert(1)//giphy.com")).toBe(
      false
    );
    expect(isAllowedExternalMediaUrl("data:text/html,<script>alert(1)")).toBe(
      false
    );
  });

  it("treats an unparseable value as not a URL", () => {
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isAllowedExternalMediaUrl("")).toBe(false);
  });

  it.each([
    "javascript:alert(document.cookie)",
    "data:text/html,<script>",
    "file:///etc/passwd",
  ])("isHttpUrl refuses the dangerous scheme %s", (value) => {
    expect(isHttpUrl(value)).toBe(false);
  });
});

describe("message edit schemas", () => {
  it.each([
    ["private", editMessageSchema],
    ["group", editGroupMessageSchema],
  ])(
    "%s: drops a client-supplied files[] instead of storing it",
    (_l, schema) => {
      // The write primitive behind AIM-09: `files` was persisted wholesale with
      // none of the send path's verification, and the read path re-signs whatever
      // is stored. Both edit paths already refuse anything but a TEXT message, so
      // a legitimate edit never carried attachments.
      const parsed = schema.parse({
        content: {
          text: "edited",
          urls: [],
          files: [{ objectKey: "chat/victim-user/secret.png" }],
        },
      });

      expect(parsed.content).not.toHaveProperty("files");
      expect(JSON.stringify(parsed)).not.toContain("secret.png");
    }
  );

  it.each([
    ["private", editMessageSchema],
    ["group", editGroupMessageSchema],
  ])("%s: still accepts a plain text edit", (_l, schema) => {
    const parsed = schema.parse({ content: { text: "edited", urls: [] } });
    expect(parsed.content.text).toBe("edited");
  });

  it.each([
    ["private", editMessageSchema],
    ["group", editGroupMessageSchema],
  ])("%s: refuses a javascript: URL in urls[]", (_l, schema) => {
    expect(() =>
      schema.parse({
        content: { text: "edited", urls: ["javascript:alert(1)"] },
      })
    ).toThrow();
  });

  it.each([
    ["private", editMessageSchema],
    ["group", editGroupMessageSchema],
  ])("%s: accepts an ordinary https link", (_l, schema) => {
    const parsed = schema.parse({
      content: { text: "see this", urls: ["https://example.com/a"] },
    });
    expect(parsed.content.urls).toEqual(["https://example.com/a"]);
  });
});
