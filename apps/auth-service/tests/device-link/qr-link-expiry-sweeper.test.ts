/**
 * Scheduler-driven QR-link expiry sweep (replaces the old in-process
 * setTimeout — see jobs/qr-link-expiry-sweeper.ts). Exercises exactly one
 * tick via `runQrLinkExpirySweepOnce`, with the Redis store + socket publish
 * + audit persistence all mocked at the I/O boundary.
 */
jest.mock("../../src/lib/device-link-store.js", () => ({
  scanLiveLinkTokens: jest.fn(),
  markExpiredAtomic: jest.fn(),
}));
jest.mock("../../src/services/audit.service.js", () => ({
  recordAuditEventSafe: jest.fn(),
}));
jest.mock("@aimess/redis", () => ({
  ...jest.requireActual("@aimess/redis"),
  publishQrLinkEvent: jest.fn(async () => 1),
}));

import {
  markExpiredAtomic,
  scanLiveLinkTokens,
} from "../../src/lib/device-link-store.js";
import { recordAuditEventSafe } from "../../src/services/audit.service.js";
import { publishQrLinkEvent } from "@aimess/redis";
import { runQrLinkExpirySweepOnce } from "../../src/jobs/qr-link-expiry-sweeper.js";

const scanTokens = scanLiveLinkTokens as unknown as jest.Mock;
const markExpired = markExpiredAtomic as unknown as jest.Mock;
const publish = publishQrLinkEvent as unknown as jest.Mock;
const audit = recordAuditEventSafe as unknown as jest.Mock;

describe("QR link expiry sweeper", () => {
  beforeEach(() => {
    scanTokens.mockReset();
    markExpired.mockReset();
    publish.mockClear();
    audit.mockClear();
  });

  it("publishes auth:qr:expired + records an audit event for each newly-claimed session", async () => {
    scanTokens.mockResolvedValue(["token-a", "token-b"]);
    markExpired.mockImplementation(async (token: string) =>
      token === "token-a" ? "OK" : "NOT_YET"
    );

    await runQrLinkExpirySweepOnce();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      "token-a",
      "auth:qr:expired",
      { linkToken: "token-a" }
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: "QR_EXPIRED", targetId: "token-a" })
    );
  });

  it("skips sessions the atomic claim reports as ALREADY (another replica won the race)", async () => {
    scanTokens.mockResolvedValue(["token-c"]);
    markExpired.mockResolvedValue("ALREADY");

    await runQrLinkExpirySweepOnce();

    expect(publish).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("skips NOT_FOUND (key already garbage-collected by Redis TTL)", async () => {
    scanTokens.mockResolvedValue(["token-d"]);
    markExpired.mockResolvedValue("NOT_FOUND");

    await runQrLinkExpirySweepOnce();

    expect(publish).not.toHaveBeenCalled();
  });

  it("is a no-op when there are no live sessions", async () => {
    scanTokens.mockResolvedValue([]);

    await runQrLinkExpirySweepOnce();

    expect(markExpired).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
