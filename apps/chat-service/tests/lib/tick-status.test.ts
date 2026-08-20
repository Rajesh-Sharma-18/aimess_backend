/**
 * The tick resolver both surfaces fold through.
 *
 * The failure this guards: the chatroom bubble and the inbox `lastActivity`
 * preview each decided SENT/DELIVERED/READ their own way, so one message could
 * render ✓ in the list and ✓✓ blue in the room. Everything now folds here — if
 * this file and its FE mirror (`src/utils/readReceipts.ts`) ever disagree, the
 * two surfaces disagree again.
 */
import { foldTickStatus } from "../../src/lib/tick-status.js";

describe("foldTickStatus", () => {
  it("is SENT while nobody has it", () => {
    expect(
      foldTickStatus({
        seq: 5,
        otherCount: 1,
        readSeqs: [0],
        deliveredSeqs: [],
      })
    ).toBe("SENT");
  });

  it("is DELIVERED once one member's delivery watermark reaches it", () => {
    expect(
      foldTickStatus({
        seq: 5,
        otherCount: 3,
        readSeqs: [0, 0, 0],
        deliveredSeqs: [5],
      })
    ).toBe("DELIVERED");
  });

  it("stays DELIVERED until EVERY other member has read it", () => {
    expect(
      foldTickStatus({
        seq: 5,
        otherCount: 3,
        readSeqs: [5, 5, 4],
        deliveredSeqs: [5, 5, 5],
      })
    ).toBe("DELIVERED");
  });

  it("is READ when every other member is at or past the message", () => {
    expect(
      foldTickStatus({
        seq: 5,
        otherCount: 3,
        readSeqs: [5, 7, 5],
        deliveredSeqs: [5],
      })
    ).toBe("READ");
  });

  // A member who gives no receipts is passed as 0, not dropped — dropping them
  // would shrink the array and let the members who DO broadcast satisfy
  // "everyone read it" on their own.
  it("never turns blue when a member gives no receipts", () => {
    expect(
      foldTickStatus({
        seq: 5,
        otherCount: 2,
        readSeqs: [5, 0],
        deliveredSeqs: [5],
      })
    ).toBe("DELIVERED");
  });

  // The viewer's own switch is off: the caller hands an empty array.
  it("never turns blue when the viewer cannot see receipts", () => {
    expect(
      foldTickStatus({
        seq: 5,
        otherCount: 2,
        readSeqs: [],
        deliveredSeqs: [5],
      })
    ).toBe("DELIVERED");
  });

  it("never turns blue in a room with no other members", () => {
    expect(
      foldTickStatus({ seq: 5, otherCount: 0, readSeqs: [], deliveredSeqs: [] })
    ).toBe("SENT");
  });

  // An unsettled optimistic row has no server sequence yet; it must not claim
  // a read tick just because every cursor is trivially >= 0.
  it("never turns blue for a row with no sequence yet", () => {
    expect(
      foldTickStatus({
        seq: 0,
        otherCount: 1,
        readSeqs: [9],
        deliveredSeqs: [9],
      })
    ).toBe("SENT");
  });

  // A cursor map that still holds someone who has since left must not block
  // the blue tick — hence a COUNT, not `every`.
  it("ignores a stale cursor for a member who has left", () => {
    expect(
      foldTickStatus({
        seq: 5,
        otherCount: 2,
        readSeqs: [5, 5, 1],
        deliveredSeqs: [5],
      })
    ).toBe("READ");
  });
});
