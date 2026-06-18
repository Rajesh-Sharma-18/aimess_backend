/**
 * Unit tests for the socket typing-identity resolver + broadcast builder
 * (`src/sockets/user-details.ts`).
 *
 * These are pure functions over an injected `UserClient` + `MediaClient`, so —
 * like the auth-middleware suite — we exercise them directly against mock
 * clients without booting Socket.IO, Redis, or any gRPC runtime. The shared
 * logger is stubbed globally (tests/setup/global-mocks.ts), so the degraded
 * paths log silently.
 *
 * Contract under test:
 *   - identity is resolved ONCE (one bulkGetUserSnapshots call) and the avatar
 *     is presigned via the media client only when there is a non-empty key;
 *   - every failure mode (null snapshots, missing user, null download, throw)
 *     degrades to a safe shape and NEVER throws;
 *   - `result.userId` is always the input userId (server-authoritative);
 *   - `buildTypingBroadcast` emits the legacy + enriched fields with the
 *     documented senderName fallback and conditional communityId.
 */
import {
  resolveSocketUserDetails,
  buildTypingBroadcast,
  type SocketUserDetails,
} from "../../src/sockets/user-details.js";
import type {
  UserClient,
  UserSnapshotRecord,
} from "../../src/grpc/clients/user.client.js";
import type {
  MediaClient,
  GenerateDownloadUrlGrpcResult,
} from "../../src/grpc/clients/media.client.js";

const USER_ID = "user_abc123";

/** A minimal snapshot record with overridable fields. */
function snapshot(over: Partial<UserSnapshotRecord> = {}): UserSnapshotRecord {
  return {
    userId: USER_ID,
    username: "alice",
    displayName: "Alice",
    avatarObjectKey: "avatars/alice.jpg",
    ...over,
  };
}

/** Build a mock UserClient whose bulkGetUserSnapshots resolves to `snaps`. */
function userClientReturning(snaps: UserSnapshotRecord[] | null): {
  client: UserClient;
  bulk: jest.Mock;
} {
  const bulk = jest.fn(async () => snaps);
  return { client: { bulkGetUserSnapshots: bulk } as UserClient, bulk };
}

/** Build a mock MediaClient whose generateDownloadUrl resolves to `dl`. */
function mediaClientReturning(dl: GenerateDownloadUrlGrpcResult | null): {
  client: MediaClient;
  gen: jest.Mock;
} {
  const gen = jest.fn(async () => dl);
  return {
    client: {
      generateUploadUrl: jest.fn(),
      generateDownloadUrl: gen,
    } as unknown as MediaClient,
    gen,
  };
}

/** A download result whose only field we care about is downloadUrl. */
function downloadResult(url: string): GenerateDownloadUrlGrpcResult {
  return { downloadUrl: url } as unknown as GenerateDownloadUrlGrpcResult;
}

