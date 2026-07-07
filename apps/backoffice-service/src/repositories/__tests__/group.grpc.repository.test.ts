/**
 * Unit tests for the pure logic of {@link GrpcGroupRepository}: offset
 * pagination math (totalPages / hasNext / hasPrevious) and the raw-row → DTO
 * mapping (avatarUrl/email "" → null, createdAt/joinedAt epoch-ms → ISO).
 *
 * The repo imports the `chatClient` singleton directly. `chatClient` is a
 * plain exported object whose RPC methods only open a gRPC connection when
 * `.fire()` is invoked — so we monkey-patch its methods with fakes at runtime
 * (no flag-gated `mock.module`, no live gRPC / chat-service / DB). Style
 * mirrors the existing *.test.ts files (node:test + node:assert/strict).
 *
 * Run via `tsx --test src/**\/*.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chatClient,
  type AdminListGroupsRes,
  type AdminGroupDetailRes,
  type AdminListGroupMembersRes,
  type AdminListGroupsReq,
  type AdminListGroupMembersReq,
} from "../../grpc/chat.client.js";
import { groupRepository as repo } from "../group.grpc.repository.js";

// ---------------------------------------------------------------------------
// Programmable fakes. Each test sets the next response (or captures the
// request) via these module-level holders before invoking the repo.
// ---------------------------------------------------------------------------
let nextListGroupsRes: AdminListGroupsRes;
let nextGroupDetailRes: AdminGroupDetailRes;
let nextListMembersRes: AdminListGroupMembersRes;
let lastListGroupsReq: AdminListGroupsReq | undefined;
let lastListMembersReq: AdminListGroupMembersReq | undefined;

// Swap the RPC methods on the singleton with fakes (never opens a socket).
chatClient.adminListGroups = (
  req: AdminListGroupsReq
): Promise<AdminListGroupsRes> => {
  lastListGroupsReq = req;
  return Promise.resolve(nextListGroupsRes);
};
chatClient.adminGetGroup = (_groupId: string): Promise<AdminGroupDetailRes> =>
  Promise.resolve(nextGroupDetailRes);
chatClient.adminListGroupMembers = (
  req: AdminListGroupMembersReq
): Promise<AdminListGroupMembersRes> => {
  lastListMembersReq = req;
  return Promise.resolve(nextListMembersRes);
};

// A representative raw group row (camelCase; "" for empty optionals).
function rawGroupRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "grp_1",
    name: "Acme",
    avatarUrl: "https://cdn/a.png",
    description: "An acme group",
    memberCount: 42,
    createdAt: "1700000000000", // epoch-ms as string (longs:String)
    admin: {
      userId: "u_admin",
      username: "boss",
      email: "boss@acme.io",
      avatarUrl: "https://cdn/admin.png",
    },
    ...overrides,
  };
}

describe("GrpcGroupRepository.list — pagination math", () => {
  it("total=0 → empty page, no next/prev, totalPages 0", async () => {
    nextListGroupsRes = { groups: [], total: 0 };
    const res = await repo.list({
      sortBy: "createdAt",
      sortOrder: "desc",
      page: 1,
      limit: 20,
    });
    assert.equal(res.items.length, 0);
    assert.equal(res.pagination.total, 0);
    assert.equal(res.pagination.totalPages, 0);
    assert.equal(res.pagination.hasNext, false);
    assert.equal(res.pagination.hasPrevious, false);
  });

  it("exactly one page (total === limit)", async () => {
    nextListGroupsRes = { groups: [rawGroupRow()], total: 20 };
    const res = await repo.list({
      sortBy: "createdAt",
      sortOrder: "desc",
      page: 1,
      limit: 20,
    });
    assert.equal(res.pagination.totalPages, 1);
    assert.equal(res.pagination.hasNext, false); // 1*20 < 20 is false
    assert.equal(res.pagination.hasPrevious, false);
  });

  it("multi-page first page → hasNext, no hasPrevious", async () => {
    nextListGroupsRes = { groups: [rawGroupRow()], total: 45 };
    const res = await repo.list({
      sortBy: "createdAt",
      sortOrder: "desc",
      page: 1,
      limit: 20,
    });
    assert.equal(res.pagination.totalPages, 3); // ceil(45/20)
    assert.equal(res.pagination.hasNext, true); // 20 < 45
    assert.equal(res.pagination.hasPrevious, false);
  });

  it("multi-page middle page → hasNext + hasPrevious", async () => {
    nextListGroupsRes = { groups: [rawGroupRow()], total: 45 };
    const res = await repo.list({
      sortBy: "createdAt",
      sortOrder: "desc",
      page: 2,
      limit: 20,
    });
    assert.equal(res.pagination.totalPages, 3);
    assert.equal(res.pagination.hasNext, true); // 40 < 45
    assert.equal(res.pagination.hasPrevious, true);
  });

  it("multi-page last page → hasPrevious, no hasNext", async () => {
    nextListGroupsRes = { groups: [rawGroupRow()], total: 45 };
    const res = await repo.list({
      sortBy: "createdAt",
      sortOrder: "desc",
      page: 3,
      limit: 20,
    });
    assert.equal(res.pagination.totalPages, 3);
    assert.equal(res.pagination.hasNext, false); // 60 < 45 is false
    assert.equal(res.pagination.hasPrevious, true);
  });

  it("forwards query filters into the gRPC request (defaults for omitted optionals)", async () => {
    nextListGroupsRes = { groups: [], total: 0 };
    await repo.list({
      q: "acme",
      fromDate: "2025-01-01",
      sortBy: "memberCount",
      sortOrder: "asc",
      page: 2,
      limit: 10,
    });
    assert.equal(lastListGroupsReq?.q, "acme");
    assert.equal(lastListGroupsReq?.fromDate, "2025-01-01");
    assert.equal(lastListGroupsReq?.toDate, ""); // omitted → ""
    assert.equal(lastListGroupsReq?.sortField, "memberCount");
    assert.equal(lastListGroupsReq?.sortDir, "asc");
    assert.equal(lastListGroupsReq?.page, 2);
    assert.equal(lastListGroupsReq?.limit, 10);
  });
});

describe("GrpcGroupRepository.list — row → DTO mapping", () => {
  it("maps a fully-populated row", async () => {
    nextListGroupsRes = { groups: [rawGroupRow()], total: 1 };
    const { items } = await repo.list({
      sortBy: "createdAt",
      sortOrder: "desc",
      page: 1,
      limit: 20,
    });
    const item = items[0]!;
    assert.equal(item.id, "grp_1");
    assert.equal(item.name, "Acme");
    assert.equal(item.avatar?.downloadUrl, "https://cdn/a.png");
    assert.equal(item.description, "An acme group");
    assert.equal(item.memberCount, 42);
    assert.equal(item.createdAt, "2023-11-14T22:13:20.000Z"); // ISO of 1700000000000
    assert.equal(item.admin.userId, "u_admin");
    assert.equal(item.admin.username, "boss");
    assert.equal(item.admin.email, "boss@acme.io");
    assert.equal(item.admin.avatar?.downloadUrl, "https://cdn/admin.png");
  });

  it('normalises "" avatarUrl/email and admin "" fields to null', async () => {
    nextListGroupsRes = {
      groups: [
        rawGroupRow({
          avatarUrl: "",
          admin: {
            userId: "u_admin",
            username: "boss",
            email: "",
            avatarUrl: "",
          },
        }),
      ],
      total: 1,
    };
    const { items } = await repo.list({
      sortBy: "createdAt",
      sortOrder: "desc",
      page: 1,
      limit: 20,
    });
    const item = items[0]!;
    assert.equal(item.avatar, null);
    assert.equal(item.admin.email, null);
    assert.equal(item.admin.avatar, null);
  });

  it("defaults a missing description to empty string", async () => {
    const row = rawGroupRow();
    // Simulate proto sending undefined description.
    delete (row as Record<string, unknown>).description;
    nextListGroupsRes = { groups: [row], total: 1 };
    const { items } = await repo.list({
      sortBy: "createdAt",
      sortOrder: "desc",
      page: 1,
      limit: 20,
    });
    assert.equal(items[0]!.description, "");
  });
});

describe("GrpcGroupRepository.getById", () => {
  it("returns null when not found", async () => {
    nextGroupDetailRes = { found: false };
    const res = await repo.getById("grp_x");
    assert.equal(res, null);
  });

  it("returns null when found=true but group is absent", async () => {
    nextGroupDetailRes = { found: true };
    const res = await repo.getById("grp_x");
    assert.equal(res, null);
  });

  it("maps the group row when found", async () => {
    nextGroupDetailRes = { found: true, group: rawGroupRow() };
    const res = await repo.getById("grp_1");
    assert.equal(res?.id, "grp_1");
    assert.equal(res?.createdAt, "2023-11-14T22:13:20.000Z");
  });
});

describe("GrpcGroupRepository.listMembers", () => {
  function rawMemberRow(overrides: Record<string, unknown> = {}) {
    return {
      userId: "u_1",
      username: "alice",
      email: "alice@x.io",
      avatarUrl: "https://cdn/al.png",
      role: "MEMBER",
      joinedAt: "1700000000000",
      ...overrides,
    };
  }

  it("propagates found=false with empty items", async () => {
    nextListMembersRes = { found: false, members: [], total: 0 };
    const res = await repo.listMembers("grp_x", { page: 1, limit: 20 });
    assert.equal(res.found, false);
    assert.equal(res.items.length, 0);
    assert.equal(res.pagination.total, 0);
    assert.equal(res.pagination.totalPages, 0);
  });

  it("maps member rows + paginates and null-normalises", async () => {
    nextListMembersRes = {
      found: true,
      members: [rawMemberRow({ email: "", avatarUrl: "" })],
      total: 30,
    };
    const res = await repo.listMembers("grp_1", { page: 1, limit: 20 });
    assert.equal(res.found, true);
    const m = res.items[0]!;
    assert.equal(m.userId, "u_1");
    assert.equal(m.email, null);
    assert.equal(m.avatar, null);
    assert.equal(m.role, "MEMBER");
    assert.equal(m.joinedAt, "2023-11-14T22:13:20.000Z");
    assert.equal(res.pagination.totalPages, 2); // ceil(30/20)
    assert.equal(res.pagination.hasNext, true);
    assert.equal(res.pagination.hasPrevious, false);
  });

  it("forwards role + q filters into the gRPC request (defaults for omitted)", async () => {
    nextListMembersRes = { found: true, members: [], total: 0 };
    await repo.listMembers("grp_1", { role: "ADMIN", page: 1, limit: 20 });
    assert.equal(lastListMembersReq?.groupId, "grp_1");
    assert.equal(lastListMembersReq?.role, "ADMIN");
    assert.equal(lastListMembersReq?.q, ""); // omitted → ""
  });
});
