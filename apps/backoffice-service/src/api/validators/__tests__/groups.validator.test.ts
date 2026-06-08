/**
 * Unit tests for the Group Management admin query validators. Pure schema
 * checks — no env / DB / Redis / gRPC needed. Run via
 * `tsx --test src/**\/*.test.ts`.
 *
 * Mirrors users.validator.test.ts style. Covers list-groups + list-members
 * query schemas: page/limit defaults & bounds, sortBy/sortOrder enums, role
 * enum, q trim, optional date fields.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  listGroupsQuerySchema,
  listGroupMembersQuerySchema,
} from "../groups.validator.js";

describe("listGroupsQuerySchema — pagination defaults & bounds", () => {
  it("applies defaults when nothing is provided", () => {
    const r = listGroupsQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data?.page, 1);
    assert.equal(r.data?.limit, 20);
    assert.equal(r.data?.sortBy, "createdAt");
    assert.equal(r.data?.sortOrder, "desc");
  });

  it("coerces string page/limit to numbers", () => {
    const r = listGroupsQuerySchema.safeParse({ page: "3", limit: "50" });
    assert.equal(r.success, true);
    assert.equal(r.data?.page, 3);
    assert.equal(r.data?.limit, 50);
  });

  it("accepts limit at the upper bound of 100", () => {
    const r = listGroupsQuerySchema.safeParse({ limit: "100" });
    assert.equal(r.success, true);
    assert.equal(r.data?.limit, 100);
  });

  it("rejects limit > 100", () => {
    const r = listGroupsQuerySchema.safeParse({ limit: "101" });
    assert.equal(r.success, false);
  });

  it("rejects limit < 1", () => {
    const r = listGroupsQuerySchema.safeParse({ limit: "0" });
    assert.equal(r.success, false);
  });

  it("rejects page < 1", () => {
    const r = listGroupsQuerySchema.safeParse({ page: "0" });
    assert.equal(r.success, false);
  });

  it("rejects a non-integer page", () => {
    const r = listGroupsQuerySchema.safeParse({ page: "1.5" });
    assert.equal(r.success, false);
  });
});

describe("listGroupsQuerySchema — sort enums", () => {
  it("accepts sortBy=memberCount", () => {
    const r = listGroupsQuerySchema.safeParse({ sortBy: "memberCount" });
    assert.equal(r.success, true);
    assert.equal(r.data?.sortBy, "memberCount");
  });

  it("rejects an unknown sortBy value", () => {
    const r = listGroupsQuerySchema.safeParse({ sortBy: "name" });
    assert.equal(r.success, false);
  });

  it("accepts sortOrder=asc", () => {
    const r = listGroupsQuerySchema.safeParse({ sortOrder: "asc" });
    assert.equal(r.success, true);
    assert.equal(r.data?.sortOrder, "asc");
  });

  it("rejects an unknown sortOrder value", () => {
    const r = listGroupsQuerySchema.safeParse({ sortOrder: "ascending" });
    assert.equal(r.success, false);
  });
});

describe("listGroupsQuerySchema — q + date fields", () => {
  it("trims q", () => {
    const r = listGroupsQuerySchema.safeParse({ q: "  acme  " });
    assert.equal(r.success, true);
    assert.equal(r.data?.q, "acme");
  });

  it("rejects an empty q (min length 1 after trim)", () => {
    const r = listGroupsQuerySchema.safeParse({ q: "   " });
    assert.equal(r.success, false);
  });

  it("leaves q undefined when omitted", () => {
    const r = listGroupsQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data?.q, undefined);
  });

  it("accepts valid ISO date fromDate/toDate", () => {
    const r = listGroupsQuerySchema.safeParse({
      fromDate: "2025-01-01",
      toDate: "2025-12-31",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.fromDate, "2025-01-01");
    assert.equal(r.data?.toDate, "2025-12-31");
  });

  it("leaves fromDate/toDate undefined when omitted (optional)", () => {
    const r = listGroupsQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data?.fromDate, undefined);
    assert.equal(r.data?.toDate, undefined);
  });

  it("rejects a malformed fromDate", () => {
    const r = listGroupsQuerySchema.safeParse({ fromDate: "01-01-2025" });
    assert.equal(r.success, false);
  });
});

describe("listGroupMembersQuerySchema", () => {
  it("applies pagination defaults", () => {
    const r = listGroupMembersQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data?.page, 1);
    assert.equal(r.data?.limit, 20);
  });

  it("rejects limit > 100", () => {
    const r = listGroupMembersQuerySchema.safeParse({ limit: "101" });
    assert.equal(r.success, false);
  });

  it("rejects page < 1", () => {
    const r = listGroupMembersQuerySchema.safeParse({ page: "0" });
    assert.equal(r.success, false);
  });

  it("accepts each valid role enum value", () => {
    for (const role of ["OWNER", "ADMIN", "MODERATOR", "MEMBER"]) {
      const r = listGroupMembersQuerySchema.safeParse({ role });
      assert.equal(r.success, true, `role=${role} should be valid`);
      assert.equal(r.data?.role, role);
    }
  });

  it("rejects an unknown role value", () => {
    const r = listGroupMembersQuerySchema.safeParse({ role: "GUEST" });
    assert.equal(r.success, false);
  });

  it("rejects a lower-case role (enum is case-sensitive)", () => {
    const r = listGroupMembersQuerySchema.safeParse({ role: "member" });
    assert.equal(r.success, false);
  });

  it("leaves role undefined when omitted (optional)", () => {
    const r = listGroupMembersQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data?.role, undefined);
  });

  it("trims q", () => {
    const r = listGroupMembersQuerySchema.safeParse({ q: "  bob  " });
    assert.equal(r.success, true);
    assert.equal(r.data?.q, "bob");
  });
});
