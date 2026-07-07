/**
 * Error-mapping coverage for the `sendCommunityMessage` gRPC handler
 * (src/grpc/service-impl.ts, inside createCommunityImpl) — the counterpart of
 * delete-community-message-errors.test.ts for the send path.
 *
 * Root cause under test: the handler's catch block used to always call back
 * with `{ code: grpc.status.INTERNAL, message: String(err) }` regardless of
 * what `communityMessageService.sendMessage` actually threw — collapsing
 * `BadRequestError("CHAT_AUDIO_TOO_LARGE")` / `CHAT_DOCUMENT_TOO_LARGE` /
 * `CHAT_IMAGE_COUNT_EXCEEDED` / `CHAT_UNSUPPORTED_CONTENT_TYPE`, and
 * `ForbiddenError("COMMUNITY_CHAT_DISABLED")`, into one generic INTERNAL
 * error carrying a stringified Error object as its message. The gateway then
 * had nothing usable to build a specific ack from, regardless of whether it
 * called `resolveGrpcAckError` (see community-message-send-ack.test.ts).
 *
 * Fix: use the shared `toGrpcCallbackError()` (already used by
 * deleteCommunityMessage and others) to map the `AppError`'s `statusCode` to
 * the matching gRPC status and forward its `messageKey` verbatim.
 */
jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishConvUpdatedSafe: jest.fn(),
  publishCommunityUpdatedSafe: jest.fn(),
}));
jest.mock("../../src/events/publish-community-activity.js", () => ({
  publishCommunityActivitySafe: jest.fn(),
}));

import * as grpc from "@grpc/grpc-js";
import { BadRequestError, ForbiddenError } from "@aimess/errors";
import {
  createCommunityImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";

type Handler = (
  call: { request: unknown },
  cb: (err: unknown, res?: unknown) => void
) => void;

function makeDeps(over: Record<string, unknown>): GrpcDeps {
  return {
    userSnapshotService: {
      getUserSnapshotsMap: jest.fn().mockResolvedValue(new Map()),
    },
    cacheRepo: {},
    ...over,
  } as unknown as GrpcDeps;
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
  communityId: "comm_1",
  roomId: "room_1",
  senderId: "usr_1",
  clientMessageId: "cmid_1",
  message: "",
  contentType: "document",
  mediaKey: "",
  parentMessageId: "",
  attachmentsJson: JSON.stringify({
    files: [{ size: 1, mime: "application/pdf" }],
  }),
};

describe("sendCommunityMessage — error mapping", () => {
  it("BadRequestError('CHAT_AUDIO_TOO_LARGE') -> INVALID_ARGUMENT with the messageKey", async () => {
    const deps = makeDeps({
      communityMessageService: {
        sendMessage: jest
          .fn()
          .mockRejectedValue(new BadRequestError("CHAT_AUDIO_TOO_LARGE")),
      },
    });
    const impl = createCommunityImpl(deps);
    const err = await invokeExpectingError(
      impl.sendCommunityMessage as Handler,
      BASE_REQUEST
    );
    expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(err.message).toBe("CHAT_AUDIO_TOO_LARGE");
  });

  it("BadRequestError('CHAT_DOCUMENT_TOO_LARGE') -> INVALID_ARGUMENT with the messageKey", async () => {
    const deps = makeDeps({
      communityMessageService: {
        sendMessage: jest
          .fn()
          .mockRejectedValue(new BadRequestError("CHAT_DOCUMENT_TOO_LARGE")),
      },
    });
    const impl = createCommunityImpl(deps);
    const err = await invokeExpectingError(
      impl.sendCommunityMessage as Handler,
      BASE_REQUEST
    );
    expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(err.message).toBe("CHAT_DOCUMENT_TOO_LARGE");
  });

  it("BadRequestError('CHAT_IMAGE_COUNT_EXCEEDED') -> INVALID_ARGUMENT with the messageKey", async () => {
    const deps = makeDeps({
      communityMessageService: {
        sendMessage: jest
          .fn()
          .mockRejectedValue(new BadRequestError("CHAT_IMAGE_COUNT_EXCEEDED")),
      },
    });
    const impl = createCommunityImpl(deps);
    const err = await invokeExpectingError(
      impl.sendCommunityMessage as Handler,
      BASE_REQUEST
    );
    expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(err.message).toBe("CHAT_IMAGE_COUNT_EXCEEDED");
  });

  it("BadRequestError('CHAT_UNSUPPORTED_CONTENT_TYPE') -> INVALID_ARGUMENT with the messageKey", async () => {
    const deps = makeDeps({
      communityMessageService: {
        sendMessage: jest
          .fn()
          .mockRejectedValue(
            new BadRequestError("CHAT_UNSUPPORTED_CONTENT_TYPE")
          ),
      },
    });
    const impl = createCommunityImpl(deps);
    const err = await invokeExpectingError(
      impl.sendCommunityMessage as Handler,
      BASE_REQUEST
    );
    expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(err.message).toBe("CHAT_UNSUPPORTED_CONTENT_TYPE");
  });

  it("ForbiddenError('COMMUNITY_CHAT_DISABLED') -> PERMISSION_DENIED with the messageKey", async () => {
    const deps = makeDeps({
      communityMessageService: {
        sendMessage: jest
          .fn()
          .mockRejectedValue(new ForbiddenError("COMMUNITY_CHAT_DISABLED")),
      },
    });
    const impl = createCommunityImpl(deps);
    const err = await invokeExpectingError(
      impl.sendCommunityMessage as Handler,
      BASE_REQUEST
    );
    expect(err.code).toBe(grpc.status.PERMISSION_DENIED);
    expect(err.message).toBe("COMMUNITY_CHAT_DISABLED");
  });

  it("a non-AppError (unexpected bug) -> generic INTERNAL error, never leaking the raw error/stack", async () => {
    const deps = makeDeps({
      communityMessageService: {
        sendMessage: jest
          .fn()
          .mockRejectedValue(
            new TypeError("Cannot read properties of undefined")
          ),
      },
    });
    const impl = createCommunityImpl(deps);
    const err = await invokeExpectingError(
      impl.sendCommunityMessage as Handler,
      BASE_REQUEST
    );
    expect(err.code).toBe(grpc.status.INTERNAL);
    expect(err.message).toBe("INTERNAL_ERROR");
    expect(err.message).not.toContain("Cannot read properties");
  });
});
