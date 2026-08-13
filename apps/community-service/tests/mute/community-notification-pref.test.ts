/**
 * Unit coverage for the community notification-pref oracle that powers the
 * notifications-service push gate (FCM + inbox). Subject under test:
 * `resolveCommunityNotificationPrefEnabled(communityId, userId, field)`.
 *
 * Contract under test:
 *   - Non-ACTIVE membership (LEFT / BANNED / PENDING / null) → enabled=false
 *     even when a mute-setting row still has the field toggled on.
 *   - ACTIVE + no mute-setting row → enabled=true (implicit defaults).
 *   - ACTIVE + unlapsed TIMED mute (`mutedUntil` in the future) → enabled=false.
 *   - Otherwise → the requested field's boolean. `mutedUntil = null` is NOT a
 *     mute; row existence alone must never suppress anything.
 *
 * The global prisma stub (`tests/setup/global-mocks.ts`) is `{}`; we re-mock
 * the repository seam so membership + mute-setting lookups are controllable
 * without a live DB.
 */

const findMembership = jest.fn();
const findMuteByUserAndCommunity = jest.fn();

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findMembership,
    findMuteByUserAndCommunity,
  },
}));

import { CommunityMemberStatus } from "../../src/generated/prisma/index.js";
import { resolveCommunityNotificationPrefEnabled } from "../../src/lib/community-notification-pref.js";

const CID = "a".repeat(24);
const UID = "11111111-1111-4111-8111-111111111111";

describe("resolveCommunityNotificationPrefEnabled — ACTIVE membership gate", () => {
  beforeEach(() => {
    findMembership.mockReset();
    findMuteByUserAndCommunity.mockReset();
  });

  it("returns false when there is no membership row", async () => {
    findMembership.mockResolvedValue(null);

    await expect(
      resolveCommunityNotificationPrefEnabled(CID, UID, "chatEnabled")
    ).resolves.toBe(false);
    expect(findMuteByUserAndCommunity).not.toHaveBeenCalled();
  });

  it.each([
    CommunityMemberStatus.LEFT,
    CommunityMemberStatus.BANNED,
    CommunityMemberStatus.PENDING,
  ])("returns false when membership status is %s", async (status) => {
    findMembership.mockResolvedValue({ status });
    findMuteByUserAndCommunity.mockResolvedValue({
      chatEnabled: true,
      streamEnabled: true,
      announcementEnabled: true,
    });

    await expect(
      resolveCommunityNotificationPrefEnabled(CID, UID, "chatEnabled")
    ).resolves.toBe(false);
    expect(findMuteByUserAndCommunity).not.toHaveBeenCalled();
  });

  it("ACTIVE + no mute-setting row → enabled=true (implicit defaults)", async () => {
    findMembership.mockResolvedValue({ status: CommunityMemberStatus.ACTIVE });
    findMuteByUserAndCommunity.mockResolvedValue(null);

    await expect(
      resolveCommunityNotificationPrefEnabled(CID, UID, "chatEnabled")
    ).resolves.toBe(true);
  });

  it("ACTIVE + chatEnabled=false → enabled=false for chatEnabled", async () => {
    findMembership.mockResolvedValue({ status: CommunityMemberStatus.ACTIVE });
    findMuteByUserAndCommunity.mockResolvedValue({
      chatEnabled: false,
      streamEnabled: true,
      announcementEnabled: true,
    });

    await expect(
      resolveCommunityNotificationPrefEnabled(CID, UID, "chatEnabled")
    ).resolves.toBe(false);
  });

  it("ACTIVE + streamEnabled=true → enabled=true for streamEnabled", async () => {
    findMembership.mockResolvedValue({ status: CommunityMemberStatus.ACTIVE });
    findMuteByUserAndCommunity.mockResolvedValue({
      chatEnabled: false,
      streamEnabled: true,
      announcementEnabled: false,
    });

    await expect(
      resolveCommunityNotificationPrefEnabled(CID, UID, "streamEnabled")
    ).resolves.toBe(true);
  });

  it("LEFT member with leftover prefs still chatEnabled=true → still false", async () => {
    // Regression: mute-setting rows are not deleted on leave, so a naive
    // preference-only check would keep pushing to former members.
    findMembership.mockResolvedValue({ status: CommunityMemberStatus.LEFT });
    findMuteByUserAndCommunity.mockResolvedValue({
      chatEnabled: true,
      streamEnabled: true,
      announcementEnabled: true,
    });

    await expect(
      resolveCommunityNotificationPrefEnabled(CID, UID, "announcementEnabled")
    ).resolves.toBe(false);
  });

  it("ACTIVE + row with no timed mute → the per-field toggle decides, not row existence", async () => {
    // Regression (issue 51): `mutedUntil = null` used to be read as "muted
    // indefinitely", so the row created by touching ANY toggle silenced every
    // kind forever and switching a category back on changed nothing.
    findMembership.mockResolvedValue({ status: CommunityMemberStatus.ACTIVE });
    findMuteByUserAndCommunity.mockResolvedValue({
      mutedUntil: null,
      chatEnabled: true,
      streamEnabled: true,
      announcementEnabled: true,
    });

    await expect(
      resolveCommunityNotificationPrefEnabled(CID, UID, "chatEnabled")
    ).resolves.toBe(true);
  });

  it("ACTIVE + re-enabled category after a full mute → enabled=true again", async () => {
    // A full mute is stored as all three off; flipping one back on must deliver
    // that kind immediately while the other two stay silent.
    findMembership.mockResolvedValue({ status: CommunityMemberStatus.ACTIVE });
    findMuteByUserAndCommunity.mockResolvedValue({
      mutedUntil: null,
      chatEnabled: true,
      streamEnabled: false,
      announcementEnabled: false,
    });

    await expect(
      resolveCommunityNotificationPrefEnabled(CID, UID, "chatEnabled")
    ).resolves.toBe(true);
    await expect(
      resolveCommunityNotificationPrefEnabled(CID, UID, "streamEnabled")
    ).resolves.toBe(false);
  });

  it("ACTIVE + timed mute still in the future → enabled=false regardless of per-field toggles", async () => {
    findMembership.mockResolvedValue({ status: CommunityMemberStatus.ACTIVE });
    findMuteByUserAndCommunity.mockResolvedValue({
      mutedUntil: new Date(Date.now() + 60_000),
      chatEnabled: true,
      streamEnabled: true,
      announcementEnabled: true,
    });

    await expect(
      resolveCommunityNotificationPrefEnabled(CID, UID, "chatEnabled")
    ).resolves.toBe(false);
  });

  it("ACTIVE + timed mute already expired → lazily falls back to the per-field toggle", async () => {
    findMembership.mockResolvedValue({ status: CommunityMemberStatus.ACTIVE });
    findMuteByUserAndCommunity.mockResolvedValue({
      mutedUntil: new Date(Date.now() - 60_000),
      chatEnabled: false,
      streamEnabled: true,
      announcementEnabled: true,
    });

    await expect(
      resolveCommunityNotificationPrefEnabled(CID, UID, "chatEnabled")
    ).resolves.toBe(false);
    await expect(
      resolveCommunityNotificationPrefEnabled(CID, UID, "streamEnabled")
    ).resolves.toBe(true);
  });
});
