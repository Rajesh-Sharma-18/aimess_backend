/**
 * Read receipts are a POINT-IN-TIME policy, not a boolean applied to history.
 *
 * The timeline this pins, end to end:
 *
 *   T1  A switches read receipts OFF
 *   T2  A sends A1
 *   T3  B reads A1                      (B gives receipts)
 *   T4  B sends B1
 *   T5  A reads B1                      (with the switch OFF)
 *   T6  A switches read receipts ON     <- and NOTHING may turn blue
 *   T7  B sends B2
 *   T8  A reads B2                      (with the switch ON)
 *
 * Two independent halves make that true, and both are tested here:
 *
 *   READER half — the read at T5 must never be publishable, not live and not on
 *   a later refresh. The exposable pointer (`receiptRead*`) freezes while the
 *   reader's switch is off, so the read at T5 leaves nothing to expose.
 *
 *   VIEWER half — the receipt B produced at T3 was withheld from A while A's
 *   switch was off, and T6 is not a read event, so it stays withheld. Every
 *   receipt carries the instant it happened; A's `readReceiptsEnabledAt` is the
 *   line it is compared against.
 *
 * The bug both halves fix: the tick was derived from the CURRENT preference
 * applied to a watermark that had gone on advancing regardless, so flipping the
 * switch back on turned every message of the off window blue at once.
 */
import request from "supertest";

import { PrivateMessageService } from "../../src/services/private-message.service.js";
import { receiptCursorOf } from "../../src/lib/read-receipts.js";
import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { invalidateAccountChatSettings } from "../../src/lib/account-chat-settings.js";
import { userGrpcClient } from "../../src/grpc/user-snapshot.client.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "prv_receipt_history";
const PEER = "peer-1";
const B1 = "bbbbbbbbbbbbbbbbbbbbbbb1";

/** T-instants of the scenario, fixed so the assertions are deterministic. */
const T0_BEFORE_OFF = new Date("2026-08-20T09:50:00.000Z");
const T3_PEER_READ_WHILE_A_BLIND = new Date("2026-08-20T10:05:00.000Z");
const T6_A_TURNS_RECEIPTS_ON = new Date("2026-08-20T10:10:00.000Z");
const T8_PEER_READ_AFTER = new Date("2026-08-20T10:12:00.000Z");

function setChatSettings(
  readReceipts: boolean,
  readReceiptsEnabledAt = 0
): void {
  (userGrpcClient.getChatSettings as jest.Mock).mockResolvedValue({
    autoDeleteTimer: "OFF",
    typingIndicators: true,
    readReceipts,
    readReceiptsEnabledAt,
  });
}

/**
 * The room as the DB holds it: the peer's plain pointer sits on the newest
 * message (it drives their unread badge and never stops), while the EXPOSABLE
 * pointer is whatever the receipt rules left behind.
 */
function givenRoom(peerReceipt: {
  messageId: string | null;
  readAt: Date | null;
}): void {
  mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
    roomId: ROOM,
    participants: [TEST_USER_ID, PEER],
    lastMessageId: "msg_newest",
    lastReadMessageIdByUser: { [PEER]: "msg_newest" },
    lastReadAtByUser: { [PEER]: T8_PEER_READ_AFTER.toISOString() },
    receiptReadMessageIdByUser: { [PEER]: peerReceipt.messageId },
    receiptReadAtByUser: {
      [PEER]: peerReceipt.readAt ? peerReceipt.readAt.toISOString() : null,
    },
  });
}

/**
 * The cursor the transcript ships as `peerReadSeq` and the inbox row folds into
 * its tick — one number, one rule, both surfaces. Driven through the service
 * rather than the route so the assertion is about the receipt decision and not
 * about the pagination branch that happens to be in front of it.
 */
const peerReadSeqOf = (): Promise<number> =>
  new PrivateMessageService(
    mocks.privateMessageRepo,
    mocks.privateRoomRepo,
    mocks.cacheRepo,
    {} as never,
    {} as never,
    {} as never
  ).getPeerReadSeq(ROOM, TEST_USER_ID);

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.privateMessageRepo.findById.mockImplementation((id: string) =>
    Promise.resolve(
      id === B1
        ? { id: B1, roomId: ROOM, sequenceNumber: 9 }
        : { id, roomId: ROOM, sequenceNumber: 42 }
    )
  );
  mocks.privateRoomRepo.markReadUpTo.mockResolvedValue({
    roomId: ROOM,
    participants: [TEST_USER_ID, PEER],
    unreadCountByUser: { [TEST_USER_ID]: 0 },
    lastMessageId: B1,
  });
  invalidateAccountChatSettings();
  setChatSettings(true);
});

