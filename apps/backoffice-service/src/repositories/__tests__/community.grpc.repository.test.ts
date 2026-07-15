/**
 * Unit tests for {@link GrpcCommunityRepository.list}'s avatar mapping: the
 * raw gRPC row's presigned `communityAvatarUrl`/`adminAvatarUrl` strings are
 * wrapped into the standard `MediaObject` shape (see @aimess/shared-types) —
 * the SAME shape/field names as GET /api/v1/communities/{communityId} —
 * reusing `toMediaObject` (via the repo's internal
 * `resolveCommunityImageMediaObject`/`resolveAvatarMediaObject` helpers), not
 * a duplicated mapper. No network calls: an already-signed http(s) URL is a
 * pure pass-through in `toMediaObject` (see packages/storage/src/media-object.ts),
 * so this is a fast, offline test.
 *
 * The list response intentionally does NOT include a `cover` field — only
 * `avatar` was requested for the Admin Communities List. `communityCoverUrl`
 * still exists on the raw gRPC row (unused here) since the field remains
 * part of the shared proto contract.
 *
 * The repo imports the `communityClient` singleton directly, so we
 * monkey-patch `adminListCommunities` at runtime — no live gRPC / MinIO / DB.
 * Style mirrors community-members.grpc.repository.test.ts.
 *
 * Run via `tsx --test src/repositories/__tests__/community.grpc.repository.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  communityClient,
  type AdminCommunityDetailRes,
  type AdminListCommunitiesReq,
  type AdminListCommunitiesRes,
} from "../../grpc/community.client.js";
// Import through community.repository.js (the production singleton's home),
// NOT community.grpc.repository.js directly — the two files have a
// deliberate ESM cycle that only resolves when entered from this side (see
// the comment atop community.repository.ts).
import { communityRepository } from "../community.repository.js";
import { moderationActionRepository } from "../moderation-action.repository.js";
import { streamClient } from "../../grpc/stream.client.js";
import type { ListCommunitiesQuery } from "../../types/community.types.js";

// getById now also asks stream-service for the live count — stub it so this
// stays a fast, offline unit test (no live gRPC).
streamClient.adminListStreams = (async () => ({
  streams: [],
  total: 0,
})) as typeof streamClient.adminListStreams;

let nextRes: AdminListCommunitiesRes = { communities: [], total: 0 };
let lastReq: AdminListCommunitiesReq | undefined;

communityClient.adminListCommunities = (
  req: AdminListCommunitiesReq
): Promise<AdminListCommunitiesRes> => {
  lastReq = req;
  return Promise.resolve(nextRes);
};

function baseQuery(
  overrides: Partial<ListCommunitiesQuery> = {}
): ListCommunitiesQuery {
  return {
    sort: "createdAt:desc",
    sortBy: "createdDate",
    sortOrder: "desc",
    page: 1,
    limit: 20,
    ...overrides,
  };
}

const repo = communityRepository;

describe("GrpcCommunityRepository.list — avatar reuses the standard MediaObject shape", () => {
  it("wraps a presigned communityAvatarUrl into MediaObject.downloadUrl (no cover field)", async () => {
    nextRes = {
      total: 1,
      communities: [
        {
          communityId: "comm_1",
          name: "Builders",
          handle: "builders",
          adminId: "u_1",
          adminName: "Alice",
          adminUsername: "alice",
          // Paths deliberately do NOT start with a recognized object-key
          // prefix ("avatars/", "community/") — toMediaObject then takes the
          // pure external-URL pass-through branch (no MinIO re-sign, no
          // network call), matching the existing precedent in
          // community-members.grpc.repository.test.ts ("https://cdn/a.png").
          adminAvatarUrl: "https://cdn.aimess.app/av/u_1/a.png",
          type: "PUBLIC",
          categoryId: "cat_1",
          categoryName: "Tech",
          categorySlug: "tech",
          status: "ACTIVE",
          memberCount: 10,
          livestreamCount: 0,
          createdAt: "1750000000000",
          communityAvatarUrl: "https://cdn.aimess.app/img/comm_1/a.png",
          communityCoverUrl: "https://cdn.aimess.app/img/comm_1/c.png",
        },
      ],
    };

    const page = await repo.list(baseQuery());
    const item = page.data[0]!;

    assert.ok(item.avatar, "community avatar must be present");
    assert.ok(item.admin.avatar, "admin/owner avatar must be present");
    assert.equal(
      item.avatar.downloadUrl,
      "https://cdn.aimess.app/img/comm_1/a.png",
      "community avatar MediaObject.downloadUrl echoes the presigned URL"
    );
    assert.equal(
      item.admin.avatar.downloadUrl,
      "https://cdn.aimess.app/av/u_1/a.png",
      "admin/owner avatar MediaObject.downloadUrl echoes the presigned URL"
    );
    assert.equal(
      "cover" in item,
      false,
      "list item must not expose a cover field"
    );
    // MediaObject's full contract is present even though most fields stay
    // null (the raw object key never crosses the gRPC boundary — only an
    // already-presigned URL does, same as the admin ref avatar).
    for (const media of [item.avatar, item.admin.avatar]) {
      assert.equal(media.objectKey, null);
      assert.equal(media.fileId, null);
      assert.equal(media.uploadUrl, null);
    }
  });

  it("empty communityAvatarUrl ('' from proto3 default) resolves to a null avatar, not a throw", async () => {
    nextRes = {
      total: 1,
      communities: [
        {
          communityId: "comm_2",
          name: "No Avatar Co",
          handle: "no-avatar-co",
          adminId: "u_2",
          adminName: "Bob",
          adminUsername: "bob",
          adminAvatarUrl: "",
          type: "PRIVATE",
          categoryId: "cat_2",
          categoryName: "Food",
          categorySlug: "food",
          status: "CLOSED",
          memberCount: 0,
          livestreamCount: 0,
          createdAt: "1750000000000",
          communityAvatarUrl: "",
          communityCoverUrl: "",
        },
      ],
    };

    const page = await repo.list(baseQuery());
    const item = page.data[0]!;

    assert.equal(item.avatar, null);
    assert.equal(item.admin.avatar, null);
  });

  it("preserves existing pagination/sort/search request mapping unchanged", async () => {
    nextRes = { total: 0, communities: [] };
    await repo.list(
      baseQuery({
        search: "foo",
        type: "PUBLIC",
        category: "tech",
        status: "ACTIVE",
        createdFrom: "2026-01-01",
        createdTo: "2026-02-01",
        sort: "memberCount:asc",
        page: 2,
        limit: 5,
      })
    );

    assert.deepEqual(lastReq, {
      search: "foo",
      type: "PUBLIC",
      category: "tech",
      status: "ACTIVE",
      createdFrom: "2026-01-01",
      createdTo: "2026-02-01",
      sortField: "memberCount",
      sortDir: "asc",
      page: 2,
      limit: 5,
    });
  });
});

// getById must reuse the exact same avatar mapping as list — regression test
// for the "Community Details returns avatar: null while List is correct" bug
// (root cause: the detail RPC never resolved/echoed communityAvatarUrl, and
// the repo mapper hardcoded `avatar: null` instead of resolving it).
moderationActionRepository.listByTarget = (() =>
  Promise.resolve([])) as typeof moderationActionRepository.listByTarget;

communityClient.adminGetCommunity = (
  _communityId: string
): Promise<AdminCommunityDetailRes> => Promise.resolve(nextDetailRes);

let nextDetailRes: AdminCommunityDetailRes = {
  found: false,
  description: "",
  coverUrl: "",
  lastActivityAt: "0",
  membersTotal: 0,
  membersActive: 0,
  membersPending: 0,
  membersBanned: 0,
  membersModerators: 0,
  membersJoinedLast7d: 0,
  openReports: 0,
  activeInviteLinks: 0,
  joinPolicy: "OPEN",
  ownerEmail: "",
  ownerAccountStatus: "ACTIVE",
};

describe("GrpcCommunityRepository.getById — avatar parity with list", () => {
  it("resolves community.avatar from communityAvatarUrl, same MediaObject shape as list", async () => {
    nextDetailRes = {
      found: true,
      community: {
        communityId: "comm_1",
        name: "Builders",
        handle: "builders",
        adminId: "u_1",
        adminName: "Alice",
        adminUsername: "alice",
        adminAvatarUrl: "https://cdn.aimess.app/av/u_1/a.png",
        type: "PUBLIC",
        categoryId: "cat_1",
        categoryName: "Tech",
        categorySlug: "tech",
        status: "ACTIVE",
        memberCount: 10,
        livestreamCount: 0,
        createdAt: "1750000000000",
        communityAvatarUrl: "https://cdn.aimess.app/img/comm_1/a.png",
        communityCoverUrl: "https://cdn.aimess.app/img/comm_1/c.png",
      },
      description: "",
      coverUrl: "https://cdn.aimess.app/img/comm_1/c.png",
      lastActivityAt: "1750000000000",
      membersTotal: 10,
      membersActive: 9,
      membersPending: 0,
      membersBanned: 1,
      membersModerators: 1,
      membersJoinedLast7d: 0,
      openReports: 0,
      activeInviteLinks: 0,
      joinPolicy: "OPEN",
      ownerEmail: "alice@example.com",
      ownerAccountStatus: "ACTIVE",
    };

    const detail = await communityRepository.getById("comm_1");

    assert.ok(detail, "detail must resolve");
    assert.ok(detail!.community.avatar, "community avatar must be present");
    assert.equal(
      detail!.community.avatar!.downloadUrl,
      "https://cdn.aimess.app/img/comm_1/a.png",
      "detail avatar must echo the same presigned URL as the list mapping"
    );
  });

  it("empty communityAvatarUrl resolves to a null avatar (true no-avatar case)", async () => {
    nextDetailRes = {
      found: true,
      community: {
        communityId: "comm_2",
        name: "No Avatar Co",
        handle: "no-avatar-co",
        adminId: "u_2",
        adminName: "Bob",
        adminUsername: "bob",
        adminAvatarUrl: "",
        type: "PRIVATE",
        categoryId: "cat_2",
        categoryName: "Food",
        categorySlug: "food",
        status: "CLOSED",
        memberCount: 0,
        livestreamCount: 0,
        createdAt: "1750000000000",
        communityAvatarUrl: "",
        communityCoverUrl: "",
      },
      description: "",
      coverUrl: "",
      lastActivityAt: "0",
      membersTotal: 0,
      membersActive: 0,
      membersPending: 0,
      membersBanned: 0,
      membersModerators: 0,
      membersJoinedLast7d: 0,
      openReports: 0,
      activeInviteLinks: 0,
      joinPolicy: "REQUEST",
      ownerEmail: "",
      ownerAccountStatus: "ACTIVE",
    };

    const detail = await communityRepository.getById("comm_2");

    assert.ok(detail, "detail must resolve");
    assert.equal(detail!.community.avatar, null);
  });
});
