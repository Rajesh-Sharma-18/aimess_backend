/**
 * `MessageSearchService` — the whole-account message-body search behind global
 * search.
 *
 * The three collections are queried with one `roomId: { $in: [...] }` match
 * each, which cannot carry a per-room cutoff, so every room-scoped visibility
 * rule is applied here on the returned rows. That is the part worth pinning
 * down: a leak is someone reading a message they cleared, a group they only
 * used to be in, or history from after they were banned.
 *
 * Repositories are constructor-injected, so hand-rolled stubs are enough. Every
 * avatar is left empty on purpose — `resolveMediaUrlMap` skips falsy keys, so
 * the suite never reaches the media layer.
 */

import { MessageSearchService } from "../../src/services/message-search.service.js";

const ME = "user-me";
const PEER = "user-peer";

const at = (iso: string) => new Date(iso);

const privateMsg = (id: string, roomId: string, iso: string) => ({
  id,
  roomId,
  senderId: PEER,
  content: { text: `hello ${id}`, urls: [], files: [] },
  createdAt: at(iso),
});

const groupMsg = (id: string, roomId: string, iso: string) => ({
  id,
  roomId,
  senderId: PEER,
  senderName: "Frozen Name",
  content: { text: `hello ${id}`, urls: [], files: [] },
  createdAt: at(iso),
});

const communityMsg = (
  id: string,
  roomId: string,
  iso: string,
  over: Record<string, unknown> = {}
) => ({
  id,
  roomId,
  sentBy: PEER,
  senderName: "Frozen Name",
  message: `hello ${id}`,
  createdAt: at(iso),
  deletedBy: [],
  ...over,
});

interface Scopes {
  privateRooms?: Array<{
    roomId: string;
    participants: string[];
    deletedFor?: unknown;
    clearFor?: unknown;
  }>;
  groupMembers?: Array<{
    roomId: string;
    clearedAt: Date | null;
    clearChatAt: Date | null;
    joinedAt: Date | null;
  }>;
  communityMembers?: Array<{
    roomId: string;
    status: string;
    bannedAt: Date | null;
  }>;
  privateHits?: ReturnType<typeof privateMsg>[];
  groupHits?: ReturnType<typeof groupMsg>[];
  communityHits?: ReturnType<typeof communityMsg>[];
}

function build(scopes: Scopes) {
  const searchPrivate = jest.fn(async () => ({
    messages: scopes.privateHits ?? [],
    hasMore: false,
  }));
  const searchGroup = jest.fn(async () => ({
    messages: scopes.groupHits ?? [],
    hasMore: false,
  }));
  const searchCommunity = jest.fn(async () => ({
    messages: scopes.communityHits ?? [],
    hasMore: false,
  }));

  const service = new MessageSearchService(
    { searchPrivate, searchGroup, searchCommunity } as never,
    {
      findSearchScope: async () =>
        (scopes.privateRooms ?? []).map((r) => ({
          deletedFor: {},
          clearFor: {},
          ...r,
        })),
    } as never,
    {
      findManyByRoomIds: async () => [
        { roomId: "grp_1", name: "Group One", avatar: "" },
      ],
    } as never,
    { findSearchScope: async () => scopes.groupMembers ?? [] } as never,
    {
      findManyByIds: async () => [
        { id: "507f1f77bcf86cd799439011", name: "Community One", logo: "" },
      ],
    } as never,
    { findSearchScope: async () => scopes.communityMembers ?? [] } as never,
    {
      getUserSnapshotsMap: async () =>
        new Map([
          [PEER, { userId: PEER, fullName: "Peer Person", avatar: "" }],
        ]),
    } as never,
    {} as never
  );

  return { service, searchPrivate, searchGroup, searchCommunity };
}

const search = (service: MessageSearchService, limit = 20) =>
  service.search({ userId: ME, query: "hello", limit });

