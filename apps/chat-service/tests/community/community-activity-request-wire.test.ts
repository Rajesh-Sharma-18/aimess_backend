/**
 * Wire shape of the `UpdateMessageActivity` gRPC request.
 *
 * `community-delete-activity-rollback.test.ts` pins the PARAMS the delete path
 * hands the client; this pins what the client actually puts on the wire. Both
 * are needed because proto3 has no required fields: a key missing from the
 * request literal is transmitted as its zero value, indistinguishable from a
 * deliberate 0/"".
 *
 * The bug: fields 10-13 (`clientMessageId`, `seq`, `contentType`,
 * `rollbackNotNewerThan`) were absent from the literal. Every delete-for-
 * everyone of a community's last message therefore arrived with
 * `rollbackNotNewerThan: 0`, which selects community-service's FORWARD-ONLY
 * `updateLastActivity` branch instead of `rollbackLastActivity`. The backward
 * write was silently rejected and `GET /communities/mine` kept previewing the
 * deleted message across reloads and re-logins, while chat-service's own
 * `GeneralRoom.lastMessage` snapshot had already rolled back correctly.
 */
import { toUpdateMessageActivityRequest } from "../../src/grpc/community-activity-request.js";

const REMOVED_AT = new Date("2026-08-10T10:10:00.000Z").getTime();
const PREV_AT = new Date("2026-08-10T10:05:00.000Z").getTime();

describe("toUpdateMessageActivityRequest", () => {
  it("carries rollbackNotNewerThan so a delete recalc takes the BACKWARD path", () => {
    const req = toUpdateMessageActivityRequest({
      communityId: "cmt-1",
      lastMessageAt: PREV_AT,
      lastMessageId: "msg-prev",
      senderUserId: "peer-1",
      senderUsername: "Peer One",
      messagePreview: "Hi",
      activityType: "message",
      clientMessageId: "cmid-2",
      seq: 7,
      contentType: "TEXT",
      rollbackNotNewerThan: REMOVED_AT,
    });

    // int64 fields ride as strings under `longs: String`.
    expect(req.rollbackNotNewerThan).toBe(String(REMOVED_AT));
    expect(req.lastMessageAt).toBe(String(PREV_AT));
    // Identity trio — blank values here would overwrite what the async
    // `community.activity` queue wrote for the same message.
    expect(req.clientMessageId).toBe("cmid-2");
    expect(req.seq).toBe(7);
    expect(req.contentType).toBe("TEXT");
  });

  it("defaults rollbackNotNewerThan to 0 for an ordinary forward bump", () => {
    const req = toUpdateMessageActivityRequest({
      communityId: "cmt-1",
      lastMessageAt: PREV_AT,
      lastMessageId: "msg-prev",
    });

    expect(req.rollbackNotNewerThan).toBe("0");
    expect(req.activityType).toBe("message");
    expect(req.selfUserId).toBe("");
  });

  it("declares every field in the proto message", () => {
    // Guards the actual defect: a field silently missing from the literal.
    expect(
      Object.keys(toUpdateMessageActivityRequest({ communityId: "c" })).sort()
    ).toEqual(
      [
        "activityType",
        "clientMessageId",
        "communityId",
        "contentType",
        "lastMessageAt",
        "lastMessageId",
        "messagePreview",
        "rollbackNotNewerThan",
        "selfPreview",
        "selfUserId",
        "senderUserId",
        "senderUsername",
        "seq",
      ].sort()
    );
  });
});
