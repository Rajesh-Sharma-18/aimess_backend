/**
 * Who a backoffice group removal is attributed to, on the wire.
 *
 * chat-service owns the group timeline but cannot read admin_db, so the acting
 * admin's DISPLAY NAME has to travel with the RPC. Without it the removal line
 * is posted actor-less and every remaining member reads "Someone removed X" —
 * forever, because the sentence is rebuilt from the stored metadata on every
 * read. These cases pin the whole leg: `adminAuth` resolves the name from the
 * row it already loads, the controller hands the admin to the service, and the
 * gRPC repository puts it on the request next to `actorAdminId`.
 *
 * Unlike group-management.test.ts this file deliberately does NOT mock
 * `groupService`, so the service and repository run for real up to the client.
 */
jest.mock("../../src/repositories/index.js", () => {
  const actual = jest.requireActual("../../src/repositories/index.js");
  return {
    __esModule: true,
    ...actual,
    adminUserRepository: { findById: jest.fn() },
  };
});
jest.mock("../../src/lib/admin-perms-cache.js", () => ({
  getCachedAdminPermissions: jest.fn(async () => [] as string[]),
  invalidateAdminPermissions: jest.fn(async () => undefined),
}));

const adminRemoveGroupMember = jest.fn(async () => ({
  ok: true,
  found: true,
  errorCode: "",
}));
jest.mock("../../src/grpc/chat.client.js", () => ({
  chatClient: { adminRemoveGroupMember },
}));

const record = jest.fn(async () => ({ id: "audit-1" }));
jest.mock("../../src/services/audit.service.js", () => ({
  auditService: { record },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const GID = "grp_001";
const auth = () => bearer(makeAdminAccessToken());

beforeEach(() => {
  jest.clearAllMocks();
  configureActiveAdmin(findById, { name: "Super Admin" });
  grantPermissions(perms, [
    PERMISSIONS.GROUPS_READ,
    PERMISSIONS.GROUPS_MODERATE,
  ]);
});

describe("POST /v1/groups/:groupId/members/:userId/remove — actor attribution", () => {
  it("POSITIVE: forwards the acting admin's name alongside their id", async () => {
    const res = await request(app)
      .post(`/v1/groups/${GID}/members/u1/remove`)
      .set(auth())
      .send({ reason: "harassment" });

    expect(res.status).toBe(200);
    expect(adminRemoveGroupMember).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: GID,
        userId: "u1",
        actorAdminName: "Super Admin",
        reason: "harassment",
      })
    );
    // The id still travels — it is what `GroupMember.kickedBy` records; the
    // name is additional, not a replacement.
    const req = adminRemoveGroupMember.mock.calls[0]![0] as {
      actorAdminId: string;
    };
    expect(req.actorAdminId).toBeTruthy();
  });

  it("NEGATIVE: an unauthorized caller sends nothing at all", async () => {
    grantPermissions(perms, [PERMISSIONS.GROUPS_READ]);

    const res = await request(app)
      .post(`/v1/groups/${GID}/members/u1/remove`)
      .set(auth())
      .send({});

    expect(res.status).toBe(403);
    expect(adminRemoveGroupMember).not.toHaveBeenCalled();
  });
});
