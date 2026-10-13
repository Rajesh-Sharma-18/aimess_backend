// §7: warn / report outcome / suspend+ban delivery off admin.user.notify.queue.
const channelMock = {
  assertQueue: jest.fn(async () => undefined),
  prefetch: jest.fn(async () => undefined),
  consume: jest.fn(),
  ack: jest.fn(),
  nack: jest.fn(),
};
jest.mock("amqplib", () => ({
  __esModule: true,
  default: { connect: jest.fn(async () => ({ createChannel: async () => channelMock })) },
}));
jest.mock("../../src/services/push.service.js", () => ({ pushToUser: jest.fn(async () => undefined) }));
jest.mock("../../src/providers/mail/sendMail.js", () => ({ sendMail: jest.fn(async () => undefined) }));
jest.mock("../../src/services/device-token.service.js", () => ({
  deviceTokenService: {
    getTokensForUser: jest.fn(async () => [
      { timezone: "UTC", lastSeenAt: new Date(1) },
      { timezone: "Asia/Ho_Chi_Minh", lastSeenAt: new Date(2) },
      { timezone: null, lastSeenAt: new Date(3) },
    ]),
  },
}));
jest.mock("../../src/services/notification-settings.service.js", () => ({
  getUserLocale: jest.fn(async () => "en"),
}));

import { AdminUserEvents } from "@aimess/shared-types";

import { startAdminUserConsumer } from "../../src/consumers/admin-user.consumer.js";
import { pushToUser } from "../../src/services/push.service.js";
import { sendMail } from "../../src/providers/mail/sendMail.js";

const push = pushToUser as jest.Mock;
const mail = sendMail as jest.Mock;

let consume: (msg: { content: Buffer }) => void;

async function emit(type: string, data: object): Promise<void> {
  consume({ content: Buffer.from(JSON.stringify({ type, data })) });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

beforeAll(async () => {
  await startAdminUserConsumer();
  consume = (channelMock.consume.mock.calls.at(-1) as unknown as [string, typeof consume])[1];
});
beforeEach(() => jest.clearAllMocks());

it("ACCOUNT_WARNED → push+inbox 'AI Mess Administrator warned you: {note}'", async () => {
  await emit("ACCOUNT_WARNED", {
    userId: "u1",
    type: "ACCOUNT_WARNED",
    title: "AI Mess Administrator",
    body: "AI Mess Administrator warned you: Be kind",
    data: { note: "Be kind" },
  });
  const arg = push.mock.calls[0][0];
  expect(arg.type).toBe("ACCOUNT_WARNED");
  expect(arg.copy("en", "u1").body).toBe("AI Mess Administrator warned you: Be kind");
  expect(mail).not.toHaveBeenCalled();
});

it("REPORT_OUTCOME renders the outcome, never a target", async () => {
  await emit("REPORT_OUTCOME", {
    userId: "u2",
    type: "REPORT_OUTCOME",
    title: "t",
    body: "b",
    data: { outcome: "NO_ACTION", reportId: "r1" },
  });
  const arg = push.mock.calls[0][0];
  expect(arg.copy("en", "u2").body).toBe("We reviewed your report. No action was needed");
  expect(Object.keys(arg.data)).not.toContain("targetUserId");
});

it("ban emails only when the publisher attached a (verified) address", async () => {
  await emit(AdminUserEvents.USER_BANNED, {
    userId: "u3",
    type: AdminUserEvents.USER_BANNED,
    title: "t",
    body: "b",
    email: "u3@example.com",
    data: { reason: "Spam" },
  });
  expect(mail).toHaveBeenCalledTimes(1);
  expect(mail.mock.calls[0][0].to).toBe("u3@example.com");
  expect(mail.mock.calls[0][0].html).toContain(
    "Your account has been permanently banned. Reason: Spam"
  );

  mail.mockClear();
  await emit(AdminUserEvents.USER_SUSPENDED, {
    userId: "u5",
    type: AdminUserEvents.USER_SUSPENDED,
    title: "t",
    body: "b",
    email: "u5@example.com",
    data: { reason: "Spam", suspendedUntil: "2099-10-20T15:00:00.000Z" },
  });
  // Until-time in the latest-seen device's zone (Asia/Ho_Chi_Minh, UTC+7).
  expect(mail.mock.calls[0][0].html).toContain("10:00 PM, Oct 20, 2099");

  mail.mockClear();
  await emit(AdminUserEvents.USER_SUSPENDED, {
    userId: "u4",
    type: AdminUserEvents.USER_SUSPENDED,
    title: "t",
    body: "b",
    data: { reason: "Spam", suspendedUntil: "2099-10-20T15:00:00.000Z" },
  });
  expect(push).toHaveBeenCalled();
  expect(mail).not.toHaveBeenCalled();
});
