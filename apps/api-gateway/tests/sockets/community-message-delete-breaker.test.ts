/**
 * Root-cause regression: the circuit breaker used by EVERY gRPC client in the
 * gateway (`makeBreaker` in `@aimess/grpc-utils`) used to swallow ALL
 * rejections — including well-formed business errors chat-service had already
 * correctly mapped to a gRPC status (e.g. NOT_FOUND / "CHAT_MESSAGE_NOT_FOUND")
 * — and replace them with a generic `Error("<name> unavailable")` carrying no
 * `code`/`details` at all. That happened INSIDE the breaker, before
 * `community.ns.ts`'s `.catch()` or `resolveGrpcAckError` ever saw the error,
 * so `community:message:delete`'s ack always fell back to the generic
 * SERVICE_ERROR message regardless of what chat-service actually reported.
 *
 * Root cause: opossum's default `errorFilter` is `() => false` — nothing is
 * excluded from tripping `.fallback()`. `makeBreaker` unconditionally
 * registers a fallback that throws a generic "<name> unavailable" Error, so
 * with no filter, EVERY rejection (business or infra) got replaced by it.
 *
 * Fix: `makeBreaker`/`makeBreakerNoArgs` now default `errorFilter` to
 * `isBusinessGrpcError` — a well-formed gRPC business status (NOT_FOUND,
 * INVALID_ARGUMENT, PERMISSION_DENIED, ALREADY_EXISTS, FAILED_PRECONDITION,
 * OUT_OF_RANGE, UNAUTHENTICATED) is NOT treated as a circuit failure and is
 * NOT replaced by the fallback — it passes through to the caller with its
 * original `code`/`details` intact. A true infra failure (timeout, ECONNREFUSED,
 * a raw INTERNAL/UNAVAILABLE from the callee) still trips the breaker and
 * still gets the safe generic fallback message.
 *
 * This suite uses the REAL `makeBreaker` from `@aimess/grpc-utils` (not a
 * mock) wrapping a fake gRPC call, exercising the actual opossum instance —
 * this is exactly the layer that silently broke the delete ACK.
 */
import * as grpc from "@grpc/grpc-js";
import { makeBreaker } from "@aimess/grpc-utils";
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

describe("makeBreaker — business gRPC errors pass through untouched", () => {
  it("NOT_FOUND (message not found) is not swallowed by the fallback", async () => {
    const breaker = makeBreaker("community.deleteCommunityMessage", () =>
      Promise.reject(
        serviceError(grpc.status.NOT_FOUND, "CHAT_MESSAGE_NOT_FOUND")
      )
    );
    await expect(breaker.fire(undefined)).rejects.toMatchObject({
      code: grpc.status.NOT_FOUND,
      details: "CHAT_MESSAGE_NOT_FOUND",
    });
  });

  it("INVALID_ARGUMENT (insufficient permissions / already deleted) is not swallowed", async () => {
    const breaker = makeBreaker("community.deleteCommunityMessage", () =>
      Promise.reject(
        serviceError(
          grpc.status.INVALID_ARGUMENT,
          "CHAT_INSUFFICIENT_PERMISSIONS"
        )
      )
    );
    await expect(breaker.fire(undefined)).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
      details: "CHAT_INSUFFICIENT_PERMISSIONS",
    });
  });

  it("PERMISSION_DENIED (muted / suspended) is not swallowed", async () => {
    const breaker = makeBreaker("community.deleteCommunityMessage", () =>
      Promise.reject(
        serviceError(grpc.status.PERMISSION_DENIED, "CHAT_MUTED_IN_COMMUNITY")
      )
    );
    await expect(breaker.fire(undefined)).rejects.toMatchObject({
      code: grpc.status.PERMISSION_DENIED,
      details: "CHAT_MUTED_IN_COMMUNITY",
    });
  });

  it("a true infra failure (no gRPC code) is still replaced by the generic fallback", async () => {
    const breaker = makeBreaker("community.deleteCommunityMessage", () =>
      Promise.reject(new Error("ECONNREFUSED 127.0.0.1:50051"))
    );
    await expect(breaker.fire(undefined)).rejects.toThrow(
      "community.deleteCommunityMessage unavailable"
    );
  });

  it("a raw INTERNAL gRPC status (unexpected callee bug) is still replaced by the generic fallback", async () => {
    const breaker = makeBreaker("community.deleteCommunityMessage", () =>
      Promise.reject(
        serviceError(
          grpc.status.INTERNAL,
          "some internal detail that must not leak"
        )
      )
    );
    await expect(breaker.fire(undefined)).rejects.toThrow(
      "community.deleteCommunityMessage unavailable"
    );
  });
});

describe("community:message:delete — full breaker -> ack chain (the actual reported bug)", () => {
  /** Mirrors exactly what the gateway handler's `.catch()` does. */
  function simulateGatewayCatch(err: unknown) {
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

  it("message not found -> specific ack, not the generic fallback", async () => {
    const breaker = makeBreaker("community.deleteCommunityMessage", () =>
      Promise.reject(
        serviceError(grpc.status.NOT_FOUND, "CHAT_MESSAGE_NOT_FOUND")
      )
    );
    const err = await breaker.fire(undefined).catch((e: unknown) => e);
    const ack = simulateGatewayCatch(err);
    expect(ack).toEqual({
      success: false,
      error: "NOT_FOUND",
      retryable: false,
      message: "Message not found",
      detail: "CHAT_MESSAGE_NOT_FOUND",
    });
  });

  it("already deleted -> specific ack, not the generic fallback", async () => {
    const breaker = makeBreaker("community.deleteCommunityMessage", () =>
      Promise.reject(
        serviceError(
          grpc.status.INVALID_ARGUMENT,
          "CHAT_MESSAGE_ALREADY_DELETED"
        )
      )
    );
    const err = await breaker.fire(undefined).catch((e: unknown) => e);
    const ack = simulateGatewayCatch(err);
    expect(ack.message).toBe("Message already deleted");
    expect(ack.retryable).toBe(false);
  });

  it("no permission -> specific ack, not the generic fallback", async () => {
    const breaker = makeBreaker("community.deleteCommunityMessage", () =>
      Promise.reject(
        serviceError(
          grpc.status.INVALID_ARGUMENT,
          "CHAT_INSUFFICIENT_PERMISSIONS"
        )
      )
    );
    const err = await breaker.fire(undefined).catch((e: unknown) => e);
    const ack = simulateGatewayCatch(err);
    expect(ack.message).toBe("Insufficient permissions to perform this action");
    expect(ack.retryable).toBe(false);
  });

  it("true internal/transient failure still falls back to the generic, retryable message", async () => {
    const breaker = makeBreaker("community.deleteCommunityMessage", () =>
      Promise.reject(new Error("ECONNREFUSED"))
    );
    const err = await breaker.fire(undefined).catch((e: unknown) => e);
    const ack = simulateGatewayCatch(err);
    expect(ack).toEqual({
      success: false,
      error: "SERVICE_ERROR",
      retryable: true,
      message: "Something went wrong, please try again",
    });
  });
});
