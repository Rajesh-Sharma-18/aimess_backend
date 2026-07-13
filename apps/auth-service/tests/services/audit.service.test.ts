/**
 * authAuditService — persists every QR-login lifecycle + linked-device event
 * into AuthAuditLog (auth-service's own audit trail; see schema.prisma for why
 * this isn't backoffice's admin-only AuditLog). Must never throw — a DB hiccup
 * here can't be allowed to fail the QR approval / login request it's auditing.
 */
jest.mock("../../src/repositories/auth-audit-log.repository.js", () => ({
  authAuditLogRepository: { create: jest.fn() },
}));

import { authAuditLogRepository } from "../../src/repositories/auth-audit-log.repository.js";
import {
  authAuditService,
  recordAuditEventSafe,
} from "../../src/services/audit.service.js";

const create = authAuditLogRepository.create as unknown as jest.Mock;

describe("authAuditService.record", () => {
  beforeEach(() => create.mockReset());

  it("persists the event via the repository", async () => {
    create.mockResolvedValue({ id: "row-1" });

    await authAuditService.record({
      event: "QR_CREATED",
      targetType: "qr_login_session",
      targetId: "link-token-123",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "QR_CREATED",
        targetType: "qr_login_session",
        targetId: "link-token-123",
      })
    );
  });

  it("never throws when the repository write fails", async () => {
    create.mockRejectedValue(new Error("DB unavailable"));

    await expect(
      authAuditService.record({
        event: "QR_EXPIRED",
        targetType: "qr_login_session",
      })
    ).resolves.toBeUndefined();
  });
});

describe("recordAuditEventSafe", () => {
  it("is fire-and-forget — returns synchronously without awaiting the write", () => {
    create.mockResolvedValue({ id: "row-2" });

    expect(() =>
      recordAuditEventSafe({
        event: "QR_SCANNED",
        targetType: "qr_login_session",
      })
    ).not.toThrow();
  });
});
