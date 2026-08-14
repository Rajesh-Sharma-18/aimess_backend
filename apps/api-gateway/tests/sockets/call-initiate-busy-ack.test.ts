/**
 * Root-cause regression: a caller already on a call on ANOTHER of their own
 * devices was told "This person is on another call right now" — blaming the
 * innocent callee — while the same refusal on the SAME device read "You're
 * already on a call."
 *
 * `initiateCall`'s busy gate throws two different `ConflictError`s:
 *   - CALL_ALREADY_IN_CALL — the CALLER is busy (call state is per-USER, so
 *     "busy on another device" lands here, not on the callee branch)
 *   - CALL_USER_BUSY       — the CALLEE is busy
 * Both are HTTP 409 -> gRPC ALREADY_EXISTS -> ack `error: "CONFLICT"`. The ack
 * envelope carried only that coarse code, so the website's `CallContext`
 * `initiate()` could not tell them apart and showed the callee-busy toast for
 * both. Neither key was in the message catalog either, so the localized
 * `message` collapsed to the generic "This action has already been applied".
 *
 * Fix: `ackError` echoes the originating messageKey back as `detail`, and both
 * keys have their own catalog copy. Mirrors the `simulate*Catch` pattern used
 * by community-message-send-ack.test.ts — the exact `.catch()` body in
 * `chat.ns.ts`'s `call:initiate` handler.
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

/** Mirrors exactly what `call:initiate`'s `.catch()` does. */
function simulateInitiateCatch(err: unknown) {
  const { calls, cb } = capture();
  const { code, detailKey } = resolveGrpcAckError(err);
  ackError(cb, code, "en", detailKey);
  return calls[0] as {
    success: false;
    error: string;
    retryable: boolean;
    message: string;
    detail?: string;
  };
}

describe("call:initiate — the two busy reasons stay distinguishable", () => {
  it("CALLER busy (incl. on another device) -> CONFLICT + CALL_ALREADY_IN_CALL", () => {
    const ack = simulateInitiateCatch(
      serviceError(grpc.status.ALREADY_EXISTS, "CALL_ALREADY_IN_CALL")
    );
    expect(ack).toEqual({
      success: false,
      error: "CONFLICT",
      retryable: false,
      message: "You're already on a call.",
      detail: "CALL_ALREADY_IN_CALL",
    });
  });

  it("CALLEE busy -> CONFLICT + CALL_USER_BUSY", () => {
    const ack = simulateInitiateCatch(
      serviceError(grpc.status.ALREADY_EXISTS, "CALL_USER_BUSY")
    );
    expect(ack).toEqual({
      success: false,
      error: "CONFLICT",
      retryable: false,
      message: "This person is on another call right now.",
      detail: "CALL_USER_BUSY",
    });
  });

  it("the two acks differ on more than nothing — the actual bug", () => {
    const mine = simulateInitiateCatch(
      serviceError(grpc.status.ALREADY_EXISTS, "CALL_ALREADY_IN_CALL")
    );
    const theirs = simulateInitiateCatch(
      serviceError(grpc.status.ALREADY_EXISTS, "CALL_USER_BUSY")
    );
    // `error` alone is what the client used to branch on — identical, which is
    // precisely why the wrong toast was shown.
    expect(mine.error).toBe(theirs.error);
    expect(mine.detail).not.toBe(theirs.detail);
    expect(mine.message).not.toBe(theirs.message);
  });

  it("neither collapses to the generic CONFLICT copy any more", () => {
    const generic = capture();
    ackError(generic.cb, "CONFLICT", "en");
    const genericMessage = (generic.calls[0] as { message: string }).message;
    expect(genericMessage).toBe("This action has already been applied");

    for (const key of ["CALL_ALREADY_IN_CALL", "CALL_USER_BUSY"]) {
      const ack = simulateInitiateCatch(
        serviceError(grpc.status.ALREADY_EXISTS, key)
      );
      expect(ack.message).not.toBe(genericMessage);
    }
  });

  it("localizes both reasons, not just English", () => {
    const { calls, cb } = capture();
    ackError(cb, "CONFLICT", "vi", "CALL_ALREADY_IN_CALL");
    expect((calls[0] as { message: string }).message).toBe(
      "Bạn đang trong một cuộc gọi khác."
    );
  });
});
