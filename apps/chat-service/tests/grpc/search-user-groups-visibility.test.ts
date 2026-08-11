/**
 * Group search visibility (gRPC `searchUserGroups`, src/grpc/service-impl.ts).
 *
 * A group is searchable for a viewer ONLY when the viewer is an ACTIVE member,
 * OR the group is still in the viewer's own conversation list (a LEFT/KICKED
 * membership row whose "Delete Conversation" cutoff the group's last message
 * still outlives). Group existence — public, name-matching, previously joined,
 * previously invited, or someone else's group — never grants visibility.
 *
 * Infra-free: repositories are jest.fn stubs, so this asserts the authorization
 * rule and the query shape (the candidate id set is always derived from the
 * viewer's own membership rows, never an unbounded "all other groups" scan).
 */

import {
  createMessagingImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";

type Handler = (
  call: { request: unknown },
  cb: (err: unknown, res?: unknown) => void
) => void;

function invoke(handler: Handler, request: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    handler({ request }, (err, res) =>
      err
        ? reject(err instanceof Error ? err : new Error(String(err)))
        : resolve(res)
    );
  });
}

const VIEWER = "usr_viewer";
const NOW = new Date("2026-08-11T10:00:00.000Z");
const EARLIER = new Date("2026-08-11T09:00:00.000Z");
const LATER = new Date("2026-08-11T11:00:00.000Z");

/** A GroupRoom row as the repositories return it. */
function room(roomId: string, lastMessageAt: Date | null = NOW) {
  return {
    roomId,
    name: "Krishna Devotee",
    avatar: "",
    description: "",
    memberCount: 3,
    lastMessageAt,
    createdAt: EARLIER,
  };
}

/** A GroupMember row as `getActiveOrLeftMemberships` returns it. */
function membership(
  roomId: string,
  status: "ACTIVE" | "LEFT" | "KICKED",
  clearedAt: Date | null = null
) {
  return { roomId, status, clearedAt };
}

function setup(params: {
  memberships: ReturnType<typeof membership>[];
  /** Rows the room repo returns for whatever id set it is handed. */
  rooms: ReturnType<typeof room>[];
}) {
  const searchInRoomIds = jest.fn(async () => params.rooms);
  const findManyByRoomIds = jest.fn(async () => params.rooms);
  const getActiveOrLeftMemberships = jest.fn(async () => params.memberships);
  const impl = createMessagingImpl({
    groupMemberRepo: { getActiveOrLeftMemberships },
    groupRoomRepo: { searchInRoomIds, findManyByRoomIds },
  } as unknown as GrpcDeps);
  return {
    handler: impl.searchUserGroups as unknown as Handler,
    searchInRoomIds,
    findManyByRoomIds,
  };
}

const search = (h: Handler, mode: string, roomIds: string[] = []) =>
  invoke(h, { viewerId: VIEWER, q: "krishna", mode, roomIds, limit: 10 });

describe("gRPC searchUserGroups — visibility", () => {
  it("ACTIVE mode returns groups the viewer actively belongs to", async () => {
    const { handler, searchInRoomIds } = setup({
      memberships: [membership("grp_a", "ACTIVE")],
      rooms: [room("grp_a")],
    });
    const res = await search(handler, "ACTIVE");
    expect(searchInRoomIds).toHaveBeenCalledWith(["grp_a"], "krishna", 10);
    expect(res.groups).toEqual([
      expect.objectContaining({ roomId: "grp_a", isActiveMember: true }),
    ]);
  });

  it("an active member still sees the group after deleting the conversation", async () => {
    // clearedAt is NEWER than the last message: the row is gone from their
    // inbox, but active membership alone keeps it searchable.
    const { handler } = setup({
      memberships: [membership("grp_a", "ACTIVE", LATER)],
      rooms: [room("grp_a", NOW)],
    });
    const res = await search(handler, "ACTIVE");
    expect(res.groups).toHaveLength(1);
  });

  it("OTHER mode never scans beyond the viewer's own membership rows", async () => {
    // The regression: `searchOtherForUser` used to hand the DB a `notIn` of the
    // viewer's rooms, so every public/unrelated group whose NAME matched came
    // back with isActiveMember:false. The candidate set is now the viewer's
    // own non-active memberships and nothing else.
    const { handler, searchInRoomIds } = setup({
      memberships: [
        membership("grp_active", "ACTIVE"),
        membership("grp_left", "LEFT"),
        membership("grp_kicked", "KICKED"),
      ],
      rooms: [room("grp_left"), room("grp_kicked")],
    });
    const res = await search(handler, "OTHER", ["grp_excluded"]);
    expect(searchInRoomIds).toHaveBeenCalledWith(
      ["grp_left", "grp_kicked"],
      "krishna",
      10
    );
    expect(res.groups.map((g: any) => g.roomId)).toEqual([
      "grp_left",
      "grp_kicked",
    ]);
    expect(res.groups.every((g: any) => g.isActiveMember === false)).toBe(true);
  });

  it("a viewer with no membership row at all gets nothing", async () => {
    // Even if the room repo were to hand back a name-matching group.
    const { handler, searchInRoomIds } = setup({
      memberships: [],
      rooms: [room("grp_unrelated")],
    });
    const res = await search(handler, "OTHER");
    expect(searchInRoomIds).toHaveBeenCalledWith([], "krishna", 10);
    expect(res.groups).toEqual([]);
  });

  it("drops a left/removed group whose conversation the viewer deleted", async () => {
    // clearedAt newer than lastMessageAt → not in their conversation list.
    const { handler } = setup({
      memberships: [
        membership("grp_kept", "LEFT", EARLIER),
        membership("grp_deleted", "KICKED", LATER),
      ],
      rooms: [room("grp_kept", NOW), room("grp_deleted", NOW)],
    });
    const res = await search(handler, "OTHER");
    expect(res.groups.map((g: any) => g.roomId)).toEqual(["grp_kept"]);
  });

  it("BY_IDS (Recent) applies the same rule instead of trusting the id", async () => {
    const { handler } = setup({
      memberships: [membership("grp_deleted", "LEFT", LATER)],
      rooms: [room("grp_deleted", NOW), room("grp_never_joined", NOW)],
    });
    const res = await invoke(handler, {
      viewerId: VIEWER,
      mode: "BY_IDS",
      roomIds: ["grp_deleted", "grp_never_joined"],
      limit: 10,
    });
    expect(res.groups).toEqual([]);
  });

  it("BANNED is not a membership the inbox lists, so it is not searchable", async () => {
    // getActiveOrLeftMemberships filters BANNED out at the query — modelled
    // here by it simply not being in the returned rows.
    const { handler } = setup({
      memberships: [],
      rooms: [room("grp_banned")],
    });
    const res = await search(handler, "OTHER");
    expect(res.groups).toEqual([]);
  });
});
