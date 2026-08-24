/**
 * A new community member's read pointer must be seeded to their join time on
 * CREATE, so a fresh member's derived unread window starts at "now" — NOT epoch
 * 0. `countUnreadBulk` uses `afterDate = lastReadAt ?? new Date(0)`, so a null
 * `lastReadAt` counts EVERY pre-join community-wide message as unread — a phantom
 * badge the moment you join. Updates (role change, mute, ban, rejoin) must NEVER
 * carry `lastReadAt`, so a real read pointer is never clobbered.
 */
import { RoomMemberRepository } from "../../src/repositories/room-member.repository.js";

function makeRepo() {
  let captured: {
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  } | null = null;
  const prisma = {
    roomMember: {
      upsert: (args: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        captured = { create: args.create, update: args.update };
        return Promise.resolve({} as never);
      },
    },
  };
  const repo = new RoomMemberRepository(prisma as never);
  return { repo, get: () => captured! };
}

describe("RoomMemberRepository.upsert read-pointer seeding", () => {
  it("seeds lastReadAt to the provided joinedAt on create", async () => {
    const { repo, get } = makeRepo();
    const joinedAt = new Date("2026-08-24T09:00:00.000Z");
    await repo.upsert("room1", "user1", {
      status: "active",
      role: "member",
      joinedAt,
    });
    expect(get().create.lastReadAt).toEqual(joinedAt);
    expect(get().create.joinedAt).toEqual(joinedAt);
  });

  it("defaults lastReadAt to the create-time joinedAt when none is supplied", async () => {
    const { repo, get } = makeRepo();
    await repo.upsert("room1", "user1", { status: "active", role: "member" });
    expect(get().create.lastReadAt).toBe(get().create.joinedAt);
    expect(get().create.lastReadAt).toBeInstanceOf(Date);
  });

  it("never writes lastReadAt on the update branch", async () => {
    const { repo, get } = makeRepo();
    await repo.upsert("room1", "user1", { role: "moderator" });
    expect("lastReadAt" in get().update).toBe(false);
  });
});
