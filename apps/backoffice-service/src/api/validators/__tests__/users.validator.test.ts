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
  banUserSchema,
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

describe("listUsersQuerySchema — sortBy / sortOrder", () => {
  it("maps sortBy=username onto the canonical sort token", () => {
    const r = listUsersQuerySchema.safeParse({
      sortBy: "username",
      sortOrder: "asc",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "username:asc");
    assert.equal(r.data?.sortBy, "username");
    assert.equal(r.data?.sortOrder, "asc");
  });

  it("maps sortBy=joinedDate onto the joinedAt column", () => {
    const r = listUsersQuerySchema.safeParse({
      sortBy: "joinedDate",
      sortOrder: "desc",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "joinedAt:desc");
    assert.equal(r.data?.sortBy, "joinedDate");
  });

  it("maps sortBy=reports onto the reportCount column", () => {
    const r = listUsersQuerySchema.safeParse({
      sortBy: "reports",
      sortOrder: "desc",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "reportCount:desc");
    assert.equal(r.data?.sortBy, "reports");
  });

  it("defaults sortOrder to desc when only sortBy is given", () => {
    const r = listUsersQuerySchema.safeParse({ sortBy: "email" });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "email:desc");
    assert.equal(r.data?.sortOrder, "desc");
  });

  it("is case-insensitive and tolerates the canonical column names", () => {
    const r = listUsersQuerySchema.safeParse({
      sortBy: "ReportCount",
      sortOrder: "ASC",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "reportCount:asc");
    assert.equal(r.data?.sortBy, "reports");
  });

  it("prefers sortBy over the legacy sort param", () => {
    const r = listUsersQuerySchema.safeParse({
      sort: "email:asc",
      sortBy: "username",
      sortOrder: "desc",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "username:desc");
  });

  it("echoes the UI sort pair even when the legacy sort param is used", () => {
    const r = listUsersQuerySchema.safeParse({ sort: "reportCount:asc" });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "reportCount:asc");
    assert.equal(r.data?.sortBy, "reports");
    assert.equal(r.data?.sortOrder, "asc");
  });

  it("ignores sortOrder when sortBy is absent — falls back to the legacy/default sort", () => {
    // `sortOrder` only takes effect alongside `sortBy`. On its own it must NOT
    // hijack the default `joinedAt:desc`, and the echoed UI pair must reflect
    // the resolved (default) sort, not the orphaned sortOrder.
    const r = listUsersQuerySchema.safeParse({ sortOrder: "asc" });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "joinedAt:desc");
    assert.equal(r.data?.sortBy, "joinedDate");
    assert.equal(r.data?.sortOrder, "desc");
  });

  it("accepts a bare `sort` field (no :dir) + `order` — the Swagger form shape", () => {
    const r = listUsersQuerySchema.safeParse({
      sort: "username",
      order: "desc",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "username:desc");
    assert.equal(r.data?.sortBy, "username");
    assert.equal(r.data?.sortOrder, "desc");
  });

  it("defaults a bare `sort` field with no order to desc", () => {
    const r = listUsersQuerySchema.safeParse({ sort: "reportCount" });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "reportCount:desc");
    assert.equal(r.data?.sortBy, "reports");
  });

  it("rejects an unknown sortBy column", () => {
    const r = listUsersQuerySchema.safeParse({ sortBy: "karma" });
    assert.equal(r.success, false);
  });

  it("still rejects an unknown bare `sort` field", () => {
    const r = listUsersQuerySchema.safeParse({ sort: "karma" });
    assert.equal(r.success, false);
  });

  it("rejects an invalid sortOrder", () => {
    const r = listUsersQuerySchema.safeParse({
      sortBy: "username",
      sortOrder: "sideways",
    });
    assert.equal(r.success, false);
  });
});

describe("banUserSchema — reason (predefined code OR custom text)", () => {
  it("accepts a predefined reason code", () => {
    const r = banUserSchema.safeParse({ reason: "SPAM" });
    assert.equal(r.success, true);
    assert.equal(r.data?.reason, "SPAM");
  });

  it("accepts a custom free-text reason", () => {
    const r = banUserSchema.safeParse({
      reason: "Repeated harassment across multiple communities",
    });
    assert.equal(r.success, true);
    assert.equal(
      r.data?.reason,
      "Repeated harassment across multiple communities"
    );
  });

  it("trims a custom reason", () => {
    const r = banUserSchema.safeParse({ reason: "  Custom reason  " });
    assert.equal(r.success, true);
    assert.equal(r.data?.reason, "Custom reason");
  });

  it("rejects a missing reason", () => {
    const r = banUserSchema.safeParse({});
    assert.equal(r.success, false);
  });

  it("rejects an empty/whitespace-only reason", () => {
    const r = banUserSchema.safeParse({ reason: "   " });
    assert.equal(r.success, false);
  });

  it("rejects a reason over 200 characters", () => {
    const r = banUserSchema.safeParse({ reason: "x".repeat(201) });
    assert.equal(r.success, false);
  });

  it("accepts a reason at exactly the 200-character limit", () => {
    const r = banUserSchema.safeParse({ reason: "x".repeat(200) });
    assert.equal(r.success, true);
  });

  it("rejects a non-string (NoSQL-injection-shaped) reason", () => {
    const r = banUserSchema.safeParse({ reason: { $ne: null } });
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
