// Unit tests for handleActivityIngest — the website-activity ingest path. The handler
// validates an AdminActivityIngestPayload and writes one admin_db.AuditLog row; anything
// malformed MUST throw so the consumer nacks and the message dead-letters.
// Mirrors consume-admin-report-ingest.test.ts: node:test + runtime prisma patching, no DB.
// Run via `npx tsx --test "src/**/*.test.ts"` (these files are outside the jest roots).
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { USER_AUDIT_ACTIONS } from "@aimess/messaging";
import type { AdminActivityIngestPayload } from "@aimess/shared-types";

import { prisma } from "../../config/prisma.js";
import { handleActivityIngest } from "../consume-admin-activity-ingest.js";

let createCalls: Array<{ data: Record<string, unknown> }>;
let nextCreateError: unknown;

function uniqueConstraintError(): Error & { code: string } {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });
}

// Cast through unknown: the handler only ever touches `prisma.auditLog.create`.
(
  prisma as unknown as {
    auditLog: { create: (args: unknown) => Promise<unknown> };
  }
).auditLog = {
  create: (args: unknown) => {
    createCalls.push(args as { data: Record<string, unknown> });
    if (nextCreateError !== undefined) {
      const err = nextCreateError;
      nextCreateError = undefined;
      return Promise.reject(err);
    }
    return Promise.resolve({ id: "audit_1" });
  },
};

const ACTOR = "11111111-2222-3333-4444-555555555555";

function validPayload(
  overrides: Partial<AdminActivityIngestPayload> = {}
): AdminActivityIngestPayload {
  return {
    actorId: ACTOR,
    actorType: "USER",
    action: USER_AUDIT_ACTIONS.USER_LOGIN,
    targetType: "session",
    targetId: "sess_1",
    eventAt: "2026-08-13T10:00:00.000Z",
    eventId: "evt_1",
    ...overrides,
  };
}

describe("handleActivityIngest", () => {
  beforeEach(() => {
    createCalls = [];
    nextCreateError = undefined;
  });

  it("writes one AuditLog row stamped with the event time, not ingest time", async () => {
    await handleActivityIngest(validPayload());
    assert.equal(createCalls.length, 1);
    const data = createCalls[0].data;
    assert.equal(data.actorId, ACTOR);
    assert.equal(data.actorType, "USER");
    assert.equal(data.action, "user.login");
    assert.equal(data.eventId, "evt_1");
    assert.equal(
      (data.createdAt as Date).toISOString(),
      "2026-08-13T10:00:00.000Z"
    );
  });

  it("swallows a redelivered event (unique eventId) instead of duplicating", async () => {
    nextCreateError = uniqueConstraintError();
    await handleActivityIngest(validPayload());
    assert.equal(createCalls.length, 1);
  });

  it("rejects an action outside the shared catalogue", async () => {
    await assert.rejects(
      () => handleActivityIngest(validPayload({ action: "message.sent" })),
      /Unknown admin.activity.ingest action/
    );
    assert.equal(createCalls.length, 0);
  });

  it("rejects a USER row whose actorId is not a uuid", async () => {
    await assert.rejects(
      () => handleActivityIngest(validPayload({ actorId: "not-a-uuid" })),
      /missing a valid actorId/
    );
    assert.equal(createCalls.length, 0);
  });

  it("accepts a SYSTEM row with no actor", async () => {
    await handleActivityIngest(
      validPayload({ actorId: null, actorType: "SYSTEM" })
    );
    assert.equal(createCalls[0].data.actorId, null);
    assert.equal(createCalls[0].data.actorType, "SYSTEM");
  });

  it("throws on a payload missing its idempotency key", async () => {
    await assert.rejects(
      () => handleActivityIngest(validPayload({ eventId: "" })),
      /Malformed admin.activity.ingest payload/
    );
  });
});
