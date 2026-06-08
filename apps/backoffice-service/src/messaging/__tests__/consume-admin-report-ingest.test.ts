/**
 * Unit tests for {@link handleReportIngest} — the riskiest new logic in the
 * admin report-ingestion path. The handler validates an
 * {@link AdminReportIngestPayload} and writes one admin_db.Report row; a
 * malformed payload MUST throw so the consumer nacks → dead-letters (it never
 * silently swallows a bad row).
 *
 * `handleReportIngest` calls the `prisma` singleton's `report.create` directly,
 * so we monkey-patch `prisma.report.create` with a capturing fake at runtime —
 * no live Postgres, no `prisma generate`. Style mirrors the existing *.test.ts
 * files (node:test + node:assert/strict, runtime singleton patching).
 *
 * Run via `tsx --test "src/**\/*.test.ts"`.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import type { AdminReportIngestPayload } from "@aimess/shared-types";

import { prisma } from "../../config/prisma.js";
import { handleReportIngest } from "../consume-admin-report-ingest.js";

// Capture every prisma.report.create call without touching a DB.
let createCalls: Array<{ data: Record<string, unknown> }>;
// When set, the next prisma.report.create rejects with this error instead of
// resolving — used to simulate a P2002 unique-constraint violation on redelivery.
let nextCreateError: unknown;

/** A minimal stand-in for Prisma's PrismaClientKnownRequestError (P2002). */
function uniqueConstraintError(): Error & { code: string } {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });
}

// Cast through unknown: the handler only ever touches `prisma.report.create`.
(
  prisma as unknown as {
    report: { create: (args: unknown) => Promise<unknown> };
  }
).report = {
  create: (args: unknown) => {
    createCalls.push(args as { data: Record<string, unknown> });
    if (nextCreateError !== undefined) {
      const err = nextCreateError;
      nextCreateError = undefined;
      return Promise.reject(err);
    }
    return Promise.resolve({ id: "rep_1" });
  },
};

function validPayload(
  overrides: Partial<AdminReportIngestPayload> = {}
): AdminReportIngestPayload {
  return {
    type: "user",
    targetId: "u_target",
    reporterId: "u_reporter",
    reason: "spam",
    details: null,
    eventAt: "2026-06-05T00:00:00.000Z",
    sourceReportId: "src_1",
    ...overrides,
  };
}

beforeEach(() => {
  createCalls = [];
  nextCreateError = undefined;
});

describe("handleReportIngest — happy path", () => {
  it("valid user report → calls prisma.report.create once with status open", async () => {
    await handleReportIngest(validPayload());

    assert.equal(createCalls.length, 1, "create called exactly once");
    assert.deepEqual(createCalls[0]!.data, {
      type: "user",
      targetId: "u_target",
      reporterId: "u_reporter",
      reason: "spam",
      details: null,
      status: "open",
      sourceReportId: "src_1",
    });
  });

  it("forwards sourceReportId (idempotency key) but NOT eventAt to the Report row", async () => {
    await handleReportIngest(validPayload({ details: "hi" }));

    const data = createCalls[0]!.data;
    assert.equal("eventAt" in data, false);
    assert.equal(data.sourceReportId, "src_1");
  });

  it("null details passes through as null", async () => {
    await handleReportIngest(validPayload({ details: null }));
    assert.equal(createCalls[0]!.data.details, null);
  });

  it("a provided details string passes through unchanged", async () => {
    await handleReportIngest(validPayload({ details: "  abusive content " }));
    assert.equal(createCalls[0]!.data.details, "  abusive content ");
  });

  it("accepts each valid type (user, community, message, stream)", async () => {
    for (const type of ["user", "community", "message", "stream"] as const) {
      createCalls = [];
      await handleReportIngest(validPayload({ type }));
      assert.equal(createCalls.length, 1, `type=${type} created a row`);
      assert.equal(createCalls[0]!.data.type, type);
    }
  });
});

describe("handleReportIngest — malformed payloads throw (→ nack/DLQ)", () => {
  /** Each case is a payload the handler MUST reject without writing a row. */
  const badCases: Array<{ name: string; payload: unknown }> = [
    {
      name: "missing targetId",
      payload: stripField(validPayload(), "targetId"),
    },
    {
      name: "empty targetId",
      payload: validPayload({ targetId: "" }),
    },
    {
      name: "missing reporterId",
      payload: stripField(validPayload(), "reporterId"),
    },
    {
      name: "empty reporterId",
      payload: validPayload({ reporterId: "" }),
    },
    { name: "missing reason", payload: stripField(validPayload(), "reason") },
    { name: "empty reason", payload: validPayload({ reason: "" }) },
    {
      name: "invalid type 'bogus'",
      // Bypass the union type to feed a runtime-invalid value.
      payload: { ...validPayload(), type: "bogus" },
    },
    { name: "null data", payload: null },
    { name: "undefined data", payload: undefined },
  ];

  for (const { name, payload } of badCases) {
    it(`throws and does not create for: ${name}`, async () => {
      await assert.rejects(
        () => handleReportIngest(payload as AdminReportIngestPayload),
        /Malformed admin\.report\.ingest payload/
      );
      assert.equal(createCalls.length, 0, "no Report row written");
    });
  }
});

describe("handleReportIngest — exactly-once on RabbitMQ redelivery", () => {
  it("swallows a P2002 unique-constraint violation (duplicate sourceReportId) as a no-op", async () => {
    // Simulate the redelivery: the row already exists, so the re-insert hits the
    // unique index on sourceReportId. The handler must NOT throw — throwing would
    // nack → dead-letter a message that was already successfully ingested.
    nextCreateError = uniqueConstraintError();

    await assert.doesNotReject(() => handleReportIngest(validPayload()));
    assert.equal(createCalls.length, 1, "create attempted exactly once");
  });

  it("re-throws non-P2002 errors so the consumer can nack/DLQ them", async () => {
    nextCreateError = Object.assign(new Error("connection lost"), {
      code: "P1001",
    });

    await assert.rejects(
      () => handleReportIngest(validPayload()),
      /connection lost/
    );
  });
});

/** Return a shallow clone of `obj` with `key` removed. */
function stripField<T extends object>(obj: T, key: keyof T): Partial<T> {
  const clone = { ...obj };
  delete clone[key];
  return clone;
}
