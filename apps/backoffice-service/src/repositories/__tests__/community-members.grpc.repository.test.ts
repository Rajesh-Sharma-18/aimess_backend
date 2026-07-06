/**
 * Unit tests for the pure logic of {@link GrpcCommunityMembersRepository}: the
 * raw gRPC row → DTO mapping (`toRow`: avatarUrl → avatar MediaObject, "" →
 * null, role/status pass through) and the offset PaginationMeta math
 * (totalPages / hasNext / hasPrev / totalApprox) across the empty, middle, and
 * last-page cases.
 *
 * The repo imports the `communityClient` singleton directly. `communityClient`
 * is a plain exported object whose RPC methods only open a gRPC connection when
 * `.fire()` is invoked — so we monkey-patch `adminListCommunityMembers` with a
 * fake at runtime (no live gRPC / community-service / DB). Style mirrors the
 * existing group.grpc.repository.test.ts (node:test + node:assert/strict).
 *
 * Run via `tsx --test src/repositories/__tests__/community-members.grpc.repository.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  communityClient,
  type AdminListCommunityMembersReq,
  type RawAdminCommunityMemberRow,
} from "../../grpc/community.client.js";
import { GrpcCommunityMembersRepository } from "../community-members.repository.js";

// ---------------------------------------------------------------------------
// Programmable fake. Each test sets the next response (and we capture the
// request) via these module-level holders before invoking the repo.
// ---------------------------------------------------------------------------
let nextMembers: RawAdminCommunityMemberRow[] = [];
let nextTotal = 0;
let lastReq: AdminListCommunityMembersReq | undefined;

// Swap the RPC method on the singleton with a fake (never opens a socket). The
// real client coerces total to a number before returning, so the fake mirrors
// that contract ({ members, total: number }).
communityClient.adminListCommunityMembers = (
  req: AdminListCommunityMembersReq
): Promise<{ members: RawAdminCommunityMemberRow[]; total: number }> => {
  lastReq = req;
  return Promise.resolve({ members: nextMembers, total: nextTotal });
};

function rawMemberRow(
  overrides: Partial<RawAdminCommunityMemberRow> = {}
): RawAdminCommunityMemberRow {
  return {
    userId: "u_1",
    username: "Alice",
    handle: "alice",
    avatarUrl: "https://cdn/a.png",
    role: "MEMBER",
    status: "ACTIVE",
    joinedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const repo = new GrpcCommunityMembersRepository();

describe("GrpcCommunityMembersRepository.listMembers — empty result set", () => {
  it("returns data:[] with zeroed pagination (total 0, totalPages 0, no next/prev)", async () => {
    nextMembers = [];
    nextTotal = 0;

    const res = await repo.listMembers("c_1", { page: 1, limit: 20 });

    assert.deepEqual(res.data, []);
    assert.equal(res.pagination.mode, "offset");
    assert.equal(res.pagination.page, 1);
    assert.equal(res.pagination.limit, 20);
    assert.equal(res.pagination.total, 0);
    assert.equal(res.pagination.totalApprox, 0);
    assert.equal(res.pagination.totalPages, 0);
    assert.equal(res.pagination.hasNext, false);
    assert.equal(res.pagination.hasPrev, false);
    assert.equal(res.pagination.nextCursor, null);
  });

  it("forwards empty search/role as '' to the gRPC contract", async () => {
    nextMembers = [];
    nextTotal = 0;

    await repo.listMembers("c_1", { page: 2, limit: 10 });

    assert.equal(lastReq?.communityId, "c_1");
    assert.equal(lastReq?.search, "");
    assert.equal(lastReq?.role, "");
    assert.equal(lastReq?.page, 2);
    assert.equal(lastReq?.limit, 10);
  });

  it("forwards provided search/role through unchanged", async () => {
    nextMembers = [];
    nextTotal = 0;

    await repo.listMembers("c_1", {
      page: 1,
      limit: 20,
      search: "bob",
      role: "MODERATOR",
    });

    assert.equal(lastReq?.search, "bob");
    assert.equal(lastReq?.role, "MODERATOR");
  });

  it("forwards empty sortField/sortDir as '' when omitted", async () => {
    nextMembers = [];
    nextTotal = 0;

    await repo.listMembers("c_1", { page: 1, limit: 20 });

    assert.equal(lastReq?.sortField, "");
    assert.equal(lastReq?.sortDir, "");
  });

  for (const field of ["username", "handle", "joinedAt"]) {
    for (const dir of ["asc", "desc"]) {
      it(`forwards sortField=${field}/sortDir=${dir} unchanged`, async () => {
        nextMembers = [];
        nextTotal = 0;

        await repo.listMembers("c_1", {
          page: 1,
          limit: 20,
          sortField: field,
          sortDir: dir,
        });

        assert.equal(lastReq?.sortField, field);
        assert.equal(lastReq?.sortDir, dir);
      });
    }
  }
});

describe("GrpcCommunityMembersRepository.listMembers — row mapping (toRow)", () => {
  it("maps a populated row 1:1 and preserves role/status", async () => {
    nextMembers = [rawMemberRow()];
    nextTotal = 1;

    const { data } = await repo.listMembers("c_1", { page: 1, limit: 20 });

    assert.equal(data.length, 1);
    assert.deepEqual(data[0], {
      userId: "u_1",
      username: "Alice",
      handle: "alice",
      avatar: {
        fileId: null,
        objectKey: null,
        fileName: null,
        contentType: null,
        size: null,
        downloadUrl: "https://cdn/a.png",
        downloadUrlExpiresIn: null,
        uploadUrl: null,
        uploadUrlExpiresIn: null,
      },
      role: "MEMBER",
      status: "ACTIVE",
      joinedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("coerces an empty avatarUrl ('') to a null avatar", async () => {
    nextMembers = [rawMemberRow({ avatarUrl: "" })];
    nextTotal = 1;

    const { data } = await repo.listMembers("c_1", { page: 1, limit: 20 });

    assert.equal(data[0]?.avatar, null);
  });
});

describe("GrpcCommunityMembersRepository.listMembers — pagination math", () => {
  it("middle page: hasNext true, hasPrev true, totalPages ceil(total/limit)", async () => {
    // 25 total, limit 10, page 2 → rows 11..20, totalPages 3, more remain.
    nextMembers = Array.from({ length: 10 }, (_, i) =>
      rawMemberRow({ userId: `u_${i + 11}` })
    );
    nextTotal = 25;

    const { pagination } = await repo.listMembers("c_1", {
      page: 2,
      limit: 10,
    });

    assert.equal(pagination.total, 25);
    assert.equal(pagination.totalApprox, 25);
    assert.equal(pagination.totalPages, 3);
    assert.equal(pagination.hasNext, true);
    assert.equal(pagination.hasPrev, true);
  });

  it("last page: hasNext false (offset + page rows == total)", async () => {
    // 25 total, limit 10, page 3 → rows 21..25 (5 rows), no more remain.
    nextMembers = Array.from({ length: 5 }, (_, i) =>
      rawMemberRow({ userId: `u_${i + 21}` })
    );
    nextTotal = 25;

    const { pagination } = await repo.listMembers("c_1", {
      page: 3,
      limit: 10,
    });

    assert.equal(pagination.totalPages, 3);
    assert.equal(pagination.hasNext, false);
    assert.equal(pagination.hasPrev, true);
  });

  it("first full page with more remaining: hasNext true, hasPrev false", async () => {
    nextMembers = Array.from({ length: 10 }, (_, i) =>
      rawMemberRow({ userId: `u_${i + 1}` })
    );
    nextTotal = 25;

    const { pagination } = await repo.listMembers("c_1", {
      page: 1,
      limit: 10,
    });

    assert.equal(pagination.hasNext, true);
    assert.equal(pagination.hasPrev, false);
  });
});
