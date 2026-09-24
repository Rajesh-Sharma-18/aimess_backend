/**
 * A join request card must never be rewritten in place by the NEXT attempt.
 *
 * The row behind it is unique per (community, requester) and recycled, so
 * request → cancel → request again comes back under the identity of the attempt
 * before it. Transitioning that card produces no new-notification event and no
 * badge — the admin sees a card they already read and the second request looks
 * like it was never made. The producer retracts the old card first; this rule is
 * what keeps the behaviour correct when that retraction is lost.
 */
import { resolveTransition, isTerminalRemoval } from "../../src/lib/notification-identity.js";

describe("join request card transitions", () => {
  it("gives every new attempt its own card", () => {
    const plan = resolveTransition(
      "community.join_requested",
      "community.join_requested"
    );
    // CREATE, not UPDATE: a rewritten row keeps its id and its read state, which
    // is exactly how the second request became invisible.
    expect(plan.action).toBe("CREATE");
    expect(plan.resurface).toBe(true);
  });

  it("gives a new attempt its own card after the previous one was settled", () => {
    for (const settled of [
      "community.join_request_retracted",
      "community.join_request_approved",
      "community.join_request_rejected",
    ]) {
      expect(resolveTransition(settled, "community.join_requested").action).toBe(
        "CREATE"
      );
    }
  });

  it("still removes the card when the attempt is settled", () => {
    expect(isTerminalRemoval("community.join_request_retracted")).toBe(true);
    expect(
      resolveTransition("community.join_requested", "community.join_request_retracted")
        .action
    ).toBe("DELETE");
  });

  it("leaves unrelated community cards transitioning as they did", () => {
    // Only the join request is exempt — a livestream or membership card still
    // updates in place rather than stacking a second card per event.
    const plan = resolveTransition(
      "community.member_added",
      "community.member_added"
    );
    expect(plan.action).toBe("UPDATE");
  });
});
