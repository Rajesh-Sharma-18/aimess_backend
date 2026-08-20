/**
 * Unit tests for the per-user invite-link rate limiter.
 *
 * The limiter is a Redis fixed-window counter that gates invite-link CREATE and
 * BULK-SEND now that any active member can call those endpoints. It MUST:
 *   - allow calls up to the configured per-window cap, then throw 429;
 *   - arm a TTL on the first hit so the window self-expires;
 *   - fail OPEN when the cache is unavailable or Redis errors (never block an
 *     already-authorized member on an infra blip).
 *
 * The global setup mocks config/redis with `isCommunityCacheReady → false`
 * (so the limiter is a no-op in every functional test); here we override that
 * module with a READY fake to exercise the counting logic directly.
 */

const mockIncr = jest.fn();
const mockExpire = jest.fn(async () => 1);
let mockReady = true;

// The global setup stubs the limiter itself to a resolved no-op so functional
// suites are never throttled. That also made every assertion here vacuous, so
// restore the real module — the Redis fake below is what this suite controls.
jest.mock("../../src/lib/invite-rate-limit.js", () =>
  jest.requireActual("../../src/lib/invite-rate-limit.js")
);

jest.mock("../../src/config/redis.js", () => ({
  redis: {
    incr: (key: string) => mockIncr(key),
    expire: (key: string, sec: number) => mockExpire(key, sec),
  },
  isCommunityCacheReady: () => mockReady,
  connectCommunityRedis: jest.fn(),
  disableCommunityCache: jest.fn(),
}));

import {
  assertInviteCreateRateLimit,
  assertInviteBulkSendRateLimit,
} from "../../src/lib/invite-rate-limit.js";
import { TooManyRequestsError } from "@aimess/errors";

const USER = "99999999-9999-4999-8999-999999999999";

beforeEach(() => {
  jest.clearAllMocks();
  mockReady = true;
  mockExpire.mockResolvedValue(1);
});

describe("invite-link rate limiter — create (cap 20/window)", () => {
  it("arms a TTL on the first hit and allows the call", async () => {
    mockIncr.mockResolvedValue(1);

    await expect(assertInviteCreateRateLimit(USER)).resolves.toBeUndefined();
    expect(mockIncr).toHaveBeenCalledWith(`community:invite-rl:create:${USER}`);
    expect(mockExpire).toHaveBeenCalledWith(
      `community:invite-rl:create:${USER}`,
      3600
    );
  });

  it("allows the call exactly AT the cap (count === limit)", async () => {
    mockIncr.mockResolvedValue(20);
    await expect(assertInviteCreateRateLimit(USER)).resolves.toBeUndefined();
    expect(mockExpire).not.toHaveBeenCalled(); // TTL only armed on the first hit
  });

  it("throws 429 once the cap is exceeded (count > limit)", async () => {
    mockIncr.mockResolvedValue(21);
    await expect(assertInviteCreateRateLimit(USER)).rejects.toBeInstanceOf(
      TooManyRequestsError
    );
    await expect(assertInviteCreateRateLimit(USER)).rejects.toThrow(
      "COMMUNITY_INVITE_LINK_RATE_LIMITED"
    );
  });
});

describe("invite-link rate limiter — bulk-send (cap 10/window)", () => {
  it("uses a separate per-user key", async () => {
    mockIncr.mockResolvedValue(1);
    await assertInviteBulkSendRateLimit(USER);
    expect(mockIncr).toHaveBeenCalledWith(`community:invite-rl:bulk:${USER}`);
  });

  it("throws 429 above the bulk cap (count > 10)", async () => {
    mockIncr.mockResolvedValue(11);
    await expect(assertInviteBulkSendRateLimit(USER)).rejects.toBeInstanceOf(
      TooManyRequestsError
    );
  });

  it("allows AT the bulk cap (count === 10)", async () => {
    mockIncr.mockResolvedValue(10);
    await expect(assertInviteBulkSendRateLimit(USER)).resolves.toBeUndefined();
  });
});

describe("invite-link rate limiter — fail open", () => {
  it("is a no-op when the cache is not ready (never touches Redis)", async () => {
    mockReady = false;
    mockIncr.mockResolvedValue(999); // would be way over the cap if consulted

    await expect(assertInviteCreateRateLimit(USER)).resolves.toBeUndefined();
    expect(mockIncr).not.toHaveBeenCalled();
  });

  it("fails open (allows) when Redis itself errors", async () => {
    mockIncr.mockRejectedValue(new Error("ECONNRESET"));

    await expect(assertInviteCreateRateLimit(USER)).resolves.toBeUndefined();
  });
});
