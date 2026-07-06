/**
 * Root-cause regression: `community:message:send`'s `.catch()` in
 * `community.ns.ts` used to call `ackError(callback, "SERVICE_ERROR", locale)`
 * unconditionally — unlike every other community send-adjacent handler
 * (delete/pin/unpin), it never called `resolveGrpcAckError(err)`. So ANY
 * gRPC error from chat-service — including a well-formed
 * `BadRequestError("CHAT_FILE_TOO_LARGE")` / `CHAT_AUDIO_TOO_LARGE` /
 * `CHAT_IMAGE_COUNT_EXCEEDED` from the media-limit guard, or a
 * `ForbiddenError("COMMUNITY_CHAT_DISABLED")` for a missing/closed community —
 * always collapsed into the generic "Something went wrong, please try again"
 * ack, matching the reported bug ("community.sendCommunityMessage
 * unavailable"). Compounding it: chat-service's `sendCommunityMessage` gRPC
 * handler used a raw `callback({code: INTERNAL, message: String(err)})`
 * instead of the shared `toGrpcCallbackError(err)` helper every other handler
 * uses, so even a fixed gateway couldn't have resolved a specific message —
 * the messageKey never survived the trip as a clean gRPC `details` string.
 *
 * This suite mirrors community-message-delete-breaker.test.ts's
 * `simulateGatewayCatch` pattern — the exact `.catch()` body now in
 * `community.ns.ts`'s `community:message:send` handler — proving specific
 * media/permission/not-found errors now surface a real, actionable message
 * instead of the generic fallback, while true infra failures still do.
 */
import * as grpc from "@grpc/grpc-js";
import { ackError, resolveGrpcAckError } from "../../src/sockets/ack.js";

function capture(): { calls: unknown[]; cb: (res: unknown) => void } {
  const calls: unknown[] = [];
  return { calls, cb: (res: unknown) => calls.push(res) };
}

/** Shape chat-service's `toGrpcCallbackError` actually produces on the wire. */
function serviceError(code: number, messageKey: string) {
  return {
    code,
    details: messageKey,
    message: `${code}: ${messageKey}`,
    name: "Error",
  };
}

/** Mirrors exactly what `community:message:send`'s `.catch()` does now. */
function simulateSendCatch(err: unknown) {
  const { calls, cb } = capture();
  const { code, detailKey } = resolveGrpcAckError(err);
  ackError(cb, code, "en", detailKey);
  return calls[0] as {
    success: false;
    error: string;
    retryable: boolean;
    message: string;
  };
}

describe("community:message:send — ack surfaces the specific media-limit error", () => {
  it("CHAT_AUDIO_TOO_LARGE -> a specific, actionable ack message", () => {
    const err = serviceError(
      grpc.status.INVALID_ARGUMENT,
      "CHAT_AUDIO_TOO_LARGE"
    );
    const ack = simulateSendCatch(err);
    expect(ack).toEqual({
      success: false,
      error: "INVALID_PAYLOAD",
      retryable: false,
      message: "Audio exceeds 25 MB",
    });
  });

  it("CHAT_DOCUMENT_TOO_LARGE -> a specific, actionable ack message", () => {
    const err = serviceError(
      grpc.status.INVALID_ARGUMENT,
      "CHAT_DOCUMENT_TOO_LARGE"
    );
    const ack = simulateSendCatch(err);
    expect(ack.message).toBe("Document exceeds 25 MB");
    expect(ack.retryable).toBe(false);
  });

  it("CHAT_VIDEO_TOO_LARGE -> a specific, actionable ack message", () => {
    const err = serviceError(
      grpc.status.INVALID_ARGUMENT,
      "CHAT_VIDEO_TOO_LARGE"
    );
    const ack = simulateSendCatch(err);
    expect(ack.message).toBe("Video exceeds 100 MB");
  });

  it("CHAT_IMAGE_COUNT_EXCEEDED -> a specific, actionable ack message", () => {
    const err = serviceError(
      grpc.status.INVALID_ARGUMENT,
      "CHAT_IMAGE_COUNT_EXCEEDED"
    );
    const ack = simulateSendCatch(err);
    expect(ack.message).toBe("Maximum 10 images allowed");
  });

  it("CHAT_UNSUPPORTED_CONTENT_TYPE -> a specific, actionable ack message", () => {
    const err = serviceError(
      grpc.status.INVALID_ARGUMENT,
      "CHAT_UNSUPPORTED_CONTENT_TYPE"
    );
    const ack = simulateSendCatch(err);
    expect(ack.message).toBe("Unsupported file type");
  });

  it("a missing/disabled community (FORBIDDEN) -> a specific ack, not the generic fallback", () => {
    const err = serviceError(
      grpc.status.PERMISSION_DENIED,
      "COMMUNITY_CHAT_DISABLED"
    );
    const ack = simulateSendCatch(err);
    expect(ack).toEqual({
      success: false,
      error: "FORBIDDEN",
      retryable: false,
      message: "Community chat is currently unavailable",
    });
  });

  it("a suspended community (FORBIDDEN) -> a specific ack", () => {
    const err = serviceError(
      grpc.status.PERMISSION_DENIED,
      "COMMUNITY_SUSPENDED"
    );
    const ack = simulateSendCatch(err);
    expect(ack.message).toBe("This community is suspended");
  });

  it("muted member (FORBIDDEN) -> a specific ack", () => {
    const err = serviceError(
      grpc.status.PERMISSION_DENIED,
      "CHAT_MUTED_IN_COMMUNITY"
    );
    const ack = simulateSendCatch(err);
    expect(ack.message).toBe(
      "You are muted in this community and cannot post messages"
    );
  });

  it("a true infra failure (no gRPC code) still falls back to the generic, retryable message", () => {
    const err = new Error("ECONNREFUSED 127.0.0.1:50051");
    const ack = simulateSendCatch(err);
    expect(ack).toEqual({
      success: false,
      error: "SERVICE_ERROR",
      retryable: true,
      message: "Something went wrong, please try again",
    });
  });

  it("a raw INTERNAL gRPC status (unexpected bug) still falls back to the generic message, never leaking internals", () => {
    const err = serviceError(
      grpc.status.INTERNAL,
      "TypeError: Cannot read properties of undefined (reading 'foo')"
    );
    const ack = simulateSendCatch(err);
    expect(ack.error).toBe("SERVICE_ERROR");
    expect(ack.message).toBe("Something went wrong, please try again");
  });
});
