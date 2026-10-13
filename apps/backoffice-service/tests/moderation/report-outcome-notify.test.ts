// §7: resolve/dismiss tells the reporter the outcome (never who); WARN reaches the reported user.
const mockReport = { findUnique: jest.fn(), update: jest.fn() };
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    report: mockReport,
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ report: mockReport })
    ),
  },
}));
jest.mock("../../src/repositories/moderation-action.repository.js", () => ({
  moderationActionRepository: { create: jest.fn() },
}));
jest.mock("../../src/messaging/publish-admin-user-notify.js", () => ({
  publishReportOutcomeSafe: jest.fn(),
  publishAccountWarnedSafe: jest.fn(),
}));

import {
  publishAccountWarnedSafe,
  publishReportOutcomeSafe,
} from "../../src/messaging/publish-admin-user-notify.js";
import { PrismaReportRepository } from "../../src/repositories/report.repository.js";

const repo = new PrismaReportRepository();
const actor = { moderator: { id: "admin-1", name: "Ops" }, at: Date.now() } as never;
const row = {
  id: "r1",
  type: "message",
  targetId: "msg-1",
  reporterId: "reporter-1",
  reportedUserId: "offender-1",
  status: "open",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockReport.findUnique.mockResolvedValue(row);
});

it("resolve → ACTIONED to the reporter; WARN delivers the note to the reported user", async () => {
  await repo.resolve(
    "r1",
    { resolution: "WARNING_ISSUED", actionOnReportedUser: "WARN", note: "Be kind" } as never,
    actor
  );
  expect(publishReportOutcomeSafe).toHaveBeenCalledWith("reporter-1", "ACTIONED", "r1");
  expect(publishAccountWarnedSafe).toHaveBeenCalledWith("offender-1", "Be kind");
});

it("resolve without WARN sends no warning", async () => {
  await repo.resolve(
    "r1",
    { resolution: "ACTION_TAKEN", actionOnReportedUser: "NONE" } as never,
    actor
  );
  expect(publishReportOutcomeSafe).toHaveBeenCalledWith("reporter-1", "ACTIONED", "r1");
  expect(publishAccountWarnedSafe).not.toHaveBeenCalled();
});

it("dismiss → NO_ACTION to the reporter", async () => {
  await repo.dismiss("r1", { reason: "NO_VIOLATION" } as never, actor);
  expect(publishReportOutcomeSafe).toHaveBeenCalledWith("reporter-1", "NO_ACTION", "r1");
  expect(publishAccountWarnedSafe).not.toHaveBeenCalled();
});
