/**
 * Unit tests for the two new admin User Management Details validators:
 *   - listUserCommunitiesQuerySchema (the user's "Communities" grid)
 *   - listOtherMembersQuerySchema    (the co-member grid)
 *
 * Pure schema checks — no env / DB / Redis needed. Run via
 * `tsx --test src/api/validators/__tests__/*.test.ts`. Mirrors the style of
 * users.validator.test.ts (sortBy mapping, q/search alias, OWNER→ADMIN, email
 * detection, defaults, rejection of bad values).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  listOtherMembersQuerySchema,
  listUserCommunitiesQuerySchema,
  userCommunityMembersParamSchema,
} from "../users.validator.js";

describe("listUserCommunitiesQuerySchema — search alias", () => {
  it("maps the public `q` param onto `search`", () => {
    const r = listUserCommunitiesQuerySchema.safeParse({ q: "devs" });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, "devs");
  });

  it("keeps the legacy `search` param working", () => {
    const r = listUserCommunitiesQuerySchema.safeParse({ search: "comm_001" });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, "comm_001");
  });

  it("prefers `q` over `search` when both are present", () => {
    const r = listUserCommunitiesQuerySchema.safeParse({
      q: "wins",
      search: "loses",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, "wins");
  });

  it("leaves `search` undefined when neither is provided", () => {
    const r = listUserCommunitiesQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data?.search, undefined);
  });

  it("rejects an empty `q` (min length 1 after trim)", () => {
    const r = listUserCommunitiesQuerySchema.safeParse({ q: "   " });
    assert.equal(r.success, false);
  });
});

describe("listUserCommunitiesQuerySchema — sort mapping + defaults", () => {
  it("defaults to createdAt/desc when no sort is given", () => {
    const r = listUserCommunitiesQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data?.sortField, "createdAt");
    assert.equal(r.data?.sortDir, "desc");
  });

  it("maps sortBy=members onto memberCount", () => {
    const r = listUserCommunitiesQuerySchema.safeParse({
      sortBy: "members",
      sortOrder: "asc",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sortField, "memberCount");
    assert.equal(r.data?.sortDir, "asc");
  });

  it("maps sortBy=createdDate onto createdAt", () => {
    const r = listUserCommunitiesQuerySchema.safeParse({
      sortBy: "createdDate",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sortField, "createdAt");
  });

  it("maps sortBy=name onto name", () => {
    const r = listUserCommunitiesQuerySchema.safeParse({ sortBy: "name" });
    assert.equal(r.success, true);
    assert.equal(r.data?.sortField, "name");
  });

  it("is case-insensitive and tolerates canonical column names", () => {
    const r = listUserCommunitiesQuerySchema.safeParse({
      sortBy: "MemberCount",
      sortOrder: "DESC",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sortField, "memberCount");
    assert.equal(r.data?.sortDir, "desc");
  });

  it("defaults sortDir to desc when only sortBy is given", () => {
    const r = listUserCommunitiesQuerySchema.safeParse({ sortBy: "name" });
    assert.equal(r.success, true);
    assert.equal(r.data?.sortDir, "desc");
  });

  it("rejects an unknown sortBy column", () => {
    const r = listUserCommunitiesQuerySchema.safeParse({ sortBy: "karma" });
    assert.equal(r.success, false);
  });

  it("rejects an invalid sortOrder", () => {
    const r = listUserCommunitiesQuerySchema.safeParse({
      sortBy: "name",
      sortOrder: "sideways",
    });
    assert.equal(r.success, false);
  });
});

describe("listUserCommunitiesQuerySchema — pagination", () => {
  it("defaults page=1 limit=20 and coerces strings", () => {
    const r = listUserCommunitiesQuerySchema.safeParse({});
    assert.equal(r.data?.page, 1);
    assert.equal(r.data?.limit, 20);
    const r2 = listUserCommunitiesQuerySchema.safeParse({
      page: "3",
      limit: "50",
    });
    assert.equal(r2.data?.page, 3);
    assert.equal(r2.data?.limit, 50);
  });

  it("rejects a limit above the max of 100", () => {
    const r = listUserCommunitiesQuerySchema.safeParse({ limit: "101" });
    assert.equal(r.success, false);
  });
});

describe("listOtherMembersQuerySchema — search + email detection", () => {
  it("maps `q` onto `search` and flags a non-email search", () => {
    const r = listOtherMembersQuerySchema.safeParse({ q: "john_doe" });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, "john_doe");
    assert.equal(r.data?.searchIsEmail, false);
  });

  it("flags an email search (value contains @)", () => {
    const r = listOtherMembersQuerySchema.safeParse({
      q: "john@example.com",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, "john@example.com");
    assert.equal(r.data?.searchIsEmail, true);
  });

  it("prefers `q` over `search`", () => {
    const r = listOtherMembersQuerySchema.safeParse({
      q: "wins",
      search: "loses",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, "wins");
  });

  it("leaves searchIsEmail false when no search is provided", () => {
    const r = listOtherMembersQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data?.search, undefined);
    assert.equal(r.data?.searchIsEmail, false);
  });

  it("flags an email via the legacy `search` alias (no `q`)", () => {
    const r = listOtherMembersQuerySchema.safeParse({ search: "x@y.com" });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, "x@y.com");
    assert.equal(r.data?.searchIsEmail, true);
  });

  it("does not flag a non-email legacy `search` alias (no `q`)", () => {
    const r = listOtherMembersQuerySchema.safeParse({ search: "plainuser" });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, "plainuser");
    assert.equal(r.data?.searchIsEmail, false);
  });
});

describe("listOtherMembersQuerySchema — role (OWNER→ADMIN)", () => {
  it("folds OWNER onto ADMIN", () => {
    const r = listOtherMembersQuerySchema.safeParse({ role: "OWNER" });
    assert.equal(r.success, true);
    assert.equal(r.data?.role, "ADMIN");
  });

  it("keeps ADMIN / MODERATOR / MEMBER as-is", () => {
    for (const role of ["ADMIN", "MODERATOR", "MEMBER"] as const) {
      const r = listOtherMembersQuerySchema.safeParse({ role });
      assert.equal(r.success, true);
      assert.equal(r.data?.role, role);
    }
  });

  it("leaves role undefined when omitted", () => {
    const r = listOtherMembersQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data?.role, undefined);
  });

  it("rejects an unknown role", () => {
    const r = listOtherMembersQuerySchema.safeParse({ role: "GHOST" });
    assert.equal(r.success, false);
  });
});

describe("listOtherMembersQuerySchema — sort mapping + defaults", () => {
  it('defaults sortField/sortDir to "" (community-service default order)', () => {
    const r = listOtherMembersQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data?.sortField, "");
    assert.equal(r.data?.sortDir, "");
  });

  it("maps sortBy=joinedDate onto joinedAt with asc default dir", () => {
    const r = listOtherMembersQuerySchema.safeParse({ sortBy: "joinedDate" });
    assert.equal(r.success, true);
    assert.equal(r.data?.sortField, "joinedAt");
    assert.equal(r.data?.sortDir, "asc");
  });

  it("maps sortBy=username and honors explicit sortOrder", () => {
    const r = listOtherMembersQuerySchema.safeParse({
      sortBy: "username",
      sortOrder: "desc",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sortField, "username");
    assert.equal(r.data?.sortDir, "desc");
  });

  it('ignores an orphan sortOrder (no sortField → "")', () => {
    const r = listOtherMembersQuerySchema.safeParse({ sortOrder: "desc" });
    assert.equal(r.success, true);
    assert.equal(r.data?.sortField, "");
    assert.equal(r.data?.sortDir, "");
  });

  it("rejects an unknown sortBy column", () => {
    const r = listOtherMembersQuerySchema.safeParse({ sortBy: "karma" });
    assert.equal(r.success, false);
  });
});

describe("userCommunityMembersParamSchema", () => {
  it("accepts a userId + communityId pair", () => {
    const r = userCommunityMembersParamSchema.safeParse({
      userId: "u_1",
      communityId: "comm_1",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.userId, "u_1");
    assert.equal(r.data?.communityId, "comm_1");
  });

  it("rejects a missing communityId", () => {
    const r = userCommunityMembersParamSchema.safeParse({ userId: "u_1" });
    assert.equal(r.success, false);
  });

  it("rejects an empty userId", () => {
    const r = userCommunityMembersParamSchema.safeParse({
      userId: "",
      communityId: "comm_1",
    });
    assert.equal(r.success, false);
  });
});