describe("MessageSearchService", () => {
  it("merges the three collections into one newest-first page", async () => {
    const { service } = build({
      privateRooms: [{ roomId: "prv_1", participants: [ME, PEER] }],
      groupMembers: [
        { roomId: "grp_1", clearedAt: null, clearChatAt: null, joinedAt: null },
      ],
      communityMembers: [
        { roomId: "507f1f77bcf86cd799439011", status: "active", bannedAt: null },
      ],
      privateHits: [privateMsg("p1", "prv_1", "2026-01-02T00:00:00Z")],
      groupHits: [groupMsg("g1", "grp_1", "2026-01-03T00:00:00Z")],
      communityHits: [
        communityMsg("c1", "507f1f77bcf86cd799439011", "2026-01-01T00:00:00Z"),
      ],
    });

    const { hits, nextCursor } = await search(service);

    expect(hits.map((h) => h.messageId)).toEqual(["g1", "p1", "c1"]);
    expect(hits.map((h) => h.conversationType)).toEqual([
      "GROUP",
      "PRIVATE",
      "COMMUNITY",
    ]);
    // Whole page fits, so there is nothing to page to.
    expect(nextCursor).toBeNull();
  });

  it("labels each hit with its conversation and the sender's live name", async () => {
    const { service } = build({
      privateRooms: [{ roomId: "prv_1", participants: [ME, PEER] }],
      groupMembers: [
        { roomId: "grp_1", clearedAt: null, clearChatAt: null, joinedAt: null },
      ],
      privateHits: [privateMsg("p1", "prv_1", "2026-01-02T00:00:00Z")],
      groupHits: [groupMsg("g1", "grp_1", "2026-01-01T00:00:00Z")],
    });

    const { hits } = await search(service);

    expect(hits[0]).toMatchObject({
      conversationName: "Peer Person",
      senderName: "Peer Person",
      text: "hello p1",
      roomId: "prv_1",
    });
    // The stored (frozen) sender name loses to the live snapshot.
    expect(hits[1]).toMatchObject({
      conversationName: "Group One",
      senderName: "Peer Person",
    });
  });

  it("hides a private message the caller cleared away", async () => {
    const { service } = build({
      privateRooms: [
        {
          roomId: "prv_1",
          participants: [ME, PEER],
          clearFor: { [ME]: "2026-01-05T00:00:00.000Z" },
        },
      ],
      privateHits: [
        privateMsg("old", "prv_1", "2026-01-01T00:00:00Z"),
        privateMsg("new", "prv_1", "2026-01-09T00:00:00Z"),
      ],
    });

    const { hits } = await search(service);
    expect(hits.map((h) => h.messageId)).toEqual(["new"]);
  });

  it("hides group history from before the caller's own clear cutoff", async () => {
    const { service } = build({
      groupMembers: [
        {
          roomId: "grp_1",
          clearedAt: at("2026-01-05T00:00:00Z"),
          clearChatAt: null,
          joinedAt: null,
        },
      ],
      groupHits: [
        groupMsg("old", "grp_1", "2026-01-01T00:00:00Z"),
        groupMsg("new", "grp_1", "2026-01-09T00:00:00Z"),
      ],
    });

    const { hits } = await search(service);
    expect(hits.map((h) => h.messageId)).toEqual(["new"]);
  });

  it("searches only rooms the caller can still read", async () => {
    const { service, searchPrivate, searchGroup, searchCommunity } = build({
      privateRooms: [{ roomId: "prv_1", participants: [ME, PEER] }],
      groupMembers: [
        { roomId: "grp_1", clearedAt: null, clearChatAt: null, joinedAt: null },
      ],
      communityMembers: [
        { roomId: "507f1f77bcf86cd799439011", status: "active", bannedAt: null },
      ],
    });

    await search(service);

    expect(searchPrivate.mock.calls[0][0].roomIds).toEqual(["prv_1"]);
    expect(searchGroup.mock.calls[0][0].roomIds).toEqual(["grp_1"]);
    expect(searchCommunity.mock.calls[0][0].roomIds).toEqual([
      "507f1f77bcf86cd799439011",
    ]);
  });

  it("stops a banned community member at their ban", async () => {
    const { service } = build({
      communityMembers: [
        {
          roomId: "507f1f77bcf86cd799439011",
          status: "banned",
          bannedAt: at("2026-01-05T00:00:00Z"),
        },
      ],
      communityHits: [
        communityMsg("before", "507f1f77bcf86cd799439011", "2026-01-01T00:00:00Z"),
        communityMsg("after", "507f1f77bcf86cd799439011", "2026-01-09T00:00:00Z"),
      ],
    });

    const { hits } = await search(service);
    expect(hits.map((h) => h.messageId)).toEqual(["before"]);
  });

  it("hides a community message the caller deleted for themselves, and one addressed to someone else", async () => {
    const { service } = build({
      communityMembers: [
        { roomId: "507f1f77bcf86cd799439011", status: "active", bannedAt: null },
      ],
      communityHits: [
        communityMsg("mine", "507f1f77bcf86cd799439011", "2026-01-03T00:00:00Z"),
        communityMsg("deleted", "507f1f77bcf86cd799439011", "2026-01-02T00:00:00Z", {
          deletedBy: [ME],
        }),
        communityMsg("personal", "507f1f77bcf86cd799439011", "2026-01-01T00:00:00Z", {
          visibleToUserId: PEER,
        }),
      ],
    });

    const { hits } = await search(service);
    expect(hits.map((h) => h.messageId)).toEqual(["mine"]);
  });

  it("pages on the last row's keyset once the page is full", async () => {
    const { service } = build({
      privateRooms: [{ roomId: "prv_1", participants: [ME, PEER] }],
      privateHits: [
        privateMsg("p1", "prv_1", "2026-01-03T00:00:00Z"),
        privateMsg("p2", "prv_1", "2026-01-02T00:00:00Z"),
        privateMsg("p3", "prv_1", "2026-01-01T00:00:00Z"),
      ],
    });

    const { hits, hasMore, nextCursor } = await service.search({
      userId: ME,
      query: "hello",
      limit: 2,
    });

    expect(hits.map((h) => h.messageId)).toEqual(["p1", "p2"]);
    expect(hasMore).toBe(true);
    expect(nextCursor).toBe(`${at("2026-01-02T00:00:00Z").getTime()}_p2`);
  });
});
