/**
 * FRIENDSHIP SEND-GATE vs. THE LOSSY READ MODEL.
 *
 * chat-service gates private sends on its OWN `friendship` collection, which is event-sourced
 * off `user.events`. That copy is lossy: a dropped message, a consumer that was down, or a
 * friendship accepted before the read-model path existed all leave NO row — which is
 * indistinguishable from "not friends". Meanwhile the conversation list reads user-service
 * directly, so the UI shows "friend" while every send 403s CHAT_FRIENDSHIP_REQUIRED.
 *
 * The gate must therefore never deny on a local MISS alone. It must confirm upstream, and it
 * must NOT confirm past a local BLOCK.
 */
const status = jest.fn<Promise<string | null>, [string, string]>();
const create = jest.fn<Promise<void>, [string, string, string?]>();
jest.mock("../../src/repositories/friendship.repository.js", () => ({
  FriendshipRepository: jest.fn().mockImplementation(() => ({
    getFriendshipStatus: (a: string, b: string) => status(a, b),
    createFriendship: (a: string, b: string, s?: string) => create(a, b, s),
  })),
}));

const checkFriendships = jest.fn();
jest.mock("../../src/grpc/user-snapshot.client.js", () => ({
  userGrpcClient: {
    checkFriendships: (caller: string, ids: string[]) =>
      checkFriendships(caller, ids),
  },
}));

import { createUserServiceClient } from "../../src/grpc/user.client.js";

const A = "da131102-aa18-4a39-9da1-606b20b36fdf";
const B = "e883bbfc-6c87-42c0-aa81-1e84fa24d548";

// The deny cache is MODULE-scoped by design (one per process, not per client), so it
// outlives any single test. Every test therefore mints its own pair — sharing ids would
// let one test's cached denial silently decide the next one's outcome.
let seq = 0;
function freshPair(): [string, string] {
  seq += 1;
  return [`${A}-${seq}`, `${B}-${seq}`];
}

const upstream = (peer: string, s: string) =>
  new Map([[peer, { status: s, direction: null }]]);

beforeEach(() => {
  status.mockReset();
  create.mockReset().mockResolvedValue(undefined);
  checkFriendships.mockReset();
});

describe("checkFriendship", () => {
  it("local ACTIVE short-circuits — no upstream call on the hot path", async () => {
    const [a, b] = freshPair();
    status.mockResolvedValue("ACTIVE");

    await expect(createUserServiceClient().checkFriendship(a, b)).resolves.toBe(
      true
    );
    expect(checkFriendships).not.toHaveBeenCalled();
  });

  it("REGRESSION: a real friend missing from the read model can still send", async () => {
    const [a, b] = freshPair();
    status.mockResolvedValue(null); // the lossy gap
    checkFriendships.mockResolvedValue(upstream(b, "FRIEND"));

    await expect(createUserServiceClient().checkFriendship(a, b)).resolves.toBe(
      true
    );
  });

  it("heals the read model in BOTH directions after confirming upstream", async () => {
    const [a, b] = freshPair();
    status.mockResolvedValue(null);
    checkFriendships.mockResolvedValue(upstream(b, "FRIEND"));

    await createUserServiceClient().checkFriendship(a, b);

    expect(create).toHaveBeenCalledWith(a, b, "ACTIVE");
    expect(create).toHaveBeenCalledWith(b, a, "ACTIVE");
  });

  it("a genuine non-friend is still denied", async () => {
    const [a, b] = freshPair();
    status.mockResolvedValue(null);
    checkFriendships.mockResolvedValue(upstream(b, "NONE"));

    await expect(createUserServiceClient().checkFriendship(a, b)).resolves.toBe(
      false
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("a local BLOCK is a decision, not a gap — never healed past", async () => {
    const [a, b] = freshPair();
    status.mockResolvedValue("BLOCKED");
    checkFriendships.mockResolvedValue(upstream(b, "FRIEND"));

    await expect(createUserServiceClient().checkFriendship(a, b)).resolves.toBe(
      false
    );
    expect(checkFriendships).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("an inconclusive upstream (transport down ⇒ empty map) fails OPEN, not closed", async () => {
    const [a, b] = freshPair();
    status.mockResolvedValue(null);
    checkFriendships.mockResolvedValue(new Map());

    await expect(createUserServiceClient().checkFriendship(a, b)).resolves.toBe(
      true
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe("checkFriendship — deny cache (load protection)", () => {
  it("a retried send against a confirmed non-friend does NOT re-hit user-service", async () => {
    const [a, b] = freshPair();
    status.mockResolvedValue(null);
    checkFriendships.mockResolvedValue(upstream(b, "NONE"));
    const client = createUserServiceClient();

    await expect(client.checkFriendship(a, b)).resolves.toBe(false);
    await expect(client.checkFriendship(a, b)).resolves.toBe(false);
    await expect(client.checkFriendship(a, b)).resolves.toBe(false);

    // Three rejected sends, ONE upstream call — this is the amplification guard.
    expect(checkFriendships).toHaveBeenCalledTimes(1);
  });

  it("an INCONCLUSIVE upstream is never cached — the next attempt retries", async () => {
    const [a, b] = freshPair();
    status.mockResolvedValue(null);
    checkFriendships.mockResolvedValue(new Map()); // transport down
    const client = createUserServiceClient();

    await client.checkFriendship(a, b);
    await client.checkFriendship(a, b);

    // Caching a transport failure would lock a real friend out for the whole TTL.
    expect(checkFriendships).toHaveBeenCalledTimes(2);
  });

  it("a later-accepted friendship is NOT held back by a cached denial", async () => {
    const [a, b] = freshPair();
    status.mockResolvedValue(null);
    checkFriendships.mockResolvedValue(upstream(b, "NONE"));
    const client = createUserServiceClient();
    await expect(client.checkFriendship(a, b)).resolves.toBe(false);

    // Request accepted → the consumer writes the ACTIVE row. The local fast path is
    // checked BEFORE the deny cache, so the stale denial can never win.
    status.mockResolvedValue("ACTIVE");
    await expect(client.checkFriendship(a, b)).resolves.toBe(true);
  });
});
