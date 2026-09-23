import { publishChatUserEvent, publishCommunityRoomEvent } from "@aimess/redis";
import { communityRepository } from "../../src/repositories/community.repository.js";
import { communityService } from "../../src/services/community.service.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const communityId = "a".repeat(24);
const callerId = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  repo.findById.mockResolvedValue({ id: communityId });
  repo.listMutedMembers = jest.fn().mockResolvedValue({ rows: [], total: 0 });
  repo.listBannedMembers = jest.fn().mockResolvedValue({ rows: [], total: 0 });
});

describe.each(["muted", "banned"] as const)(
  "%s search authorization",
  (kind) => {
    const search = () =>
      kind === "muted"
        ? communityService.listMutedMembers(communityId, callerId, {
            page: 2,
            limit: 20,
            search: "Peter",
          })
        : communityService.listBannedMembers(communityId, callerId, {
            page: 2,
            limit: 20,
            search: "Peter",
            sortBy: "bannedAt",
            sortOrder: "desc",
          });
    const list = () =>
      kind === "muted" ? repo.listMutedMembers : repo.listBannedMembers;

    it.each(["ADMIN", "MODERATOR"])(
      "allows an active %s without mutations or notifications",
      async (role) => {
        repo.findMembership.mockResolvedValue({ role, status: "ACTIVE" });
        await search();
        expect(list()).toHaveBeenCalledWith(
          expect.objectContaining({
            communityId,
            search: "Peter",
            page: 2,
            limit: 20,
          })
        );
        expect(publishChatUserEvent).not.toHaveBeenCalled();
        expect(publishCommunityRoomEvent).not.toHaveBeenCalled();
        expect(repo.update).not.toHaveBeenCalled();
      }
    );

    it.each([
      { role: "MEMBER", status: "ACTIVE" },
      { role: "MODERATOR", status: "BANNED" },
      { role: "ADMIN", status: "LEFT" },
      null,
    ])(
      "rejects insufficient or inactive membership: %j",
      async (membership) => {
        repo.findMembership.mockResolvedValue(membership);
        await expect(search()).rejects.toThrow();
        expect(list()).not.toHaveBeenCalled();
      }
    );
  }
);
