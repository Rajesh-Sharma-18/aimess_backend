import { buildFriendshipView } from "../../src/lib/friendship-view.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("buildFriendshipView", () => {
  it("returns NONE for no row", () => {
    expect(buildFriendshipView(ME, null)).toEqual({
      status: "NONE",
      direction: null,
      canAccept: false,
      canReject: false,
      canCancel: false,
    });
  });

  it("returns BLOCKED regardless of the underlying row when isBlockedByViewer is true", () => {
    const row = { requesterId: ME, addresseeId: OTHER, status: "ACCEPTED" };
    expect(buildFriendshipView(ME, row, true)).toEqual({
      status: "BLOCKED",
      direction: null,
      canAccept: false,
      canReject: false,
      canCancel: false,
    });
  });

  it("returns ACCEPTED with no actions and no direction", () => {
    const row = { requesterId: ME, addresseeId: OTHER, status: "ACCEPTED" };
    expect(buildFriendshipView(ME, row)).toEqual({
      status: "ACCEPTED",
      direction: null,
      canAccept: false,
      canReject: false,
      canCancel: false,
    });
  });

  it("PENDING + viewer is requester → OUTGOING, canCancel only", () => {
    const row = { requesterId: ME, addresseeId: OTHER, status: "PENDING" };
    expect(buildFriendshipView(ME, row)).toEqual({
      status: "PENDING",
      direction: "OUTGOING",
      canAccept: false,
      canReject: false,
      canCancel: true,
    });
  });

  it("PENDING + viewer is addressee → INCOMING, canAccept+canReject", () => {
    const row = { requesterId: OTHER, addresseeId: ME, status: "PENDING" };
    expect(buildFriendshipView(ME, row)).toEqual({
      status: "PENDING",
      direction: "INCOMING",
      canAccept: true,
      canReject: true,
      canCancel: false,
    });
  });

  it.each(["REJECTED", "CANCELLED", "UNFRIENDED"])(
    "terminal status %s collapses to NONE (row is recycled on next request)",
    (status) => {
      const row = { requesterId: ME, addresseeId: OTHER, status };
      expect(buildFriendshipView(ME, row)).toEqual({
        status: "NONE",
        direction: null,
        canAccept: false,
        canReject: false,
        canCancel: false,
      });
    }
  );
});
