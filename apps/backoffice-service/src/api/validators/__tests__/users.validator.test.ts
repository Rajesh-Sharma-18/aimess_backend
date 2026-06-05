/**
 * Unit tests for the admin user-listing query validator. Pure schema checks —
 * no env / DB / Redis needed. Run via `tsx --test src/**\/*.test.ts`.
 *
 * Focus: the `q` search param must reach the service layer as `search`
 * (previously `q` was an unknown key, silently stripped, so search was inert).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listUsersQuerySchema } from "../users.validator.js";

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