describe("resolveSocketUserDetails", () => {
  // --- HAPPY PATH ----------------------------------------------------------
  it("non-empty avatar key → presigns avatar and returns full identity", async () => {
    const { client: userClient, bulk } = userClientReturning([snapshot()]);
    const { client: mediaClient, gen } = mediaClientReturning(
      downloadResult("https://cdn.aimess.com/avatars/alice.jpg")
    );

    const result = await resolveSocketUserDetails(
      userClient,
      mediaClient,
      USER_ID
    );

    expect(result).toEqual<SocketUserDetails>({
      userId: USER_ID,
      username: "alice",
      displayName: "Alice",
      avatarUrl: "https://cdn.aimess.com/avatars/alice.jpg",
    });
    // Resolved ONCE: a single snapshot fetch.
    expect(bulk).toHaveBeenCalledTimes(1);
    expect(bulk).toHaveBeenCalledWith([USER_ID]);
    // Media presign called with USER_AVATAR category + requester = the user.
    expect(gen).toHaveBeenCalledTimes(1);
    expect(gen).toHaveBeenCalledWith({
      objectKey: "avatars/alice.jpg",
      category: "USER_AVATAR",
      requesterId: USER_ID,
    });
  });

  // --- EMPTY AVATAR KEY ----------------------------------------------------
  it('empty avatar key ("") → media NOT called, avatarUrl null', async () => {
    const { client: userClient } = userClientReturning([
      snapshot({ avatarObjectKey: "" }),
    ]);
    const { client: mediaClient, gen } = mediaClientReturning(
      downloadResult("should-not-be-used")
    );

    const result = await resolveSocketUserDetails(
      userClient,
      mediaClient,
      USER_ID
    );

    expect(result.avatarUrl).toBeNull();
    expect(result.username).toBe("alice");
    expect(result.displayName).toBe("Alice");
    expect(gen).not.toHaveBeenCalled();
  });

  it("whitespace-only avatar key → trimmed to empty, media NOT called", async () => {
    const { client: userClient } = userClientReturning([
      snapshot({ avatarObjectKey: "   " }),
    ]);
    const { client: mediaClient, gen } = mediaClientReturning(
      downloadResult("nope")
    );

    const result = await resolveSocketUserDetails(
      userClient,
      mediaClient,
      USER_ID
    );

    expect(result.avatarUrl).toBeNull();
    expect(gen).not.toHaveBeenCalled();
  });

  // --- DEGRADED: snapshots null --------------------------------------------
  it("bulkGetUserSnapshots returns null → degraded shape, no throw, no media call", async () => {
    const { client: userClient } = userClientReturning(null);
    const { client: mediaClient, gen } = mediaClientReturning(
      downloadResult("nope")
    );

    const result = await resolveSocketUserDetails(
      userClient,
      mediaClient,
      USER_ID
    );

    expect(result).toEqual<SocketUserDetails>({
      userId: USER_ID,
      username: "",
      displayName: "",
      avatarUrl: null,
    });
    expect(gen).not.toHaveBeenCalled();
  });

  it("snapshot for a different user only → degraded (no matching userId)", async () => {
    const { client: userClient } = userClientReturning([
      snapshot({ userId: "someone_else" }),
    ]);
    const { client: mediaClient, gen } = mediaClientReturning(
      downloadResult("nope")
    );

    const result = await resolveSocketUserDetails(
      userClient,
      mediaClient,
      USER_ID
    );

    expect(result).toEqual<SocketUserDetails>({
      userId: USER_ID,
      username: "",
      displayName: "",
      avatarUrl: null,
    });
    expect(gen).not.toHaveBeenCalled();
  });

  it("uses the fallback display name in the degraded shape", async () => {
    const { client: userClient } = userClientReturning(null);
    const { client: mediaClient } = mediaClientReturning(null);

    const result = await resolveSocketUserDetails(
      userClient,
      mediaClient,
      USER_ID,
      "Fallback Name"
    );

    expect(result.displayName).toBe("Fallback Name");
    expect(result.username).toBe("");
    expect(result.avatarUrl).toBeNull();
  });

  // --- DEGRADED: download null ---------------------------------------------
  it("generateDownloadUrl returns null → avatarUrl null but identity intact", async () => {
    const { client: userClient } = userClientReturning([snapshot()]);
    const { client: mediaClient, gen } = mediaClientReturning(null);

    const result = await resolveSocketUserDetails(
      userClient,
      mediaClient,
      USER_ID
    );

    expect(result.avatarUrl).toBeNull();
    expect(result.username).toBe("alice");
    expect(result.displayName).toBe("Alice");
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it("displayName falls back to fallback when snapshot displayName is empty", async () => {
    const { client: userClient } = userClientReturning([
      snapshot({ displayName: "", avatarObjectKey: "" }),
    ]);
    const { client: mediaClient } = mediaClientReturning(null);

    const result = await resolveSocketUserDetails(
      userClient,
      mediaClient,
      USER_ID,
      "Fallback Name"
    );

    expect(result.displayName).toBe("Fallback Name");
    expect(result.username).toBe("alice");
  });

  // --- NEVER THROWS --------------------------------------------------------
  it("bulkGetUserSnapshots throws → degraded shape, swallowed (no throw)", async () => {
    const bulk = jest.fn(async () => {
      throw new Error("breaker open");
    });
    const userClient = { bulkGetUserSnapshots: bulk } as UserClient;
    const { client: mediaClient, gen } = mediaClientReturning(null);

    await expect(
      resolveSocketUserDetails(userClient, mediaClient, USER_ID)
    ).resolves.toEqual<SocketUserDetails>({
      userId: USER_ID,
      username: "",
      displayName: "",
      avatarUrl: null,
    });
    expect(gen).not.toHaveBeenCalled();
  });

  it("generateDownloadUrl throws → degraded shape, swallowed (no throw)", async () => {
    const { client: userClient } = userClientReturning([snapshot()]);
    const gen = jest.fn(async () => {
      throw new Error("media down");
    });
    const mediaClient = {
      generateUploadUrl: jest.fn(),
      generateDownloadUrl: gen,
    } as unknown as MediaClient;

    const result = await resolveSocketUserDetails(
      userClient,
      mediaClient,
      USER_ID
    );

    // Falls all the way back to degraded (the catch wraps the whole resolve).
    expect(result).toEqual<SocketUserDetails>({
      userId: USER_ID,
      username: "",
      displayName: "",
      avatarUrl: null,
    });
  });

  // --- userId always the input ---------------------------------------------
  it("result.userId always === input userId, even on every degraded path", async () => {
    const cases: Array<() => Promise<SocketUserDetails>> = [
      () =>
        resolveSocketUserDetails(
          userClientReturning([snapshot()]).client,
          mediaClientReturning(downloadResult("u")).client,
          USER_ID
        ),
      () =>
        resolveSocketUserDetails(
          userClientReturning(null).client,
          mediaClientReturning(null).client,
          USER_ID
        ),
      () =>
        resolveSocketUserDetails(
          userClientReturning([snapshot({ userId: "x" })]).client,
          mediaClientReturning(null).client,
          USER_ID
        ),
    ];
    for (const run of cases) {
      const r = await run();
      expect(r.userId).toBe(USER_ID);
    }
  });
});

describe("buildTypingBroadcast", () => {
  const details: SocketUserDetails = {
    userId: USER_ID,
    username: "alice",
    displayName: "Alice",
    avatarUrl: "https://cdn.aimess.com/avatars/alice.jpg",
  };
  const TS = 1749465610000; // epoch ms — typing broadcasts carry a NUMBER

  it("includes legacy + enriched fields (chat shape, no communityId)", () => {
    const out = buildTypingBroadcast(USER_ID, details, "conv1", TS);

    expect(out).toEqual({
      conversationId: "conv1",
      userId: USER_ID,
      userDetails: details,
      timestamp: TS,
      senderName: "Alice", // == displayName
    });
    // No communityId key when not provided.
    expect("communityId" in out).toBe(false);
  });

  it("senderName = displayName even when a client senderName is supplied", () => {
    const out = buildTypingBroadcast(USER_ID, details, "conv1", TS, {
      senderName: "ClientTyped",
    });
    expect(out.senderName).toBe("Alice");
  });

  it("senderName falls back to the client value only when displayName is empty", () => {
    const noName: SocketUserDetails = { ...details, displayName: "" };
    const out = buildTypingBroadcast(USER_ID, noName, "conv1", TS, {
      senderName: "ClientTyped",
    });
    expect(out.senderName).toBe("ClientTyped");
  });

  it("senderName is '' when both displayName and client senderName are empty", () => {
    const noName: SocketUserDetails = { ...details, displayName: "" };
    const out = buildTypingBroadcast(USER_ID, noName, "conv1", TS);
    expect(out.senderName).toBe("");
  });

  it("includes communityId only when provided (and conversationId == communityId)", () => {
    const out = buildTypingBroadcast(USER_ID, details, "comm1", TS, {
      communityId: "comm1",
    });
    expect(out).toEqual({
      conversationId: "comm1",
      communityId: "comm1",
      userId: USER_ID,
      userDetails: details,
      timestamp: TS,
      senderName: "Alice",
    });
  });

  it("timestamp passes through verbatim as an epoch-ms number", () => {
    const now = Date.now();
    const out = buildTypingBroadcast(USER_ID, details, "conv1", now);
    expect(out.timestamp).toBe(now);
    expect(typeof out.timestamp).toBe("number");
  });
});
