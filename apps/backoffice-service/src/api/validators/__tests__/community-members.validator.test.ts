/**
 * Unit tests for the Community Member List admin query validator. Pure schema
 * checks — no env / DB / Redis / gRPC needed. Run via
 * `tsx --test src/api/validators/__tests__/community-members.validator.test.ts`.
 *
 * Mirrors groups.validator.test.ts style. Covers the list-members query schema:
 * page/limit defaults & bounds, the `q`→`search` alias, and the role enum.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listCommunityMembersQuerySchema } from "../community.validator.js";

describe("listCommunityMembersQuerySchema — pagination defaults & bounds", () => {
  it("applies defaults when nothing is provided", () => {
    const r = listCommunityMembersQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data?.page, 1);
    assert.equal(r.data?.limit, 20);
  });

  it("coerces string page/limit to numbers", () => {
    const r = listCommunityMembersQuerySchema.safeParse({
      page: "3",
      limit: "50",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.page, 3);
    assert.equal(r.data?.limit, 50);
  });

  it("accepts limit at the upper bound of 100", () => {
    const r = listCommunityMembersQuerySchema.safeParse({ limit: "100" });
    assert.equal(r.success, true);
    assert.equal(r.data?.limit, 100);
  });

  it("rejects limit > 100", () => {
    const r = listCommunityMembersQuerySchema.safeParse({ limit: "101" });
    assert.equal(r.success, false);
  });

  it("rejects limit < 1", () => {
    const r = listCommunityMembersQuerySchema.safeParse({ limit: "0" });
    assert.equal(r.success, false);
  });

  it("rejects page < 1", () => {
    const r = listCommunityMembersQuerySchema.safeParse({ page: "0" });
    assert.equal(r.success, false);
  });
});

describe("listCommunityMembersQuerySchema — q → search alias", () => {
  it("maps q to search", () => {
    const r = listCommunityMembersQuerySchema.safeParse({ q: "alice" });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, "alice");
  });

  it("trims q before mapping", () => {
    const r = listCommunityMembersQuerySchema.safeParse({ q: "  bob  " });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, "bob");
  });

  it("q wins over search when both are present", () => {
    const r = listCommunityMembersQuerySchema.safeParse({
      q: "from-q",
      search: "from-search",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, "from-q");
  });

  it("falls back to search when q is omitted", () => {
    const r = listCommunityMembersQuerySchema.safeParse({ search: "carol" });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, "carol");
  });

  it("leaves search undefined when neither q nor search is provided", () => {
    const r = listCommunityMembersQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data?.search, undefined);
  });
});

describe("listCommunityMembersQuerySchema — role enum", () => {
  it("accepts each valid role enum value", () => {
    for (const role of ["ADMIN", "MODERATOR", "MEMBER"]) {
      const r = listCommunityMembersQuerySchema.safeParse({ role });
      assert.equal(r.success, true, `role=${role} should be valid`);
      assert.equal(r.data?.role, role);
    }
  });

  it("rejects an unknown role value", () => {
    const r = listCommunityMembersQuerySchema.safeParse({ role: "GUEST" });
    assert.equal(r.success, false);
  });

  it("rejects a lower-case role (enum is case-sensitive)", () => {
    const r = listCommunityMembersQuerySchema.safeParse({ role: "member" });
    assert.equal(r.success, false);
  });

  it("leaves role undefined when omitted (optional)", () => {
    const r = listCommunityMembersQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data?.role, undefined);
  });
});

describe("listCommunityMembersQuerySchema — sort", () => {
  it("defaults to joinedAt:desc when sort is omitted", () => {
    const r = listCommunityMembersQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data?.sortField, "joinedAt");
    assert.equal(r.data?.sortDir, "desc");
  });

  for (const field of ["username", "handle", "joinedAt"] as const) {
    for (const dir of ["asc", "desc"] as const) {
      it(`accepts sort=${field}:${dir}`, () => {
        const r = listCommunityMembersQuerySchema.safeParse({
          sort: `${field}:${dir}`,
        });
        assert.equal(r.success, true);
        assert.equal(r.data?.sortField, field);
        assert.equal(r.data?.sortDir, dir);
      });
    }
  }

  it("falls back to joinedAt:desc for an unknown sort field", () => {
    const r = listCommunityMembersQuerySchema.safeParse({
      sort: "avatarUrl:asc",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sortField, "joinedAt");
    assert.equal(r.data?.sortDir, "desc");
  });

  it("falls back to joinedAt:desc for an invalid order", () => {
    const r = listCommunityMembersQuerySchema.safeParse({
      sort: "username:sideways",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sortField, "joinedAt");
    assert.equal(r.data?.sortDir, "desc");
  });

  it("falls back to joinedAt:desc for a malformed sort token", () => {
    const r = listCommunityMembersQuerySchema.safeParse({ sort: "username" });
    assert.equal(r.success, true);
    assert.equal(r.data?.sortField, "joinedAt");
    assert.equal(r.data?.sortDir, "desc");
  });

  it("is case-sensitive (rejects uppercase field/order, falls back to default)", () => {
    const r = listCommunityMembersQuerySchema.safeParse({
      sort: "Username:ASC",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sortField, "joinedAt");
    assert.equal(r.data?.sortDir, "desc");
  });

  it("combines sort with search/role/pagination in one call", () => {
    const r = listCommunityMembersQuerySchema.safeParse({
      q: "alice",
      role: "MODERATOR",
      page: "2",
      limit: "10",
      sort: "handle:asc",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, "alice");
    assert.equal(r.data?.role, "MODERATOR");
    assert.equal(r.data?.page, 2);
    assert.equal(r.data?.limit, 10);
    assert.equal(r.data?.sortField, "handle");
    assert.equal(r.data?.sortDir, "asc");
  });
});
