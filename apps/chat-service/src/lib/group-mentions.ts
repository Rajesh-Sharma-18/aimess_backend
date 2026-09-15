/**
 * Group @mention resolution — the server-authoritative half of the mention
 * contract (`content.mentions`, see `MentionDto` in @aimess/shared-types).
 *
 * A client sends entities pointing into `content.text` (UTF-16 offsets, the
 * entity covering the literal "@handle" token). Nothing a client claims is
 * trusted: every entry is re-checked against the text, the room roster and the
 * user's CURRENT handle, and `username` on the stored entity is always the
 * server's value.
 *
 * Invalid entries are DROPPED, never rejected: an outbox replay after a member
 * left, or a rename between compose and send, must still deliver the message.
 * Only the per-message limit throws, and only so a client learns why.
 */
import { BadRequestError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import type { MentionDto } from "@aimess/shared-types";

import type { CacheRepository } from "../repositories/cache.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { UserSnapshotService } from "../services/user-snapshot.service.js";

export const MAX_MENTIONS_PER_MESSAGE = 50;

const HANDLE_RE = /^[A-Za-z0-9_]{1,32}$/;
// "@kristi" glued to a word ("a@kristi", "สวัสดี@kristi") or a URL path
// ("medium.com/@kristi") is not a mention.
const LEFT_WORD_RE = /[\p{L}\p{N}\p{M}_@/]/u;
// "@kristi_new" is a different handle, not "@kristi" followed by text.
const RIGHT_WORD_RE = /[A-Za-z0-9_]/;

export interface GroupMentionDeps {
  memberRepo: Pick<GroupMemberRepository, "findActiveUserIds">;
  userSnapshotService: Pick<UserSnapshotService, "getUserSnapshotsMap">;
  cacheRepo: CacheRepository;
}

/** Entries that are well-formed against `text`, sorted, non-overlapping. */
function structurallyValid(
  raw: unknown[],
  text: string
): Array<{ userId: string; offset: number; length: number; token: string }> {
  const valid: Array<{
    userId: string;
    offset: number;
    length: number;
    token: string;
  }> = [];
  for (const entry of raw) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const { userId, offset, length } = e;
    if (typeof userId !== "string" || !userId || userId.length > 100) continue;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length))
      continue;
    const start = offset as number;
    const end = start + (length as number);
    if (start < 0 || (length as number) < 2 || end > text.length) continue;
    if (text[start] !== "@") continue;
    const token = text.slice(start + 1, end);
    if (!HANDLE_RE.test(token)) continue;
    if (start > 0 && LEFT_WORD_RE.test(text[start - 1]!)) continue;
    if (end < text.length && RIGHT_WORD_RE.test(text[end]!)) continue;
    valid.push({ userId, offset: start, length: end - start, token });
  }
  valid.sort((a, b) => a.offset - b.offset);
  const kept: typeof valid = [];
  let prevEnd = 0;
  for (const v of valid) {
    if (v.offset < prevEnd) continue;
    kept.push(v);
    prevEnd = v.offset + v.length;
  }
  return kept;
}

/**
 * Resolve client-claimed mentions against `text` and the room `roomId`.
 * One roster query + one batched snapshot lookup regardless of entry count.
 * Throws only `CHAT_MENTION_LIMIT_EXCEEDED`; a lookup failure yields `[]`.
 *
 * `previous` (an edit that omitted `mentions`) turns "could not verify" into
 * "keep": a candidate that lines up with a stored entry (same user, same
 * token) survives a failed lookup or a placeholder snapshot, so a transient
 * outage never erases mentions already on the row. Known-inactive, deleted
 * and known handle mismatches still drop.
 */
export async function resolveGroupMentions(
  params: {
    raw: unknown;
    text: string;
    roomId: string;
    previous?: MentionDto[];
  } & GroupMentionDeps
): Promise<MentionDto[]> {
  const { raw, text, roomId } = params;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (raw.length > MAX_MENTIONS_PER_MESSAGE) {
    throw new BadRequestError("CHAT_MENTION_LIMIT_EXCEEDED");
  }
  const candidates = structurallyValid(raw, text);
  if (candidates.length === 0) return [];

  const keepPrevious = (c: (typeof candidates)[number]): MentionDto | null => {
    const p = params.previous?.find(
      (m) =>
        m?.userId === c.userId &&
        typeof m.username === "string" &&
        m.username.toLowerCase() === c.token.toLowerCase()
    );
    return p
      ? {
          userId: c.userId,
          username: p.username,
          offset: c.offset,
          length: c.length,
        }
      : null;
  };

  const ids = [...new Set(candidates.map((c) => c.userId))];
  let activeIds: string[];
  let snapshots: Map<string, Record<string, unknown>>;
  try {
    [activeIds, snapshots] = await Promise.all([
      params.memberRepo.findActiveUserIds(roomId, ids),
      params.userSnapshotService.getUserSnapshotsMap(ids, params.cacheRepo),
    ]);
  } catch (err) {
    // Fail closed for the mentions only — the message itself still sends.
    logger.warn(`resolveGroupMentions|room=${roomId}: ${String(err)}`);
    return candidates.map(keepPrevious).filter((m) => m !== null);
  }
  const active = new Set(activeIds);
  const out: MentionDto[] = [];
  for (const c of candidates) {
    if (!active.has(c.userId)) continue;
    const snapshot = snapshots.get(c.userId);
    if (snapshot?.isDeletedUser === true) continue;
    const handle =
      typeof snapshot?.memberId === "string" ? snapshot.memberId : "";
    if (!handle) {
      // No snapshot / placeholder `memberId: ""` = lookup degraded, not a verdict.
      const kept = keepPrevious(c);
      if (kept) out.push(kept);
      continue;
    }
    if (c.token.toLowerCase() !== handle.toLowerCase()) continue;
    out.push({
      userId: c.userId,
      username: handle,
      offset: c.offset,
      length: c.length,
    });
  }
  return out;
}

/** Distinct mentioned userIds across `contents[*].mentions`, minus `excludeUserId`. */
export function mentionedUserIdsOf(
  contents: unknown[],
  excludeUserId: string
): string[] {
  const ids = new Set<string>();
  for (const content of contents) {
    const mentions = (content as { mentions?: unknown } | null | undefined)
      ?.mentions;
    if (!Array.isArray(mentions)) continue;
    for (const m of mentions) {
      const id = (m as { userId?: unknown } | null)?.userId;
      if (typeof id === "string" && id && id !== excludeUserId) ids.add(id);
    }
  }
  return [...ids];
}
