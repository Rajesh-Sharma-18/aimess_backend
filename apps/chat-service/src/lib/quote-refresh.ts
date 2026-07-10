/**
 * Fan out a parent message's edit/delete to every OTHER message's stored
 * `quoteData` snapshot that replies to it (`quoteData` is a denormalized
 * copy taken at reply-send time — see `buildReplyQuoteSnapshot`). Without
 * this, a reply preview shows stale pre-edit text forever, or never flips to
 * "Message deleted" after its parent is removed.
 *
 * Mongo can't partially update a Json field via the typed Prisma client, so
 * this mirrors the existing raw dot-notation `$runCommandRaw` update pattern
 * (see `general-room-message.repository.ts#deleteForUser`) — one indexed
 * `updateMany`-style command (`[roomId, parentMessageId, createdAt]` is
 * already indexed on all three message models), not a read-modify-write loop.
 */

export interface QuoteRefreshPatch {
  preview?: string;
  isDeleted?: boolean;
}

export interface RawCommandPrisma {
  $runCommandRaw(command: Record<string, unknown>): Promise<unknown>;
}

export async function refreshQuoteDataForParent(
  prisma: RawCommandPrisma,
  collection: string,
  parentMessageId: string,
  patch: QuoteRefreshPatch
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (patch.preview !== undefined) set["quoteData.preview"] = patch.preview;
  if (patch.isDeleted !== undefined)
    set["quoteData.isDeleted"] = patch.isDeleted;
  if (Object.keys(set).length === 0) return;

  await prisma.$runCommandRaw({
    update: collection,
    updates: [
      {
        q: { parentMessageId },
        u: { $set: set },
        multi: true,
      },
    ],
  });
}
