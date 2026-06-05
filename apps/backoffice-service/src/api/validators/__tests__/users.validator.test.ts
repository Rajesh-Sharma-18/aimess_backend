/**
 * Unit tests for the admin user-listing query validator. Pure schema checks —
 * no env / DB / Redis needed. Run via `tsx --test src/**\/*.test.ts`.
 *
 * Focus: the `q` search param must reach the service layer as `search`
 * (previously `q` was an unknown key, silently stripped, so search was inert).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  listUsersQuerySchema,
  userReportsQuerySchema,
} from "../users.validator.js";

describe("listUsersQuerySchema — search param", () => {
  it("maps the public `q` param onto `search`", () => {
    const r = listUsersQuerySchema.safeParse({
      page: "1",
      limit: "20",
      q: "vasu",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, "vasu");
  });

  it("trims `q` and applies it as `search`", () => {
    const r = listUsersQuerySchema.safeParse({ q: "  gmail  " });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, "gmail");
  });

  it("keeps the legacy `search` param working", () => {
    const r = listUsersQuerySchema.safeParse({ search: "123" });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, "123");
  });

  it("prefers `q` over `search` when both are present", () => {
    const r = listUsersQuerySchema.safeParse({ q: "wins", search: "loses" });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, "wins");
  });

  it("leaves `search` undefined when neither is provided", () => {
    const r = listUsersQuerySchema.safeParse({ page: "1", limit: "20" });
    assert.equal(r.success, true);
    assert.equal(r.data?.search, undefined);
  });

  it("rejects an empty `q` (min length 1 after trim)", () => {
    const r = listUsersQuerySchema.safeParse({ q: "   " });
    assert.equal(r.success, false);
  });

  it("applies `order` as the sort direction override", () => {
    const r = listUsersQuerySchema.safeParse({
      sort: "username:asc",
      order: "desc",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "username:desc");
  });

  it("defaults sort to joinedAt:desc and applies pagination coercion", () => {
    const r = listUsersQuerySchema.safeParse({
      q: "vasu",
      page: "2",
      limit: "50",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "joinedAt:desc");
    assert.equal(r.data?.page, 2);
    assert.equal(r.data?.limit, 50);
  });
});

describe("userReportsQuerySchema — pagination", () => {
  it("defaults page=1 and limit=20 when omitted", () => {
    const r = userReportsQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data?.page, 1);
    assert.equal(r.data?.limit, 20);
  });

  it("coerces string page/limit to numbers", () => {
    const r = userReportsQuerySchema.safeParse({ page: "2", limit: "50" });
    assert.equal(r.success, true);
    assert.equal(r.data?.page, 2);
    assert.equal(r.data?.limit, 50);
  });

  it("rejects limit above the max of 100", () => {
    const r = userReportsQuerySchema.safeParse({ limit: "101" });
    assert.equal(r.success, false);
  });
});

describe("listUsersQuerySchema — status filter (case-insensitive)", () => {
  it("accepts a lowercase status from the dropdown", () => {
    const r = listUsersQuerySchema.safeParse({ status: "active" });
    assert.equal(r.success, true);
    assert.deepEqual(r.data?.status, ["ACTIVE"]);
  });

  it("accepts a repeated lowercase status list", () => {
    const r = listUsersQuerySchema.safeParse({ status: ["active", "banned"] });
    assert.equal(r.success, true);
    assert.deepEqual(r.data?.status, ["ACTIVE", "BANNED"]);
  });

  it("maps the `pending_deletion` alias onto DELETED", () => {
    const r = listUsersQuerySchema.safeParse({ status: "pending_deletion" });
    assert.equal(r.success, true);
    assert.deepEqual(r.data?.status, ["DELETED"]);
  });

  it("keeps UPPERCASE status working", () => {
    const r = listUsersQuerySchema.safeParse({ status: "BANNED" });
    assert.equal(r.success, true);
    assert.deepEqual(r.data?.status, ["BANNED"]);
  });

  it("rejects an unknown status value", () => {
    const r = listUsersQuerySchema.safeParse({ status: "frozen" });
    assert.equal(r.success, false);
  });

  it("rejects SUSPENDED — not a panel filter option (only active/banned/deleted)", () => {
    const r = listUsersQuerySchema.safeParse({ status: "suspended" });
    assert.equal(r.success, false);
  });
});

describe("listUsersQuerySchema — date range filter", () => {
  it("accepts a YYYY-MM-DD range", () => {
    const r = listUsersQuerySchema.safeParse({
      dateFrom: "2026-01-01",
      dateTo: "2026-06-01",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.dateFrom, "2026-01-01");
    assert.equal(r.data?.dateTo, "2026-06-01");
  });

  it("normalizes a full ISO datetime to YYYY-MM-DD", () => {
    const r = listUsersQuerySchema.safeParse({
      dateFrom: "2026-01-01T10:30:00.000Z",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.dateFrom, "2026-01-01");
  });

  it("accepts `createdAfter`/`createdBefore` as range aliases", () => {
    const r = listUsersQuerySchema.safeParse({
      createdAfter: "2026-01-01",
      createdBefore: "2026-06-01",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.dateFrom, "2026-01-01");
    assert.equal(r.data?.dateTo, "2026-06-01");
  });

  it("rejects a malformed date", () => {
    const r = listUsersQuerySchema.safeParse({ dateFrom: "01-2026" });
    assert.equal(r.success, false);
  });
});
