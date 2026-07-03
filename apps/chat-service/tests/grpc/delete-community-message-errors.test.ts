/**
 * Error-mapping coverage for the `deleteCommunityMessage` gRPC handler
 * (src/grpc/service-impl.ts, inside createCommunityImpl).
 *
 * Root cause under test: the handler's catch block used to always call back
 * with `{ code: grpc.status.INTERNAL, message: String(err) }` regardless of
 * what `communityMessageService.deleteForMe`/`deleteForAll` actually threw —
 * collapsing NotFoundError/BadRequestError/ForbiddenError (each carrying a
 * specific `messageKey`, e.g. "CHAT_MESSAGE_NOT_FOUND") into one generic
 * INTERNAL error. The gateway then had nothing to work with except a fixed
 * "Something went wrong, please try again" ack message for every failure.
 *
 * Fix: `toGrpcCallbackError()` maps an `AppError`'s `statusCode` to the
 * matching gRPC status and forwards its `messageKey` verbatim as the gRPC
 * error message (never the raw `err.message`/stack for non-AppErrors — those
 * still become a generic, non-descriptive INTERNAL error).
 *
 * This suite asserts the callback's `{ code, message }` for every realistic
 * failure in both the "Delete for Me" and "Delete for Everyone" branches, and
 * confirms unexpected (non-AppError) failures still fall back to a generic,
 * non-leaking INTERNAL error.
 */

jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishConvUpdatedSafe: jest.fn(),
  publishCommunityUpdatedSafe: jest.fn(),
}));
jest.mock("../../src/events/publish-community-activity.js", () => ({
  publishCommunityActivitySafe: jest.fn(),
}));

