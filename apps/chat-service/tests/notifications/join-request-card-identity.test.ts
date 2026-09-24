/**
 * The admin's join-request card and its terminal partner share ONE identity.
 *
 * `community.join_requested` writes an inbox row for the community's admin, and
 * `community.join_request_retracted` removes it again when the request stops
 * being PENDING. That only works if both events resolve to the SAME group key —
 * a mismatch would leave the card (and the badge) behind forever, which is the
 * failure mode these assertions exist to catch.
 */
import { categorize } from "../../src/lib/notification-category.js";
import {
  isTerminalRemoval,
  resolveGroupKey,
} from "../../src/lib/notification-identity.js";

const CID = "6ab4b2f18dbb7b721ad36da0";
const REQUESTER = "246a48a1-8574-40c2-99c2-662343fedc4c";
const ADMIN = "7b0db132-ffff-4d99-ab3c-421f83fba2ef";

describe("join-request card identity", () => {
  it("gives the request and its retraction the same group key", () => {
    // What the JOIN_REQUESTED consumer branch puts in `data`.
    const requested = resolveGroupKey("community.join_requested", REQUESTER, {
      communityId: CID,
      requesterId: REQUESTER,
    });
    // What the retraction branch sets explicitly.
    const retracted = resolveGroupKey(
      "community.join_request_retracted",
      ADMIN,
      {
        groupKey: `community:${CID}:join_request:${REQUESTER}`,
        communityId: CID,
        requesterId: REQUESTER,
      }
    );
    expect(requested).toBe(`community:${CID}:join_request:${REQUESTER}`);
    expect(retracted).toBe(requested);
  });

  it("keys the card on the REQUESTER, so two requesters get two cards", () => {
    const other = "0a77807a-d1e4-4e50-8c41-281dfebd5cb5";
    expect(
      resolveGroupKey("community.join_requested", REQUESTER, {
        communityId: CID,
        requesterId: REQUESTER,
      })
    ).not.toBe(
      resolveGroupKey("community.join_requested", other, {
        communityId: CID,
        requesterId: other,
      })
    );
  });

  it("treats the retraction as a removal, and the request itself as not one", () => {
    expect(isTerminalRemoval("community.join_request_retracted")).toBe(true);
    expect(isTerminalRemoval("community.join_requested")).toBe(false);
  });

  it("files both under the COMMUNITIES tab", () => {
    expect(categorize("community.join_requested")).toBe("COMMUNITIES");
    expect(categorize("community.join_request_retracted")).toBe("COMMUNITIES");
  });
});
