import type {
  PrismaClient,
  Prisma,
  GeneralRoomMessage,
  GroupMessage,
  PrivateMessage,
} from "../generated/prisma/index.js";

import {
  buildTextSearchPipeline,
  orderByIds,
  parseSearchCursor,
  readTextSearchPage,
} from "./message-search.js";

/**
 * Cross-conversation message-body search — the "Messages" half of global search.
 *
 * Deliberately a separate repository rather than three widened `searchByText`
 * methods: the per-room ones stay untouched (they are what the in-chat search
 * uses, and their single-room permission model is already correct), while this
 * one asks each collection ONE question over every room the caller can read.
 *
 * The three collections share the pipeline builder's `(createdAt desc, _id desc)`
 * ordering and its keyset filter, so a single cursor pages the merged list. Two
 * messages in DIFFERENT collections sharing one millisecond can straddle a page
 * boundary; the ids differ, so at worst one row repeats — the caller de-dupes.
 *
 * Room-scoped visibility (per-room clear/delete cutoffs, community ban cutoffs
 * and personal-message rules) is NOT expressible in one `$in` match, so it is
 * applied by the service on the returned rows. Everything cheap enough to push
 * into Mongo is pushed; the rest is a filter over one page.
 */
export class MessageSearchRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async searchPrivate(params: {
    roomIds: string[];
    userId: string;
    query: string;
    cursor?: string | null;
    limit: number;
  }): Promise<{
    messages: PrivateMessage[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    if (!params.roomIds.length)
      return { messages: [], hasMore: false, nextCursor: null };
    const pipeline = buildTextSearchPipeline({
      match: {
        roomId: { $in: params.roomIds },
        isDeleted: false,
        [`deletedFor.${params.userId}`]: { $exists: false },
        // System lines are room events, not things anyone searches for. Matches
        // a missing field too, so pre-existing rows are unaffected.
        systemEvent: null,
      },
      field: "content.text",
      query: params.query,
      cursor: parseSearchCursor(params.cursor),
      limit: params.limit,
    });
    const raw = (await this.prisma.privateMessage.aggregateRaw({
      pipeline: pipeline as unknown as Prisma.InputJsonValue[],
    })) as unknown as Parameters<typeof readTextSearchPage>[0];
    const page = readTextSearchPage(raw ?? [], params.limit);
    if (!page.ids.length)
      return { messages: [], hasMore: page.hasMore, nextCursor: page.nextCursor };
    const rows = await this.prisma.privateMessage.findMany({
      where: { id: { in: page.ids } },
    });
    return {
      messages: orderByIds(rows, page.ids),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  }

  async searchGroup(params: {
    roomIds: string[];
    userId: string;
    query: string;
    cursor?: string | null;
    limit: number;
  }): Promise<{
    messages: GroupMessage[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    if (!params.roomIds.length)
      return { messages: [], hasMore: false, nextCursor: null };
    const pipeline = buildTextSearchPipeline({
      match: {
        roomId: { $in: params.roomIds },
        isDeleted: false,
        deletedForUserIds: { $ne: params.userId },
        systemEvent: null,
      },
      field: "content.text",
      query: params.query,
      cursor: parseSearchCursor(params.cursor),
      limit: params.limit,
    });
    const raw = (await this.prisma.groupMessage.aggregateRaw({
      pipeline: pipeline as unknown as Prisma.InputJsonValue[],
    })) as unknown as Parameters<typeof readTextSearchPage>[0];
    const page = readTextSearchPage(raw ?? [], params.limit);
    if (!page.ids.length)
      return { messages: [], hasMore: page.hasMore, nextCursor: page.nextCursor };
    const rows = await this.prisma.groupMessage.findMany({
      where: { id: { in: page.ids } },
    });
    return {
      messages: orderByIds(rows, page.ids),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  }

  async searchCommunity(params: {
    roomIds: string[];
    query: string;
    cursor?: string | null;
    limit: number;
  }): Promise<{
    messages: GeneralRoomMessage[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    if (!params.roomIds.length)
      return { messages: [], hasMore: false, nextCursor: null };
    const pipeline = buildTextSearchPipeline({
      match: {
        // `roomId` is an ObjectId column here (unlike private/group, which store
        // a plain string), so a bare string never matches under aggregateRaw.
        roomId: { $in: params.roomIds.map((id) => ({ $oid: id })) },
        deletedForAll: false,
        systemMessageType: null,
      },
      field: "message",
      query: params.query,
      cursor: parseSearchCursor(params.cursor),
      limit: params.limit,
    });
    const raw = (await this.prisma.generalRoomMessage.aggregateRaw({
      pipeline: pipeline as unknown as Prisma.InputJsonValue[],
    })) as unknown as Parameters<typeof readTextSearchPage>[0];
    const page = readTextSearchPage(raw ?? [], params.limit);
    if (!page.ids.length)
      return { messages: [], hasMore: page.hasMore, nextCursor: page.nextCursor };
    const rows = await this.prisma.generalRoomMessage.findMany({
      where: { id: { in: page.ids } },
    });
    return {
      messages: orderByIds(rows, page.ids),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  }
}
