jest.mock("../../src/repositories/index.js", () => ({
  adminUserRepository: { findById: jest.fn() },
  communityRepository: { getById: jest.fn() },
  groupRepository: { getById: jest.fn() },
}));
jest.mock("../../src/lib/admin-perms-cache.js", () => ({
  getCachedAdminPermissions: jest.fn(async () => [] as string[]),
  invalidateAdminPermissions: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/audit.service.js", () => ({
  auditService: { record: jest.fn(async () => ({ id: "audit-1" })) },
}));
jest.mock("../../src/grpc/community.client.js", () => ({
  communityClient: { adminUpdateCommunity: jest.fn() },
}));
jest.mock("../../src/grpc/chat.client.js", () => ({
  chatClient: { adminUpdateGroup: jest.fn() },
}));
const mediaMock = {
  isDownloadable: jest.fn(async () => true),
  confirmUpload: jest.fn(),
  generateUserAvatarUploadUrl: jest.fn(),
};
jest.mock("../../src/grpc/media.client.js", () => ({
  getMediaConfirmClient: () => mediaMock,
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { chatClient } from "../../src/grpc/chat.client.js";
import { communityClient } from "../../src/grpc/community.client.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import {
  adminUserRepository,
  communityRepository,
  groupRepository,
} from "../../src/repositories/index.js";
import { auditService } from "../../src/services/audit.service.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";

const perms = getCachedAdminPermissions as jest.Mock;
const record = auditService.record as jest.Mock;
const updateCommunity = communityClient.adminUpdateCommunity as jest.Mock;
const updateGroup = chatClient.adminUpdateGroup as jest.Mock;
const getCommunity = communityRepository.getById as jest.Mock;
const getGroup = groupRepository.getById as jest.Mock;
const headers = () => bearer(makeAdminAccessToken());

const COMMUNITY_ID = "64b7f0c2a1b2c3d4e5f60718";
const communityDetail = (name: string) => ({
  community: {
    communityId: COMMUNITY_ID,
    name,
    handle: "h",
    avatar: null,
    type: "PUBLIC",
    category: { id: "c", name: "Cat", slug: "cat" },
    status: "ACTIVE",
    createdAt: 0,
    description: "d",
    coverUrl: null,
    lastActivityAt: 0,
    closedReasonCode: null,
  },
  owner: {
    userId: "u1",
    displayName: "Owner",
    username: "owner",
    avatar: null,
    email: null,
    accountStatus: "ACTIVE",
  },
  memberStats: { total: 3 },
  livestreamStats: { total: 0 },
});
const group = (name: string, joinApproval: boolean) => ({
  id: "g1",
  name,
  avatar: null,
  description: "",
  joinApproval,
});

beforeEach(() => {
  jest.clearAllMocks();
  configureActiveAdmin(adminUserRepository.findById as jest.Mock);
  grantPermissions(perms, [
    PERMISSIONS.COMMUNITIES_EDIT,
    PERMISSIONS.GROUPS_EDIT,
  ]);
});

describe("PATCH /v1/communities/:communityId", () => {
  it("is refused without communities.edit", async () => {
    grantPermissions(perms, [PERMISSIONS.COMMUNITIES_MODERATE]);
    const res = await request(app)
      .patch(`/v1/communities/${COMMUNITY_ID}`)
      .set(headers())
      .send({ name: "New name" });
    expect(res.status).toBe(403);
    expect(updateCommunity).not.toHaveBeenCalled();
  });

  it("rejects a name shorter than the app allows", async () => {
    const res = await request(app)
      .patch(`/v1/communities/${COMMUNITY_ID}`)
      .set(headers())
      .send({ name: "ab" });
    expect(res.status).toBe(400);
    expect(updateCommunity).not.toHaveBeenCalled();
  });

  it("forwards only the sent fields and audits what changed", async () => {
    getCommunity
      .mockResolvedValueOnce(communityDetail("Old name"))
      .mockResolvedValueOnce(communityDetail("New name"));
    updateCommunity.mockResolvedValue({
      ok: true,
      changedFields: ["name"],
      errorCode: "",
    });
    const res = await request(app)
      .patch(`/v1/communities/${COMMUNITY_ID}`)
      .set(headers())
      .send({ name: "New name" });
    expect(res.status).toBe(200);
    expect(res.body.data.communityName).toBe("New name");
    expect(updateCommunity).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: COMMUNITY_ID,
        name: "New name",
        hasName: true,
        hasDescription: false,
        hasAvatar: false,
        hasCategory: false,
        hasType: false,
      })
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "community.updated_by_admin",
        before: { name: "Old name" },
        after: { name: "New name" },
      })
    );
  });

  it("maps a taken name to 409", async () => {
    getCommunity.mockResolvedValue(communityDetail("Old name"));
    updateCommunity.mockResolvedValue({
      ok: false,
      changedFields: [],
      errorCode: "COMMUNITY_NAME_TAKEN",
    });
    const res = await request(app)
      .patch(`/v1/communities/${COMMUNITY_ID}`)
      .set(headers())
      .send({ name: "Taken name" });
    expect(res.status).toBe(409);
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses an avatar key minted for another community", async () => {
    getCommunity.mockResolvedValue(communityDetail("Old name"));
    const res = await request(app)
      .patch(`/v1/communities/${COMMUNITY_ID}`)
      .set(headers())
      .send({ avatarObjectKey: "community/avatar/someone-else/a.png" });
    expect(res.status).toBe(400);
    expect(updateCommunity).not.toHaveBeenCalled();
  });
});

describe("PATCH /v1/groups/:groupId", () => {
  it("sends the privacy flip and audits it as visibility", async () => {
    getGroup
      .mockResolvedValueOnce(group("G", false))
      .mockResolvedValueOnce(group("G", true));
    updateGroup.mockResolvedValue({ ok: true, found: true, errorCode: "" });
    const res = await request(app)
      .patch("/v1/groups/g1")
      .set(headers())
      .send({ joinApproval: true });
    expect(res.status).toBe(200);
    expect(updateGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "g1",
        joinApproval: true,
        hasJoinApproval: true,
        hasName: false,
      })
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "group.updated_by_admin",
        before: { visibility: "PUBLIC" },
        after: { visibility: "PRIVATE" },
      })
    );
  });

  it("maps a closed group to 409", async () => {
    getGroup.mockResolvedValue(group("G", false));
    updateGroup.mockResolvedValue({
      ok: false,
      found: true,
      errorCode: "CHAT_GROUP_CLOSED_ADMIN_BANNED",
    });
    const res = await request(app)
      .patch("/v1/groups/g1")
      .set(headers())
      .send({ name: "New" });
    expect(res.status).toBe(409);
  });
});
