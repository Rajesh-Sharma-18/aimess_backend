import {
  COPY_PARAM_NAMES,
  copyBuilderArity,
  describeCopyTicket,
  friendCopy,
  callCopy,
  registeredCopyRefs,
} from "../src/notification-copy.js";

/**
 * `COPY_PARAM_NAMES` is what turns a stored positional copy ticket into the
 * `templateId` + named `params` clients render from. It is hand-written, so the
 * only thing standing between it and silent drift is this file: a builder that
 * gains an argument, or a whole namespace added without names, would otherwise
 * ship params the clients cannot interpolate.
 */
describe("copy param names", () => {
  it("names every registered copy builder", () => {
    const missing = registeredCopyRefs().filter(
      (ref) => COPY_PARAM_NAMES[ref] === undefined
    );
    expect(missing).toEqual([]);
  });

  it("declares no names for a ref that is not registered", () => {
    const known = new Set(registeredCopyRefs());
    const orphaned = Object.keys(COPY_PARAM_NAMES).filter(
      (ref) => !known.has(ref)
    );
    expect(orphaned).toEqual([]);
  });

  it("declares exactly as many names as the builder takes arguments", () => {
    const mismatched = registeredCopyRefs()
      .map((ref) => ({
        ref,
        declared: COPY_PARAM_NAMES[ref]?.length ?? -1,
        actual: copyBuilderArity(ref),
      }))
      .filter((row) => row.declared !== row.actual);
    expect(mismatched).toEqual([]);
  });
});

describe("describeCopyTicket", () => {
  it("names a ticket's arguments", () => {
    const ticket = JSON.stringify(friendCopy.requested("Viddhi").descriptor);
    expect(describeCopyTicket(ticket)).toEqual({
      templateId: "friend.requested",
      params: { requesterName: "Viddhi" },
    });
  });

  it("drops absent optional arguments instead of emitting nulls", () => {
    const ticket = JSON.stringify(
      callCopy.activity("Krish", "VIDEO", "ANSWERED", "OUTGOING", 42).descriptor
    );
    expect(describeCopyTicket(ticket)).toEqual({
      templateId: "call.activity",
      params: {
        peerName: "Krish",
        callType: "VIDEO",
        status: "ANSWERED",
        direction: "OUTGOING",
        durationSec: 42,
      },
    });
  });

  it("returns null for authored content, malformed JSON and retired refs", () => {
    expect(describeCopyTicket(undefined)).toBeNull();
    expect(describeCopyTicket("")).toBeNull();
    expect(describeCopyTicket("{not json")).toBeNull();
    expect(
      describeCopyTicket(JSON.stringify({ ref: "friend.gone", args: [] }))
    ).toBeNull();
  });
});
