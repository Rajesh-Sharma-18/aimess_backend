/**
 * Unit tests for the Audit Logs list-query + id-param validators. Pure schema
 * checks — no env / DB / Redis / gRPC needed. Run via `tsx --test src/**\/*.test.ts`.
 *
 * Focus: sensible defaults ("sort by latest"), repeatable `action` filter
 * normalization (single → array), and rejection of malformed sort/paging/date.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  auditLogIdParamSchema,
  listAuditLogsQuerySchema,
} from "../audit-log.validator.js";

describe("listAuditLogsQuerySchema — defaults", () => {
  it("defaults page/limit/sort when nothing is provided", () => {
    const r = listAuditLogsQuerySchema.safeParse({});
    assert.equal(r.success, true);
    assert.equal(r.data?.page, 1);
    assert.equal(r.data?.limit, 20);
    assert.equal(r.data?.sort, "createdAt:desc");
    assert.equal(r.data?.action, undefined);
    assert.equal(r.data?.search, undefined);
  });
});

describe("listAuditLogsQuerySchema — action filter", () => {
  it("normalizes a single action to a one-element array", () => {
    const r = listAuditLogsQuerySchema.safeParse({ action: "user.banned" });
    assert.equal(r.success, true);
    assert.deepEqual(r.data?.action, ["user.banned"]);
  });

  it("keeps a repeated action as an array", () => {
    const r = listAuditLogsQuerySchema.safeParse({
      action: ["user.banned", "user.suspended"],
    });
    assert.equal(r.success, true);
    assert.deepEqual(r.data?.action, ["user.banned", "user.suspended"]);
  });
});

describe("listAuditLogsQuerySchema — coercion + filters", () => {
  it("coerces string page/limit to numbers", () => {
    const r = listAuditLogsQuerySchema.safeParse({ page: "3", limit: "50" });
    assert.equal(r.success, true);
    assert.equal(r.data?.page, 3);
    assert.equal(r.data?.limit, 50);
  });

  it("accepts action:asc as a valid sort", () => {
    const r = listAuditLogsQuerySchema.safeParse({ sort: "action:asc" });
    assert.equal(r.success, true);
    assert.equal(r.data?.sort, "action:asc");
  });

  it("accepts a date range", () => {
    const r = listAuditLogsQuerySchema.safeParse({
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
    });
    assert.equal(r.success, true);
    assert.equal(r.data?.dateFrom, "2026-01-01");
    assert.equal(r.data?.dateTo, "2026-12-31");
  });
});

describe("listAuditLogsQuerySchema — rejections", () => {
  it("rejects an unknown sort field", () => {
    const r = listAuditLogsQuerySchema.safeParse({ sort: "performer:asc" });
    assert.equal(r.success, false);
  });

  it("rejects a malformed sort token", () => {
    const r = listAuditLogsQuerySchema.safeParse({ sort: "bogus" });
    assert.equal(r.success, false);
  });

  it("rejects a limit over the max", () => {
    const r = listAuditLogsQuerySchema.safeParse({ limit: "500" });
    assert.equal(r.success, false);
  });

  it("rejects a non-positive page", () => {
    const r = listAuditLogsQuerySchema.safeParse({ page: "0" });
    assert.equal(r.success, false);
  });

  it("rejects a malformed date", () => {
    const r = listAuditLogsQuerySchema.safeParse({ dateFrom: "07-2026" });
    assert.equal(r.success, false);
  });
});

describe("auditLogIdParamSchema", () => {
  it("accepts a uuid", () => {
    const r = auditLogIdParamSchema.safeParse({
      auditLogId: "3f2b6c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b",
    });
    assert.equal(r.success, true);
  });

  it("rejects a non-uuid", () => {
    const r = auditLogIdParamSchema.safeParse({ auditLogId: "not-a-uuid" });
    assert.equal(r.success, false);
  });
});
