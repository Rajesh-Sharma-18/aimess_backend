/**
 * Ack error-mapping coverage for `community:message:delete`
 * (src/sockets/namespaces/community.ns.ts) and the shared helpers it uses
 * (src/sockets/ack.ts: `ackError` detail-key support + `resolveGrpcAckError`).
 *
 * Root cause under test: `community:message:delete`'s gRPC `.catch()` used to
 * always call `ackError(callback, "SERVICE_ERROR", locale)` — discarding
 * whatever specific failure chat-service actually reported (message not
 * found, already deleted, insufficient permissions, muted, room suspended,
 * etc.) and returning the same generic "Something went wrong, please try
 * again" for every case.
 *
 * Fix: `resolveGrpcAckError` reads the caught gRPC error's `code`/`details`
 * (chat-service now maps AppErrors to a gRPC status + forwards the
 * `messageKey` verbatim, see delete-community-message-errors.test.ts in
 * chat-service) and returns `{ code, detailKey }`; `ackError` resolves
 * `detailKey` via the SAME `t()` catalog used everywhere else, falling back
 * to the existing generic per-code message when there's no usable detail.
 *
 * These tests exercise the real `t()`/`SOCKET_MESSAGES`/`CHAT_MESSAGES`
 * catalogs (no mocking of `@aimess/constants`) so the asserted strings are
 * the actual copy a client would see.
 */
import * as grpc from "@grpc/grpc-js";
import { ackError, resolveGrpcAckError } from "../../src/sockets/ack.js";

function capture(): { calls: unknown[]; cb: (res: unknown) => void } {
  const calls: unknown[] = [];
  return { calls, cb: (res: unknown) => calls.push(res) };
}

describe("resolveGrpcAckError", () => {
  it("maps NOT_FOUND + a well-formed messageKey to { code: NOT_FOUND, detailKey }", () => {
    const err = {
      code: grpc.status.NOT_FOUND,
      message: "CHAT_MESSAGE_NOT_FOUND",
    };
    expect(resolveGrpcAckError(err)).toEqual({
      code: "NOT_FOUND",
      detailKey: "CHAT_MESSAGE_NOT_FOUND",
    });
  });

  it("maps INVALID_ARGUMENT to INVALID_PAYLOAD with the messageKey", () => {
    const err = {
      code: grpc.status.INVALID_ARGUMENT,
      message: "CHAT_SYSTEM_MESSAGE_IMMUTABLE",
    };
    expect(resolveGrpcAckError(err)).toEqual({
      code: "INVALID_PAYLOAD",
      detailKey: "CHAT_SYSTEM_MESSAGE_IMMUTABLE",
    });
  });

  it("maps PERMISSION_DENIED to FORBIDDEN with the messageKey", () => {
    const err = {
      code: grpc.status.PERMISSION_DENIED,
      message: "CHAT_MUTED_IN_COMMUNITY",
    };
    expect(resolveGrpcAckError(err)).toEqual({
      code: "FORBIDDEN",
      detailKey: "CHAT_MUTED_IN_COMMUNITY",
    });
  });

  it("prefers `details` over `message` when both are present (grpc-js decorates `message`)", () => {
    const err = {
      code: grpc.status.NOT_FOUND,
      message: "5 NOT_FOUND: CHAT_MESSAGE_NOT_FOUND",
      details: "CHAT_MESSAGE_NOT_FOUND",
    };
    expect(resolveGrpcAckError(err)).toEqual({
      code: "NOT_FOUND",
      detailKey: "CHAT_MESSAGE_NOT_FOUND",
    });
  });

  it("falls back to SERVICE_ERROR with no detailKey for an unrecognized gRPC status (raw INTERNAL)", () => {
    const err = { code: grpc.status.INTERNAL, message: "INTERNAL_ERROR" };
    expect(resolveGrpcAckError(err)).toEqual({ code: "SERVICE_ERROR" });
  });

  it("falls back to SERVICE_ERROR for a network/breaker failure with no gRPC code at all", () => {
    const err = new Error("community.deleteCommunityMessage unavailable");
    expect(resolveGrpcAckError(err)).toEqual({ code: "SERVICE_ERROR" });
  });

  it("does not treat a non-catalog-shaped details string as a detailKey (defense-in-depth)", () => {
    const err = {
      code: grpc.status.NOT_FOUND,
      message: "some free-text sentence",
    };
    const result = resolveGrpcAckError(err);
    expect(result.code).toBe("NOT_FOUND");
    expect(result.detailKey).toBeUndefined();
  });
});

