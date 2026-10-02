jest.mock("../../src/services/audit.service.js", () => ({
  auditService: { record: jest.fn(async () => ({ id: "audit-1" })) },
}));

import { AUDIT_ACTIONS } from "../../src/constants/index.js";
import { streamClient } from "../../src/grpc/stream.client.js";
import { auditService } from "../../src/services/audit.service.js";
import { livestreamService } from "../../src/services/livestream.service.js";

const stream = streamClient as unknown as Record<string, jest.Mock>;
const record = auditService.record as jest.Mock;
const actor = { id: "admin-1", name: "Super Admin" } as Parameters<
  typeof livestreamService.bulkEnd
>[2];
const ctx = { ip: "127.0.0.1", userAgent: "jest" };

describe("livestreamService.bulkEnd audit", () => {
  it("writes the batch summary plus one LIVESTREAM_ENDED row per ended stream", async () => {
    stream.adminGetStream.mockImplementation(async (id: string) =>
      id === "s-done" ? { id, status: "ENDED" } : { id, status: "LIVE" }
    );
    stream.adminForceEnd.mockResolvedValue({ success: true, status: "ENDED" });

    const result = await livestreamService.bulkEnd(
      ["s-1", "s-done", "s-2"],
      { reasonCode: "MANUAL_ADMIN", note: "spam" },
      actor,
      ctx
    );

    expect(result).toMatchObject({ requested: 3, succeeded: 2, failed: 1 });
    const actions = record.mock.calls.map(([row]) => [row.action, row.targetId]);
    expect(actions).toEqual([
      [AUDIT_ACTIONS.LIVESTREAM_BULK_ENDED, null],
      [AUDIT_ACTIONS.LIVESTREAM_ENDED, "s-1"],
      [AUDIT_ACTIONS.LIVESTREAM_ENDED, "s-2"],
    ]);
    expect(record.mock.calls[1][0].after).toMatchObject({
      reasonCode: "MANUAL_ADMIN",
      note: "spam",
      bulk: true,
    });
  });
});
