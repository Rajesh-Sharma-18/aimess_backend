/**
 * One inbox row per livestream session: the end rewrites the "is live" row in
 * place, a late start never regresses it, and a silent end never creates a row
 * the user did not already have.
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

const USER = "u_viewer";
const SID = "s".repeat(24);
const STARTED = "community.livestream_started";
const ENDED = "community.livestream_ended";

function setup(existingType: string | null) {
  const row = (input: Record<string, unknown>) => ({
    id: "notif-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    payload: { title: "", body: "", data: {} },
    ...input,
  });
  const notificationRepo = {
    create: jest.fn(async (input: Record<string, unknown>) => row(input)),
    getUnreadFanout: jest.fn(async () => ({
      unreadCount: 0,
      selfHiddenSessions: [],
    })),
    findActiveByGroupKey: jest.fn(async () =>
      existingType
        ? row({ type: existingType, actorId: "h", actorSnapshot: {}, entity: {} })
        : null
    ),
    deleteActiveByGroupKey: jest.fn(async () => ({ ids: [] })),
    applyStateTransition: jest.fn(async (_id: string, input: object) =>
      row(input as Record<string, unknown>)
    ),
  };
  const deps = { notificationRepo } as unknown as GrpcDeps;
  const handler = createNotificationImpl(deps).createNotification as Handler;
  const send = (type: string, data: Record<string, string> = {}) =>
    new Promise<{ id: string }>((resolve, reject) =>
      handler(
        {
          request: {
            userId: USER,
            actorId: "h",
            type,
            title: "",
            body: "",
            data: { livestreamId: SID, communityId: "c1", ...data },
          },
        },
        (err, res) => (err ? reject(err as Error) : resolve(res as { id: string }))
      )
    );
  return { notificationRepo, send };
}

describe("livestream notification lifecycle (createNotification)", () => {
  it("the end rewrites the started row in place", async () => {
    const { notificationRepo, send } = setup(STARTED);
    await send(ENDED, { resurface: "false", updateOnly: "true" });
    expect(notificationRepo.findActiveByGroupKey).toHaveBeenCalledWith(
      USER,
      `livestream:${SID}`
    );
    expect(notificationRepo.applyStateTransition).toHaveBeenCalledWith(
      "notif-1",
      expect.objectContaining({ type: ENDED, resurface: false })
    );
    expect(notificationRepo.create).not.toHaveBeenCalled();
  });

  it("a late start never turns an ended row back into 'is live'", async () => {
    const { notificationRepo, send } = setup(ENDED);
    await send(STARTED);
    expect(notificationRepo.applyStateTransition).not.toHaveBeenCalled();
    expect(notificationRepo.create).not.toHaveBeenCalled();
  });

  it("a silent end creates nothing for a user who never had the live row", async () => {
    const { notificationRepo, send } = setup(null);
    await send(ENDED, { updateOnly: "true" });
    expect(notificationRepo.create).not.toHaveBeenCalled();
  });
});
