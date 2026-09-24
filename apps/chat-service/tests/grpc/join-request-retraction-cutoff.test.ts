/**
 * A retraction may only take back the card it was written for.
 *
 * Cancelling a join request and sending it again publishes "take the old card
 * back" and "here is a new one" within the same second, down different queues.
 * When the retraction lands second, deleting the whole group would delete the
 * card that REPLACED the one it was written for, and the admin would be left
 * with nothing to act on — which is how a re-request came out invisible even
 * after every other part of the lifecycle was correct. The retraction therefore
 * says how old a card it may remove, and anything newer is a later attempt.
 */
jest.mock("../../src/events/publish-message-sent.js", () => ({
  publishMessageSentSafe: jest.fn(),
  publishMentionRetractedSafe: jest.fn(),
  buildPushPreview: jest.fn(() => ""),
  buildMessagePreview: jest.fn(() => ""),
}));

import {
  createNotificationImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";

type Handler = (
  call: { request: unknown },
  cb: (err: unknown, res?: unknown) => void
) => void;

const ADMIN = "u_admin";
const CID = "c".repeat(24);
const REQUESTER = "u_requester";
const GROUP_KEY = `community:${CID}:join_request:${REQUESTER}`;
const RAISED_AT = "2026-09-24T12:05:00.000Z";

function setup() {
  const notificationRepo = {
    create: jest.fn(async (input: Record<string, unknown>) => ({
      id: "notif-new",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...input,
    })),
    getUnreadCount: jest.fn(async () => 0),
    findActiveByGroupKey: jest.fn(async () => ({
      id: "notif-old",
      type: "community.join_requested",
      payload: { title: "", body: "", data: {} },
      actorId: REQUESTER,
      actorSnapshot: {},
      entity: {},
    })),
    deleteActiveByGroupKey: jest.fn(async () => ({ ids: ["notif-old"] })),
    applyStateTransition: jest.fn(),
  };
  const deps = { notificationRepo } as unknown as GrpcDeps;
  const handler = createNotificationImpl(deps).createNotification as Handler;
  const retract = (data: Record<string, string>) =>
    new Promise<{ id: string }>((resolve, reject) =>
      handler(
        {
          request: {
            userId: ADMIN,
            actorId: REQUESTER,
            type: "community.join_request_retracted",
            title: "",
            body: "",
            data: {
              groupKey: GROUP_KEY,
              communityId: CID,
              requesterId: REQUESTER,
              ...data,
            },
          },
        },
        (err, res) => (err ? reject(err as Error) : resolve(res as { id: string }))
      )
    );
  return { notificationRepo, retract };
}

describe("join-request retraction cutoff", () => {
  it("limits the removal to cards raised at or before the settlement", async () => {
    const { notificationRepo, retract } = setup();

    await retract({ staleBefore: RAISED_AT });

    expect(notificationRepo.deleteActiveByGroupKey).toHaveBeenCalledWith(
      ADMIN,
      GROUP_KEY,
      new Date(RAISED_AT)
    );
  });

  it("removes the whole group when the producer sets no cutoff", async () => {
    // Every other terminal type (a cancelled friend request, a retracted
    // mention) cannot race its own replacement and passes nothing.
    const { notificationRepo, retract } = setup();

    await retract({});

    expect(notificationRepo.deleteActiveByGroupKey).toHaveBeenCalledWith(
      ADMIN,
      GROUP_KEY,
      undefined
    );
  });

  it("ignores a cutoff that is not a date rather than dropping the retraction", async () => {
    const { notificationRepo, retract } = setup();

    await retract({ staleBefore: "not-a-date" });

    // Falling back to the whole group is the safe direction: a stale card left
    // behind is worse than one removed a moment early.
    expect(notificationRepo.deleteActiveByGroupKey).toHaveBeenCalledWith(
      ADMIN,
      GROUP_KEY,
      undefined
    );
  });

  it("never writes a card for a retraction", async () => {
    const { notificationRepo, retract } = setup();

    await retract({ staleBefore: RAISED_AT });

    expect(notificationRepo.create).not.toHaveBeenCalled();
    expect(notificationRepo.applyStateTransition).not.toHaveBeenCalled();
  });
});