describe("reader half — a read taken with receipts OFF is never published", () => {
  it("T5: freezes the exposable pointer instead of advancing it", async () => {
    setChatSettings(false);

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/read`)
      .set(bearer(makeAccessToken()))
      .send({ upToMessageId: B1 });

    expect(res.status).toBe(200);
    // The read still lands — unread, badges and `read_sync` are the reader's
    // own state and must keep working with the switch off.
    expect(mocks.privateRoomRepo.markReadUpTo).toHaveBeenCalledWith(
      expect.objectContaining({ upToMessageId: B1, givesReceipts: false })
    );
  });

  it("T8: advances it again once the switch is back on", async () => {
    setChatSettings(true, T6_A_TURNS_RECEIPTS_ON.getTime());

    await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/read`)
      .set(bearer(makeAccessToken()))
      .send({ upToMessageId: B1 });

    expect(mocks.privateRoomRepo.markReadUpTo).toHaveBeenCalledWith(
      expect.objectContaining({ givesReceipts: true })
    );
  });

  it("exposes the FROZEN pointer, not the plain one that kept advancing", async () => {
    // The peer read on to `msg_newest` (seq 42) with their switch off, so their
    // exposable pointer is still parked on the older B1 (seq 9).
    givenRoom({ messageId: B1, readAt: T0_BEFORE_OFF });

    expect(await peerReadSeqOf()).toBe(9);
  });

  it("exposes nothing at all when the peer has never read with it on", async () => {
    givenRoom({ messageId: null, readAt: null });

    expect(await peerReadSeqOf()).toBe(0);
  });
});

describe("viewer half — turning the switch ON back-fills nothing", () => {
  it("T6: a receipt from the blind window stays withheld afterwards", async () => {
    // B genuinely read A1 at T3 — but A was being shown no receipts then, and
    // the T6 flip is a policy change, not a read event.
    givenRoom({ messageId: "msg_newest", readAt: T3_PEER_READ_WHILE_A_BLIND });
    setChatSettings(true, T6_A_TURNS_RECEIPTS_ON.getTime());

    expect(await peerReadSeqOf()).toBe(0);
  });

  it("T8: a receipt produced after the flip is shown normally", async () => {
    givenRoom({ messageId: "msg_newest", readAt: T8_PEER_READ_AFTER });
    setChatSettings(true, T6_A_TURNS_RECEIPTS_ON.getTime());

    expect(await peerReadSeqOf()).toBe(42);
  });

  it("a user who never switched receipts off keeps every receipt", async () => {
    givenRoom({ messageId: "msg_newest", readAt: T0_BEFORE_OFF });
    setChatSettings(true, 0);

    expect(await peerReadSeqOf()).toBe(42);
  });

  it("still shows nothing while the viewer's own switch is OFF", async () => {
    givenRoom({ messageId: "msg_newest", readAt: T8_PEER_READ_AFTER });
    setChatSettings(false, T6_A_TURNS_RECEIPTS_ON.getTime());

    expect(await peerReadSeqOf()).toBe(0);
  });
});

describe("legacy rows", () => {
  it("fall back to the plain pointer, so no blue tick is lost on deploy", async () => {
    // A room written before the exposable pointer existed: no receipt map at
    // all. Everything in it was recorded under the old always-expose rule.
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, PEER],
      lastReadMessageIdByUser: { [PEER]: "msg_newest" },
      lastReadAtByUser: { [PEER]: T0_BEFORE_OFF.toISOString() },
    });
    setChatSettings(true);

    expect(await peerReadSeqOf()).toBe(42);
  });
});

/**
 * GROUP and COMMUNITY members carry the same pair on their membership row
 * instead of in a per-user map — same three states, one shared reader.
 */
describe("group / community member rows", () => {
  it("prefers the exposable pointer over the plain one", () => {
    expect(
      receiptCursorOf({
        lastReadMessageId: "msg_newest",
        lastReadAt: T8_PEER_READ_AFTER,
        receiptReadMessageId: B1,
        receiptReadAt: T0_BEFORE_OFF,
      })
    ).toEqual({ messageId: B1, readAt: T0_BEFORE_OFF });
  });

  it("reports NO receipt for a member whose first read came with it off", () => {
    // Frozen with nothing to freeze: epoch marks the row as written, so the
    // legacy fallback cannot resurrect the read being withheld.
    expect(
      receiptCursorOf({
        lastReadMessageId: "msg_newest",
        lastReadAt: T8_PEER_READ_AFTER,
        receiptReadMessageId: null,
        receiptReadAt: new Date(0),
      })
    ).toEqual({ messageId: null, readAt: new Date(0) });
  });

  it("falls back to the plain pointer on a row that predates the columns", () => {
    expect(
      receiptCursorOf({
        lastReadMessageId: "msg_newest",
        lastReadAt: T0_BEFORE_OFF,
      })
    ).toEqual({ messageId: "msg_newest", readAt: T0_BEFORE_OFF });
  });
});
