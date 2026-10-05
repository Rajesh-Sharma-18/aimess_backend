/**
 * Tests that buildStreamSocketPayload correctly includes liveStreamCount in
 * the community:stream:started and community:stream:ended personal fan-out payloads.
 */
import { buildStreamSocketPayload } from "../../src/consumers/stream-live.consumer.js";

const CID = "a".repeat(24);
const SID = "b".repeat(24);

describe("buildStreamSocketPayload — stream:started", () => {
  it("includes liveStreamCount from the event data", () => {
    const payload = buildStreamSocketPayload("stream.started", {
      streamId: SID,
      communityId: CID,
      creatorId: "creator-1",
      status: "LIVE",
      startedAt: 1_750_000_000_000,
      liveStreamCount: 3,
    });

    expect(payload.liveStreamCount).toBe(3);
    expect(payload.communityId).toBe(CID);
    expect(payload.streamId).toBe(SID);
    expect(payload.hasActiveLivestream).toBe(true);
  });

  it("defaults liveStreamCount to 1 when absent", () => {
    const payload = buildStreamSocketPayload("stream.started", {
      streamId: SID,
      communityId: CID,
      creatorId: "creator-1",
    });

    expect(payload.liveStreamCount).toBe(1);
  });

  // The personal fan-out must carry the same creator fields as stream-service's
  // room broadcast, or a sidebar client can't gate the admin force-end button.
  it.each([
    ["moderator, display name", { role: "MODERATOR", status: "ACTIVE", snapshotDisplayName: "Mod", snapshotUsername: "mod_u" }, "MODERATOR", "Mod"],
    ["admin, username fallback", { role: "ADMIN", status: "ACTIVE", snapshotDisplayName: "", snapshotUsername: "adm_u" }, "ADMIN", "adm_u"],
    ["no longer a host (MEMBER)", { role: "MEMBER", status: "ACTIVE", snapshotDisplayName: "", snapshotUsername: "" }, null, ""],
    ["left the community", { role: "MODERATOR", status: "LEFT", snapshotDisplayName: "Mod", snapshotUsername: "m" }, null, "Mod"],
  ])("carries creatorId/creatorRole/creatorName — %s", (_l, member, role, name) => {
    const payload = buildStreamSocketPayload(
      "stream.started",
      { streamId: SID, communityId: CID, creatorId: "creator-1" },
      member
    );

    expect(payload).toMatchObject({
      creatorId: "creator-1",
      creatorRole: role,
      creatorName: name,
    });
  });

  it("an unresolved host degrades to null / '' instead of dropping the event", () => {
    const payload = buildStreamSocketPayload(
      "stream.started",
      { streamId: SID, communityId: CID, creatorId: "creator-1" },
      null
    );

    expect(payload).toMatchObject({ creatorRole: null, creatorName: "" });
  });
});

describe("buildStreamSocketPayload — stream:ended", () => {
  it("includes liveStreamCount from the event data", () => {
    const payload = buildStreamSocketPayload("stream.ended", {
      streamId: SID,
      communityId: CID,
      creatorId: "creator-1",
      endedAt: 1_750_000_500_000,
      peakViewers: 10,
      liveStreamCount: 2,
    });

    expect(payload.liveStreamCount).toBe(2);
    expect(payload.communityId).toBe(CID);
    expect(payload.streamId).toBe(SID);
  });

  it("defaults liveStreamCount to 0 when absent", () => {
    const payload = buildStreamSocketPayload("stream.ended", {
      streamId: SID,
      communityId: CID,
      creatorId: "creator-1",
      endedAt: 1_750_000_500_000,
      peakViewers: 0,
    });

    expect(payload.liveStreamCount).toBe(0);
  });
});
