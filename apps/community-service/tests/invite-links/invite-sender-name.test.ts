/**
 * The invite DM must carry a NAMEABLE sender.
 *
 * Root-cause regression for "Someone shared a community invite" in the
 * recipient's chat list. user-service builds a snapshot's `displayName` from
 * firstName+lastName ONLY, so an inviter who never filled those in resolves to
 * `""`. This service published that empty string as `inviterName`, chat-service
 * stamped it onto the row as `systemData.actorName`, and the per-reader sentence
 * rebuild then fell back to "Someone" on every future read — permanently, in
 * both directions, surviving every refresh.
 *
 * The GROUP invite twin was immune only because chat-service resolves through
 * its own `resolveDisplayName`, which falls back to the handle. Friendship never
 * entered this path: it is not consulted when resolving the sender, and must not
 * be — the sender is the same person whether or not the two are still friends.
 *
 * Only the I/O boundary is mocked (repository, user-client, storage, publishers).
 */

jest.mock("../../src/lib/user-client.js", () => ({
  fetchInviteIneligibility: jest.fn(),
  INVITE_INELIGIBILITY_CODE: {
    NOT_FOUND: "INVITE_RECIPIENT_NOT_FOUND",
    DELETED: "INVITE_RECIPIENT_DELETED",
    SUSPENDED: "INVITE_RECIPIENT_SUSPENDED",
    BLOCKED: "INVITE_RECIPIENT_BLOCKED",
  },
  fetchUserSnapshots: jest.fn(async () => new Map()),
  fetchUserSnapshotHits: jest.fn(async () => new Map()),
  fetchAcceptedFriendIds: jest.fn(async () => new Set()),
}));

jest.mock("@aimess/storage", () => ({
  MEDIA_PREFIXES: { community: [], userAvatars: [] },
  parseObjectKeyFromStored: jest.fn(() => null),
  toMediaObject: jest.fn(async () => ({
    url: null,
    downloadUrl: null,
    objectKey: null,
    expiresAt: null,
  })),
}));

jest.mock("@aimess/redis", () => ({
  // See bulk-send-invite.test.ts: a factory returning only stubs blanks every
  // other export, and `createBannedUserGuard` runs at import time.
  ...jest.requireActual("@aimess/redis"),
  publishCommunityRoomEvent: jest.fn(async () => 1),
  publishChatUserEvent: jest.fn(async () => 1),
}));

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    findInviteLinkById: jest.fn(),
    listInviteLinks: jest.fn(),
    createInviteLink: jest.fn(),
    findMembersByUserIds: jest.fn(),
    createAuditLog: jest.fn(),
  },
}));

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import {
  fetchInviteIneligibility,
  fetchUserSnapshotHits,
} from "../../src/lib/user-client.js";
import { publishCommunityInviteLinkSharedForChatSafe } from "../../src/messaging/publish-community-chat.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const ineligible = fetchInviteIneligibility as unknown as jest.Mock;
const snapshotHits = fetchUserSnapshotHits as unknown as jest.Mock;
const publishInvite =
  publishCommunityInviteLinkSharedForChatSafe as unknown as jest.Mock;

const CID = "a".repeat(24);
const LINK_ID = "b".repeat(24);
const CALLER = "99999999-9999-4999-8999-999999999999";
const UID_A = "885ad4e0-e238-4f9a-9773-e215321885b4";

const community = {
  id: CID,
  name: "Cool Community",
  handle: "cool_community",
  avatarUrl: null,
  coverUrl: null,
  type: "PRIVATE",
  adminId: "11111111-1111-4111-8111-111111111111",
  memberCount: 5,
  moderationStatus: "ACTIVE",
  status: "ACTIVE",
  deletedAt: null,
};

const link = {
  id: LINK_ID,
  code: "abc123",
  communityId: CID,
  createdBy: CALLER,
  maxUses: null,
  usedCount: 0,
  autoApprove: false,
  expiresAt: null,
  revokedAt: null,
  createdAt: new Date("2026-06-23T00:00:00.000Z"),
};

const snapshot = (over: Record<string, unknown>) =>
  new Map([
    [
      CALLER,
      {
        userId: CALLER,
        username: "user_b",
        displayName: "User B",
        avatarObjectKey: null,
        isDeleted: false,
        ...over,
      },
    ],
  ]);

async function share(): Promise<void> {
  await communityService.bulkSendInviteLink(CID, CALLER, {
    userIds: [UID_A],
    linkId: LINK_ID,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  repo.findById.mockResolvedValue(community);
  repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
  repo.findInviteLinkById.mockResolvedValue(link);
  repo.findMembersByUserIds.mockResolvedValue([]);
  ineligible.mockResolvedValue(new Map());
  snapshotHits.mockResolvedValue(snapshot({}));
});

describe("invite DM carries a nameable sender", () => {
  it("publishes the inviter's display name when they have one", async () => {
    await share();
    expect(publishInvite).toHaveBeenCalledWith(
      expect.objectContaining({ inviterId: CALLER, inviterName: "User B" })
    );
  });

  it("REGRESSION: an inviter with no first/last name is named by their handle", async () => {
    // Exactly the shape user-service returns for a profile that never filled in
    // firstName/lastName. Publishing "" here is what left the recipient's row
    // reading "Someone shared a community invite" forever.
    snapshotHits.mockResolvedValue(snapshot({ displayName: "" }));

    await share();

    expect(publishInvite).toHaveBeenCalledWith(
      expect.objectContaining({ inviterName: "user_b" })
    );
  });

  it("leaves the name undefined when identity itself is unresolved", async () => {
    // A user-service hiccup, not a nameless profile. The reader-side "Someone"
    // fallback is reserved for exactly this — never baked in as a placeholder.
    snapshotHits.mockResolvedValue(new Map());

    await share();

    expect(publishInvite).toHaveBeenCalledWith(
      expect.objectContaining({ inviterName: undefined })
    );
  });
});
