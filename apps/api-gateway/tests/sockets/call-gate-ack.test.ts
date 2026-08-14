/**
 * `call:initiate` refusal copy — the client-visible half of the friends-only
 * call rule (src/sockets/namespaces/chat.ns.ts + src/sockets/ack.ts).
 *
 * chat-service throws an `AppError` whose `messageKey` names the exact reason
 * ("FRIENDSHIP_REQUIRED", "CALL_BLOCKED", …); the gRPC layer forwards that key
 * verbatim in `details`, `resolveGrpcAckError` lifts it into `detailKey`, and
 * `ackError` resolves it through the shared `t()` catalog.
 *
 * What these tests protect: a business rejection must reach the user as a
 * finished, localized sentence — never a bare code, a stack trace, a raw gRPC
 * status, or the generic "Something went wrong" fallback (which would read as a
 * bug rather than a rule). The real catalogs are used, so the asserted strings
 * are the actual copy a client would show.
 */
import * as grpc from "@grpc/grpc-js";
import { ackError, resolveGrpcAckError } from "../../src/sockets/ack.js";

function capture(): { calls: unknown[]; cb: (res: unknown) => void } {
  const calls: unknown[] = [];
  return { calls, cb: (res: unknown) => calls.push(res) };
}

/** Exactly what `call:initiate`'s gRPC `.catch()` does. */
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

const permissionDenied = (messageKey: string) =>
  Object.assign(new Error(messageKey), {
    code: grpc.status.PERMISSION_DENIED,
    details: messageKey,
  });

describe("call:initiate — refusal acks are business errors, not failures", () => {
  it("a non-friend gets the friends-only sentence, not a generic error", () => {
    const ack = simulateInitiateCatch(permissionDenied("FRIENDSHIP_REQUIRED"));

    expect(ack).toEqual({
      success: false,
      error: "FORBIDDEN",
      // A rule, not a blip — re-emitting the same payload cannot succeed.
      retryable: false,
      message: "Calls are only available between friends.",
      detail: "FRIENDSHIP_REQUIRED",
    });
  });

  it.each([
    ["CALL_BLOCKED", "You cannot call a blocked user."],
    ["PRIVACY_BLOCKED", "This user is not accepting calls from you."],
    ["CALLING_DISABLED", "Calling is currently unavailable."],
  ])("%s resolves to its own copy", (detailKey, expected) => {
    const ack = simulateInitiateCatch(permissionDenied(detailKey));
    expect(ack.message).toBe(expected);
    expect(ack.detail).toBe(detailKey);
  });

  it("a deleted target is NOT_FOUND with its own copy", () => {
    const ack = simulateInitiateCatch(
      Object.assign(new Error("CALL_USER_UNAVAILABLE"), {
        code: grpc.status.NOT_FOUND,
        details: "CALL_USER_UNAVAILABLE",
      })
    );

    expect(ack.error).toBe("NOT_FOUND");
    expect(ack.message).toBe("This account is no longer available.");
  });

  it("never leaks internals: a raw INTERNAL still yields the generic message", () => {
    const ack = simulateInitiateCatch({
      code: grpc.status.INTERNAL,
      message: "Error: connect ECONNREFUSED 10.0.0.4:50052\n    at TCP...",
    });

    expect(ack.error).toBe("SERVICE_ERROR");
    expect(ack.message).toBe("Something went wrong, please try again");
    expect(ack.detail).toBeUndefined();
    expect(ack.message).not.toMatch(/ECONNREFUSED|at TCP/);
  });
});