describe("ackError — detailKey resolution", () => {
  it("uses the specific message when detailKey resolves to real catalog copy", () => {
    const { calls, cb } = capture();
    ackError(cb, "NOT_FOUND", "en", "CHAT_MESSAGE_NOT_FOUND");
    expect(calls[0]).toEqual({
      success: false,
      error: "NOT_FOUND",
      retryable: false,
      message: "Message not found",
      detail: "CHAT_MESSAGE_NOT_FOUND",
    });
  });

  it("uses the system-message-immutable copy for CHAT_SYSTEM_MESSAGE_IMMUTABLE", () => {
    const { calls, cb } = capture();
    ackError(cb, "INVALID_PAYLOAD", "en", "CHAT_SYSTEM_MESSAGE_IMMUTABLE");
    expect((calls[0] as { message: string }).message).toBe(
      "System messages cannot be deleted"
    );
  });

  it("uses the insufficient-permissions copy for CHAT_INSUFFICIENT_PERMISSIONS", () => {
    const { calls, cb } = capture();
    ackError(cb, "INVALID_PAYLOAD", "en", "CHAT_INSUFFICIENT_PERMISSIONS");
    expect((calls[0] as { message: string }).message).toBe(
      "Insufficient permissions to perform this action"
    );
  });

  it("uses the muted-in-community copy for CHAT_MUTED_IN_COMMUNITY", () => {
    const { calls, cb } = capture();
    ackError(cb, "FORBIDDEN", "en", "CHAT_MUTED_IN_COMMUNITY");
    expect((calls[0] as { message: string }).message).toBe(
      "You are muted in this community and cannot post messages"
    );
  });

  it("uses the room-suspended copy for COMMUNITY_SUSPENDED", () => {
    const { calls, cb } = capture();
    ackError(cb, "FORBIDDEN", "en", "COMMUNITY_SUSPENDED");
    expect((calls[0] as { message: string }).message).toBe(
      "This community is suspended"
    );
  });

  it("falls back to the generic per-code message when detailKey is omitted", () => {
    const { calls, cb } = capture();
    ackError(cb, "SERVICE_ERROR", "en");
    expect((calls[0] as { message: string }).message).toBe(
      "Something went wrong, please try again"
    );
  });

  it("falls back to the generic per-code message when detailKey is not in the catalog", () => {
    const { calls, cb } = capture();
    ackError(cb, "SERVICE_ERROR", "en", "NOT_A_REAL_CATALOG_KEY");
    expect((calls[0] as { message: string }).message).toBe(
      "Something went wrong, please try again"
    );
  });

  it("preserves success/error/retryable exactly as before — only `message`/`detail` change", () => {
    const generic = capture();
    ackError(generic.cb, "NOT_FOUND", "en");
    const specific = capture();
    ackError(specific.cb, "NOT_FOUND", "en", "CHAT_MESSAGE_NOT_FOUND");

    const g = generic.calls[0] as Record<string, unknown>;
    const s = specific.calls[0] as Record<string, unknown>;
    expect(s.success).toBe(g.success);
    expect(s.error).toBe(g.error);
    expect(s.retryable).toBe(g.retryable);
    expect(s.message).not.toBe(g.message); // the improvement: message differs
    expect(s.detail).toBe("CHAT_MESSAGE_NOT_FOUND");
    // Omitted entirely (not `undefined`) when there is no key to report, so a
    // client can use `"detail" in ack` as a presence check.
    expect(g).not.toHaveProperty("detail");
  });
});

describe("community:message:delete — end-to-end error scenarios (gRPC error -> ack)", () => {
  function simulateDeleteCatch(grpcErr: unknown) {
    const { calls, cb } = capture();
    const { code, detailKey } = resolveGrpcAckError(grpcErr);
    ackError(cb, code, "en", detailKey);
    return calls[0] as {
      success: false;
      error: string;
      retryable: boolean;
      message: string;
    };
  }

  it("message not found -> specific, actionable message", () => {
    const ack = simulateDeleteCatch({
      code: grpc.status.NOT_FOUND,
      message: "CHAT_MESSAGE_NOT_FOUND",
    });
    expect(ack).toEqual({
      success: false,
      error: "NOT_FOUND",
      retryable: false,
      message: "Message not found",
      detail: "CHAT_MESSAGE_NOT_FOUND",
    });
  });

  it("message cannot be deleted (system message) -> specific, actionable message", () => {
    const ack = simulateDeleteCatch({
      code: grpc.status.INVALID_ARGUMENT,
      message: "CHAT_SYSTEM_MESSAGE_IMMUTABLE",
    });
    expect(ack.message).toBe("System messages cannot be deleted");
  });

  it("permission denied / not the sender -> specific, actionable message", () => {
    const ack = simulateDeleteCatch({
      code: grpc.status.INVALID_ARGUMENT,
      message: "CHAT_INSUFFICIENT_PERMISSIONS",
    });
    expect(ack.message).toBe("Insufficient permissions to perform this action");
  });

  it("community/room not writable (suspended) -> specific, actionable message", () => {
    const ack = simulateDeleteCatch({
      code: grpc.status.PERMISSION_DENIED,
      message: "COMMUNITY_SUSPENDED",
    });
    expect(ack.message).toBe("This community is suspended");
  });

  it("truly unexpected internal failure -> generic fallback only, never leaked", () => {
    const ack = simulateDeleteCatch({
      code: grpc.status.INTERNAL,
      message: "INTERNAL_ERROR",
    });
    expect(ack.error).toBe("SERVICE_ERROR");
    expect(ack.retryable).toBe(true);
    expect(ack.message).toBe("Something went wrong, please try again");
  });

  it("network/breaker failure with no gRPC shape -> generic fallback only", () => {
    const ack = simulateDeleteCatch(
      new Error("community.deleteCommunityMessage unavailable")
    );
    expect(ack.error).toBe("SERVICE_ERROR");
    expect(ack.message).toBe("Something went wrong, please try again");
  });
});
