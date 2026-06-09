/**
 * Unit tests for the Community Management list-query validator. Pure schema
 * checks — no env / DB / Redis / gRPC needed. Run via
 * `tsx --test src/**\/*.test.ts`.
 *
 * Focus: the admin panel's sortBy/sortOrder column-sort controls and their
 * normalization onto the canonical `<field>:<dir>` token the gRPC repo consumes,
 * plus the resolved UI pair echoed for the COMMUNITY_LIST_VIEWED audit log.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listCommunitiesQuerySchema } from "../community.validator.js";

describe("listCommunitiesQuerySchema — defaults", () => {
  it("defaults to createdDate / desc when no sort is provided", () => {
    const r = listCommunitiesQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data?.page, 1);
    assert.equal(r.data?.limit, 20);
    assert.equal(r.data?.sort, "createdAt:desc");
    assert.equal(r.data?.sortBy, "createdDate");
    assert.equal(r.data?.sortOrder, "desc");
  });
});

describe("listCommunitiesQuerySchema — sortBy/sortOrder mapping", () => {
  it("maps sortBy=category -> categoryName", () => {
    const r = listCommunitiesQuerySchema.safeParse({
      sortBy: "category",
      sortOrder: "asc",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "categoryName:asc");
    assert.equal(r.data?.sortBy, "category");
    assert.equal(r.data?.sortOrder, "asc");
  });

  it("maps sortBy=members -> memberCount", () => {
    const r = listCommunitiesQuerySchema.safeParse({
      sortBy: "members",
      sortOrder: "desc",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "memberCount:desc");
    assert.equal(r.data?.sortBy, "members");
  });

  it("maps sortBy=createdDate -> createdAt", () => {
    const r = listCommunitiesQuerySchema.safeParse({
      sortBy: "createdDate",
      sortOrder: "asc",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "createdAt:asc");
  });

  it("is case-insensitive and tolerates canonical-column aliases", () => {
    const r = listCommunitiesQuerySchema.safeParse({
      sortBy: "MemberCount",
      sortOrder: "DESC",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "memberCount:desc");
    assert.equal(r.data?.sortBy, "members");
  });

  it("defaults sortOrder to desc when only sortBy is given", () => {
    const r = listCommunitiesQuerySchema.safeParse({ sortBy: "category" });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "categoryName:desc");
    assert.equal(r.data?.sortOrder, "desc");
  });

  it("rejects an unknown sortBy value", () => {
    const r = listCommunitiesQuerySchema.safeParse({ sortBy: "bananas" });
    assert.equal(r.success, false);
  });
});

describe("listCommunitiesQuerySchema — legacy `sort` back-compat", () => {
  it("still honors the legacy <field>:<dir> token when sortBy is absent", () => {
    const r = listCommunitiesQuerySchema.safeParse({ sort: "name:asc" });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "name:asc");
    assert.equal(r.data?.sortBy, "name");
    assert.equal(r.data?.sortOrder, "asc");
  });

  it("lets sortBy/sortOrder win over the legacy sort token", () => {
    const r = listCommunitiesQuerySchema.safeParse({
      sort: "name:asc",
      sortBy: "members",
      sortOrder: "desc",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "memberCount:desc");
  });

  it("rejects a malformed legacy sort token", () => {
    const r = listCommunitiesQuerySchema.safeParse({ sort: "bogus" });
    assert.equal(r.success, false);
  });
});
