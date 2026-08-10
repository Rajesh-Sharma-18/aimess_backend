import { PrivateRoomService } from "../../src/services/private-room.service.js";
import { publishUserReport } from "../../src/lib/report-user.js";
import { publishAdminReportIngestSafe } from "../../src/events/publish-admin-report.js";

jest.mock("../../src/events/publish-admin-report.js", () => ({
  publishAdminReportIngestSafe: jest.fn(),
}));

/**
 * The user-report path is the one place a client hands us BOTH a room id and a
 * target user id, so it is the one place a valid room id could be used to report
 * an unrelated user, or a non-participant could file a report into someone
 * else's conversation. Those three guards (no self, reporter in room, target in
 * room) are the whole security surface of this endpoint.
 *
 * The `sourceReportId` shape is the second thing under test: admin_db.Report has
 * a unique index on it, so it — and only it — is what stops the same reporter
 * filing the same report twice (community-service uses a 409 for the same rule).
 * A timestamp or random component in this key silently disables that dedup.
 */
const ROOM = "prv_room_1";
const REPORTER = "user_reporter";
const TARGET = "user_target";

const publishMock = publishAdminReportIngestSafe as jest.MockedFunction<
  typeof publishAdminReportIngestSafe
>;

function buildService(participants: string[] | null) {
  const privateRoomRepo = {
    findByRoomId: jest
      .fn()
      .mockResolvedValue(
        participants ? { roomId: ROOM, participants } : null
      ),
  };
  return new PrivateRoomService(
    privateRoomRepo as unknown as ConstructorParameters<
      typeof PrivateRoomService
    >[0],
    {} as unknown as ConstructorParameters<typeof PrivateRoomService>[1],
    {} as unknown as ConstructorParameters<typeof PrivateRoomService>[2],
    {} as unknown as ConstructorParameters<typeof PrivateRoomService>[3],
    {} as unknown as ConstructorParameters<typeof PrivateRoomService>[4],
    {} as unknown as ConstructorParameters<typeof PrivateRoomService>[5]
  );
}

const report = (service: PrivateRoomService, targetUserId: string) =>
  service.reportUser({
    roomId: ROOM,
    reporterId: REPORTER,
    targetUserId,
    reason: "OFFENSIVE_LANGUAGE",
    description: "  keeps swearing  ",
  });

beforeEach(() => publishMock.mockClear());

describe("PrivateRoomService.reportUser", () => {
  it("publishes one ingest row for a valid report", async () => {
    const service = buildService([REPORTER, TARGET]);

    await expect(report(service, TARGET)).resolves.toEqual({ ok: true });

    expect(publishMock).toHaveBeenCalledTimes(1);
    const payload = publishMock.mock.calls[0]![0];
    expect(payload.type).toBe("user");
    expect(payload.targetId).toBe(TARGET);
    expect(payload.reporterId).toBe(REPORTER);
    // Free-text reason reaches the sink verbatim — community's vocabulary, not
    // a chat-only enum (backoffice canonicalizes it).
    expect(payload.reason).toBe("OFFENSIVE_LANGUAGE");
    expect(payload.details).toBe("keeps swearing");
    expect(payload.communityId).toBeNull();
  });

  it("keys the ingest deterministically so a repeat report dedups at the sink", async () => {
    const service = buildService([REPORTER, TARGET]);

    await report(service, TARGET);
    await report(service, TARGET);

    const [first, second] = publishMock.mock.calls.map((c) => c[0]);
    expect(first!.sourceReportId).toBe(`dm:${ROOM}:${REPORTER}:${TARGET}`);
    expect(second!.sourceReportId).toBe(first!.sourceReportId);
  });

  it("rejects self-reporting", async () => {
    const service = buildService([REPORTER, TARGET]);
    await expect(report(service, REPORTER)).rejects.toThrow(
      /CHAT_REPORT_OWN_MESSAGE/
    );
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("rejects a reporter who is not in the room", async () => {
    const service = buildService(["someone_else", TARGET]);
    await expect(report(service, TARGET)).rejects.toThrow(
      /CHAT_REPORT_NOT_PARTICIPANT/
    );
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("rejects a target who is not in the room (valid room id, unrelated user)", async () => {
    const service = buildService([REPORTER, "someone_else"]);
    await expect(report(service, TARGET)).rejects.toThrow(
      /CHAT_REPORT_NOT_PARTICIPANT/
    );
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("404s on a missing room", async () => {
    const service = buildService(null);
    await expect(report(service, TARGET)).rejects.toThrow(
      /CHAT_ROOM_NOT_FOUND/
    );
    expect(publishMock).not.toHaveBeenCalled();
  });
});

describe("publishUserReport", () => {
  it("prefixes GROUP reports so a group and a DM key can never collide", () => {
    publishUserReport({
      context: "GROUP",
      roomId: "grp_1",
      reporterId: REPORTER,
      targetUserId: TARGET,
      reason: "SPAM",
    });
    expect(publishMock.mock.calls[0]![0].sourceReportId).toBe(
      `grp:grp_1:${REPORTER}:${TARGET}`
    );
  });

  it("sends null details for an empty description", () => {
    publishUserReport({
      context: "GROUP",
      roomId: "grp_1",
      reporterId: REPORTER,
      targetUserId: TARGET,
      reason: "SPAM",
      description: "   ",
    });
    expect(publishMock.mock.calls[0]![0].details).toBeNull();
  });
});