import * as grpc from "@grpc/grpc-js";
import { NotFoundError, BadRequestError, ForbiddenError } from "@aimess/errors";
import {
  createCommunityImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";
import { redis } from "../../src/config/redis.js";

type Handler = (
  call: { request: unknown },
  cb: (err: unknown, res?: unknown) => void
) => void;

function makeDeps(over: Record<string, unknown>): GrpcDeps {
  return over as unknown as GrpcDeps;
}

/** Invoke the handler and capture the raw callback error (never rejects). */
function invokeExpectingError(
  handler: Handler,
  request: unknown
): Promise<any> {
  return new Promise((resolve) => {
    handler({ request }, (err) => resolve(err));
  });
}

const BASE_REQUEST = {
  messageId: "msg_1",
  communityId: "comm_1",
  userId: "usr_1",
};

beforeEach(() => {
  (redis.publish as jest.Mock).mockClear();
});

describe("deleteCommunityMessage — error mapping (Delete for Everyone)", () => {
  const deleteType = "forEveryone";

  it("NotFoundError('CHAT_MESSAGE_NOT_FOUND') -> NOT_FOUND with the messageKey", async () => {
    const deps = makeDeps({
      communityMessageService: {
        deleteForAll: jest
          .fn()
          .mockRejectedValue(new NotFoundError("CHAT_MESSAGE_NOT_FOUND")),
      },
    });
    const impl = createCommunityImpl(deps);
    const err = await invokeExpectingError(
      impl.deleteCommunityMessage as Handler,
      { ...BASE_REQUEST, deleteType }
    );
    expect(err.code).toBe(grpc.status.NOT_FOUND);
    expect(err.message).toBe("CHAT_MESSAGE_NOT_FOUND");
  });

  it("BadRequestError('CHAT_SYSTEM_MESSAGE_IMMUTABLE') -> INVALID_ARGUMENT with the messageKey", async () => {
    const deps = makeDeps({
      communityMessageService: {
        deleteForAll: jest
          .fn()
          .mockRejectedValue(
            new BadRequestError("CHAT_SYSTEM_MESSAGE_IMMUTABLE")
          ),
      },
    });
    const impl = createCommunityImpl(deps);
    const err = await invokeExpectingError(
      impl.deleteCommunityMessage as Handler,
      { ...BASE_REQUEST, deleteType }
    );
    expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(err.message).toBe("CHAT_SYSTEM_MESSAGE_IMMUTABLE");
  });

  it("BadRequestError('CHAT_INSUFFICIENT_PERMISSIONS') -> INVALID_ARGUMENT with the messageKey (not the sender, not mod/admin)", async () => {
    const deps = makeDeps({
      communityMessageService: {
        deleteForAll: jest
          .fn()
          .mockRejectedValue(
            new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS")
          ),
      },
    });
    const impl = createCommunityImpl(deps);
    const err = await invokeExpectingError(
      impl.deleteCommunityMessage as Handler,
      { ...BASE_REQUEST, deleteType }
    );
    expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(err.message).toBe("CHAT_INSUFFICIENT_PERMISSIONS");
  });

  it("ForbiddenError('CHAT_MUTED_IN_COMMUNITY') -> PERMISSION_DENIED with the messageKey", async () => {
    const deps = makeDeps({
      communityMessageService: {
        deleteForAll: jest
          .fn()
          .mockRejectedValue(new ForbiddenError("CHAT_MUTED_IN_COMMUNITY")),
      },
    });
    const impl = createCommunityImpl(deps);
    const err = await invokeExpectingError(
      impl.deleteCommunityMessage as Handler,
      { ...BASE_REQUEST, deleteType }
    );
    expect(err.code).toBe(grpc.status.PERMISSION_DENIED);
    expect(err.message).toBe("CHAT_MUTED_IN_COMMUNITY");
  });

  it("ForbiddenError('COMMUNITY_SUSPENDED') -> PERMISSION_DENIED with the messageKey (room not writable)", async () => {
    const deps = makeDeps({
      communityMessageService: {
        deleteForAll: jest
          .fn()
          .mockRejectedValue(new ForbiddenError("COMMUNITY_SUSPENDED")),
      },
    });
    const impl = createCommunityImpl(deps);
    const err = await invokeExpectingError(
      impl.deleteCommunityMessage as Handler,
      { ...BASE_REQUEST, deleteType }
    );
    expect(err.code).toBe(grpc.status.PERMISSION_DENIED);
    expect(err.message).toBe("COMMUNITY_SUSPENDED");
  });

  it("an unexpected (non-AppError) failure -> generic INTERNAL, never the raw error text", async () => {
    const deps = makeDeps({
      communityMessageService: {
        deleteForAll: jest
          .fn()
          .mockRejectedValue(
            new Error("connection terminated unexpectedly at 10.0.4.12:5432")
          ),
      },
    });
    const impl = createCommunityImpl(deps);
    const err = await invokeExpectingError(
      impl.deleteCommunityMessage as Handler,
      { ...BASE_REQUEST, deleteType }
    );
    expect(err.code).toBe(grpc.status.INTERNAL);
    expect(err.message).toBe("INTERNAL_ERROR");
    expect(err.message).not.toContain("10.0.4.12");
  });

  it("BadRequestError('CHAT_MESSAGE_ALREADY_DELETED') -> INVALID_ARGUMENT with the messageKey (re-deleting a tombstoned message)", async () => {
    const deps = makeDeps({
      communityMessageService: {
        deleteForAll: jest
          .fn()
          .mockRejectedValue(
            new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED")
          ),
      },
    });
    const impl = createCommunityImpl(deps);
    const err = await invokeExpectingError(
      impl.deleteCommunityMessage as Handler,
      { ...BASE_REQUEST, deleteType }
    );
    expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(err.message).toBe("CHAT_MESSAGE_ALREADY_DELETED");
  });

  it("no delete-for-everyone time window exists today — an old message still deletes successfully", async () => {
    // There is no analogue of CHAT_EDIT_WINDOW_MS for delete-for-everyone in this
    // codebase (confirmed: no time-window check anywhere in deleteForAll/deleteForMe).
    // This test documents that current behavior rather than asserting a feature
    // that doesn't exist — a very old message (createdAt far in the past) still
    // deletes successfully, unlike editMessage's CHAT_EDIT_WINDOW_EXPIRED.
    const oldMessage = {
      id: "msg_1",
      roomId: "room_1",
      createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    };
    const deps = makeDeps({
      communityMessageService: {
        deleteForAll: jest.fn().mockResolvedValue(oldMessage),
        // fire-and-forget follow-up after the callback resolves — not under test here
        recalculateLastMessageAfterDelete: jest.fn().mockResolvedValue(null),
      },
    });
    const impl = createCommunityImpl(deps);
    const res = await new Promise((resolve, reject) => {
      (impl.deleteCommunityMessage as Handler)(
        { request: { ...BASE_REQUEST, deleteType } },
        (err, r) => (err ? reject(err) : resolve(r))
      );
    });
    expect(res).toMatchObject({
      messageId: "msg_1",
      deleteType: "forEveryone",
    });
  });

  it("successful delete-for-everyone -> callback resolves with no error", async () => {
    const deps = makeDeps({
      communityMessageService: {
        deleteForAll: jest
          .fn()
          .mockResolvedValue({ id: "msg_1", roomId: "room_1" }),
        // fire-and-forget follow-up after the callback resolves — not under test here
        recalculateLastMessageAfterDelete: jest.fn().mockResolvedValue(null),
      },
    });
    const impl = createCommunityImpl(deps);
    const res = await new Promise((resolve, reject) => {
      (impl.deleteCommunityMessage as Handler)(
        { request: { ...BASE_REQUEST, deleteType } },
        (err, r) => (err ? reject(err) : resolve(r))
      );
    });
    expect(res).toEqual({
      messageId: "msg_1",
      communityId: "comm_1",
      roomId: "room_1",
      deleteType: "forEveryone",
    });
  });
});

describe("deleteCommunityMessage — error mapping (Delete for Me)", () => {
  const deleteType = "forMe";

  it("NotFoundError('CHAT_MESSAGE_NOT_FOUND') -> NOT_FOUND with the messageKey", async () => {
    const deps = makeDeps({
      communityMessageService: {
        deleteForMe: jest
          .fn()
          .mockRejectedValue(new NotFoundError("CHAT_MESSAGE_NOT_FOUND")),
      },
    });
    const impl = createCommunityImpl(deps);
    const err = await invokeExpectingError(
      impl.deleteCommunityMessage as Handler,
      { ...BASE_REQUEST, deleteType }
    );
    expect(err.code).toBe(grpc.status.NOT_FOUND);
    expect(err.message).toBe("CHAT_MESSAGE_NOT_FOUND");
  });

  it("BadRequestError('CHAT_SYSTEM_MESSAGE_IMMUTABLE') -> INVALID_ARGUMENT with the messageKey", async () => {
    const deps = makeDeps({
      communityMessageService: {
        deleteForMe: jest
          .fn()
          .mockRejectedValue(
            new BadRequestError("CHAT_SYSTEM_MESSAGE_IMMUTABLE")
          ),
      },
    });
    const impl = createCommunityImpl(deps);
    const err = await invokeExpectingError(
      impl.deleteCommunityMessage as Handler,
      { ...BASE_REQUEST, deleteType }
    );
    expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(err.message).toBe("CHAT_SYSTEM_MESSAGE_IMMUTABLE");
  });

  it("ForbiddenError('CHAT_MUTED_IN_COMMUNITY') -> PERMISSION_DENIED with the messageKey (muted deleter)", async () => {
    const deps = makeDeps({
      communityMessageService: {
        deleteForMe: jest
          .fn()
          .mockRejectedValue(new ForbiddenError("CHAT_MUTED_IN_COMMUNITY")),
      },
    });
    const impl = createCommunityImpl(deps);
    const err = await invokeExpectingError(
      impl.deleteCommunityMessage as Handler,
      { ...BASE_REQUEST, deleteType }
    );
    expect(err.code).toBe(grpc.status.PERMISSION_DENIED);
    expect(err.message).toBe("CHAT_MUTED_IN_COMMUNITY");
  });

  it("an unexpected (non-AppError) failure -> generic INTERNAL, never the raw error text", async () => {
    const deps = makeDeps({
      communityMessageService: {
        deleteForMe: jest
          .fn()
          .mockRejectedValue(
            new TypeError("Cannot read properties of undefined")
          ),
      },
    });
    const impl = createCommunityImpl(deps);
    const err = await invokeExpectingError(
      impl.deleteCommunityMessage as Handler,
      { ...BASE_REQUEST, deleteType }
    );
    expect(err.code).toBe(grpc.status.INTERNAL);
    expect(err.message).toBe("INTERNAL_ERROR");
  });
});
