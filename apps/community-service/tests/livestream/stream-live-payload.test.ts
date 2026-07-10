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
