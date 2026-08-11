/**
 * communityService.bulkMute — the sidebar's multi-select "Mute".
 *
 * Regression: the bulk path used to skip any community that already had a
 * `CommunityMuteSetting` ROW, treating "row exists" as "already muted". A row
 * is not a mute (see `isMuteRowActive`): a lapsed temp-mute leaves its row
 * behind and touching the per-kind notification toggles creates one. Both read
 * as un-muted everywhere else, so bulk Mute silently did nothing for them.
 *
 * The contract asserted here is parity with the single-community path
 * (`setMute`): UPSERT for every ACTIVE membership, skip only non-members.
 */
import { communityRepository } from "../../src/repositories/community.repository.js";
import { communityService } from "../../src/services/community.service.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;

const A = "a".repeat(24);
const B = "b".repeat(24);
const C = "c".repeat(24);
const CALLER = "11111111-1111-4111-8111-111111111111";

describe("communityService.bulkMute", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Not in tests/setup/global-mocks.ts' hand-listed repo surface — added here
    // rather than growing that list for two call sites.
    repo.findActiveMembershipsByCommunityIds = jest.fn();
    repo.upsertMute = jest.fn().mockResolvedValue({ mutedUntil: null });
  });

  it("mutes a community whose mute row exists but has EXPIRED", async () => {
    repo.findActiveMembershipsByCommunityIds.mockResolvedValue([
      { communityId: A },
    ]);

    const result = await communityService.bulkMute(CALLER, [A], null);

    expect(result).toEqual({ muted: [A], skipped: [] });
    expect(repo.upsertMute).toHaveBeenCalledWith(CALLER, A, null);
  });

  it("re-mutes an already-muted community (idempotent) and applies the new duration", async () => {
    repo.findActiveMembershipsByCommunityIds.mockResolvedValue([
      { communityId: A },
      { communityId: B },
    ]);

    const result = await communityService.bulkMute(CALLER, [A, B], 60);

    expect(result.muted).toEqual([A, B]);
    expect(repo.upsertMute).toHaveBeenCalledTimes(2);
    for (const call of repo.upsertMute.mock.calls) {
      expect(call[2]).toBeInstanceOf(Date);
      expect((call[2] as Date).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("skips only the ids the caller is not an ACTIVE member of", async () => {
    repo.findActiveMembershipsByCommunityIds.mockResolvedValue([
      { communityId: A },
      { communityId: C },
    ]);

    const result = await communityService.bulkMute(CALLER, [A, B, C], null);

    expect(result).toEqual({ muted: [A, C], skipped: [B] });
    expect(repo.upsertMute).toHaveBeenCalledTimes(2);
  });
});
