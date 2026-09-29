/**
 * The FINAL username assignment, not the availability check.
 *
 * Availability is advisory — it answers about a row that does not exist yet, so two
 * registrations can both be told "free" and both go on to insert. What decides ownership is
 * the unique index on `user_profiles.username`, and the only correct behaviour on losing that
 * race is to take the next candidate, never to overwrite the winner.
 *
 * So this suite mocks the repository as a FAKE UNIQUE INDEX (a set of claimed handles that
 * raises a real P2002) and runs the REAL `usernameService` generation on top of it, rather
 * than stubbing the generator the way the name-seeding suite does. Everything under test —
 * derivation, the `_N` walk, the retry loop, the bound — actually executes.
 */
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findByUserId: jest.fn(),
    findByUsername: jest.fn(),
    createFromRegistration: jest.fn(),
    clearAccountValue: jest.fn(),
  },
}));
jest.mock("../../src/messaging/publish-profile-updated.js", () => ({
  publishProfileUpdatedSafe: jest.fn(),
}));
jest.mock("../../src/lib/user-cache.js", () => ({
  userCache: {
    // Cold on every read, so the real DB branches run instead of a cached verdict.
    getUsernameTaken: jest.fn(async () => null),
    markUsernameTaken: jest.fn(async () => undefined),
    getUsernameAvailability: jest.fn(async () => null),
    setUsernameAvailability: jest.fn(async () => undefined),
    invalidateUsernameAvailability: jest.fn(async () => undefined),
    onUsernameClaimed: jest.fn(async () => undefined),
    onUsernameReleased: jest.fn(async () => undefined),
    invalidateProfile: jest.fn(async () => undefined),
  },
  toCachedProfileRecord: jest.fn(),
  fromCachedProfileRecord: jest.fn(),
}));

import type { UserCreatedPayload } from "@aimess/shared-types";

import { Prisma } from "../../src/generated/prisma/client.js";
import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";
import { userProfileService } from "../../src/services/user-profile.service.js";

const repo = userProfileRepository as unknown as Record<string, jest.Mock>;

const uniqueViolation = (field: string) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: [field] },
  });

/** Handles already owned by somebody — the fake unique index. */
let claimed: Map<string, string>;

const event = (userId: string, account = "viddhi-vasu"): UserCreatedPayload => ({
  userId,
  account,
  email: `${userId}@example.com`,
  createdAt: "2026-09-28T00:00:00.000Z",
});

/** The usernames `createFromRegistration` was actually asked to insert, in order. */
const attempted = () =>
  repo.createFromRegistration.mock.calls.map(
    (call) => (call[0] as { username: string }).username
  );

beforeEach(() => {
  jest.clearAllMocks();
  claimed = new Map();
  repo.findByUserId.mockResolvedValue(null);
  repo.findByUsername.mockImplementation(async (username: string) => {
    const owner = claimed.get(username);
    return owner ? { userId: owner, username } : null;
  });
  repo.createFromRegistration.mockImplementation(
    async ({ userId, username }: { userId: string; username: string }) => {
      if (claimed.has(username)) throw uniqueViolation("username");
      claimed.set(username, userId);
      return { userId, username };
    }
  );
});

describe("generated username — concurrent claim", () => {
  it("gives the handle to whoever inserts first", async () => {
    await userProfileService.createFromUserCreatedEvent(event("user-a"));
    expect(claimed.get("viddhi_vasu")).toBe("user-a");
  });

  /**
   * Both registrations derived `viddhi_vasu` and both were told it was free. A wins. B's
   * insert raises P2002, and B must complete on a regenerated handle — no error surfaced to
   * the user, and A's row untouched.
   */
  it("regenerates and completes when the candidate was claimed mid-flight", async () => {
    await userProfileService.createFromUserCreatedEvent(event("user-a"));

    // B derived its candidate BEFORE A's insert landed: force the stale "free" answer once.
    repo.findByUsername.mockImplementationOnce(async () => null);

    await expect(
      userProfileService.createFromUserCreatedEvent(event("user-b"))
    ).resolves.toBeUndefined();

    expect(attempted()).toEqual(["viddhi_vasu", "viddhi_vasu", "viddhi_vasu_2"]);
    expect(claimed.get("viddhi_vasu")).toBe("user-a");
    expect(claimed.get("viddhi_vasu_2")).toBe("user-b");
  });

  /** The regenerated candidate can lose too. The retry has to survive that, repeatedly. */
  it("survives a second and third consecutive collision", async () => {
    claimed.set("viddhi_vasu", "user-a");
    claimed.set("viddhi_vasu_2", "user-b");
    claimed.set("viddhi_vasu_3", "user-c");
    // Every candidate reads as free right up to the insert — three losses in a row.
    repo.findByUsername
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => null);

    await expect(
      userProfileService.createFromUserCreatedEvent(event("user-d"))
    ).resolves.toBeUndefined();

    expect(claimed.get("viddhi_vasu_4")).toBe("user-d");
    expect(claimed.get("viddhi_vasu")).toBe("user-a");
    expect(claimed.get("viddhi_vasu_2")).toBe("user-b");
    expect(claimed.get("viddhi_vasu_3")).toBe("user-c");
  });

  /** Never an unbounded retry loop: it gives up, loudly, so the message can be redelivered. */
  it("gives up after a bounded number of attempts instead of spinning", async () => {
    repo.findByUsername.mockResolvedValue(null);
    repo.createFromRegistration.mockRejectedValue(uniqueViolation("username"));

    await expect(
      userProfileService.createFromUserCreatedEvent(event("user-x"))
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(repo.createFromRegistration).toHaveBeenCalledTimes(5);
  });

  /** A redelivered `user.created` must not create a second profile for the same person. */
  it("is idempotent when the same user is created twice concurrently", async () => {
    await userProfileService.createFromUserCreatedEvent(event("user-a"));

    repo.findByUserId.mockResolvedValue(null);
    repo.createFromRegistration.mockRejectedValueOnce(uniqueViolation("userId"));

    await expect(
      userProfileService.createFromUserCreatedEvent(event("user-a"))
    ).resolves.toBeUndefined();
    // Only user-a's original handle exists; no `_2` was minted for the duplicate.
    expect([...claimed.keys()]).toEqual(["viddhi_vasu"]);
  });

  /**
   * Different sign-up paths (password / Google / Apple) reach the same assignment code, so a
   * cross-provider race is the same race. Two accounts that normalize to the SAME base — the
   * charset rule maps `.` and `-` onto `_` — must still end up with different handles.
   */
  it("keeps handles unique across providers whose accounts normalize alike", async () => {
    await userProfileService.createFromUserCreatedEvent(
      event("user-google", "viddhi.vasu")
    );
    await userProfileService.createFromUserCreatedEvent(
      event("user-apple", "Viddhi-Vasu")
    );

    expect(claimed.get("viddhi_vasu")).toBe("user-google");
    expect(claimed.get("viddhi_vasu_2")).toBe("user-apple");
  });
});
