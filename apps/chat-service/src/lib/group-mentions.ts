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

/** The literal token of an @all entity ("@all", matched case-insensitively). */
export const MENTION_ALL_TOKEN = "all";

export interface GroupMentionDeps {
  memberRepo: Pick<GroupMemberRepository, "findActiveUserIds">;
  userSnapshotService: Pick<UserSnapshotService, "getUserSnapshotsMap">;
  cacheRepo: CacheRepository;
  /** Platform-banned subset of ids. Absent means no ban check. */
  bannedAmong?: (userIds: string[]) => Promise<Set<string>>;
}

type UserCandidate = {
  type: "USER";
  userId: string;
  offset: number;
  length: number;
  token: string;
};
type Candidate =
  | UserCandidate
  | { type: "ALL"; offset: number; length: number };

/**
 * Entries that are well-formed against `text`, sorted, non-overlapping.
 * `type` absent means USER; ALL carries no identity and must cover "@all";
 * any other `type` is dropped. "@all" is never a USER mention, so ALL wins
 * over a real handle "all".
 */
function structurallyValid(raw: unknown[], text: string): Candidate[] {
  const valid: Candidate[] = [];
  for (const entry of raw) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const { type, userId, offset, length } = e;
    const isAll = type === "ALL";
    if (!isAll && type !== undefined && type !== "USER") continue;
    if (
      !isAll &&
      (typeof userId !== "string" || !userId || userId.length > 100)
    )
      continue;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length))
      continue;
    const start = offset as number;
    const end = start + (length as number);
    if (start < 0 || (length as number) < 2 || end > text.length) continue;
    if (text[start] !== "@") continue;
    const token = text.slice(start + 1, end);
    const isAllToken = token.toLowerCase() === MENTION_ALL_TOKEN;
    if (isAll ? !isAllToken : isAllToken || !HANDLE_RE.test(token)) continue;
    if (start > 0 && LEFT_WORD_RE.test(text[start - 1]!)) continue;
    if (end < text.length && RIGHT_WORD_RE.test(text[end]!)) continue;
    valid.push(
      isAll
        ? { type: "ALL", offset: start, length: end - start }
        : {
            type: "USER",
            userId: userId as string,
            offset: start,
            length: end - start,
            token,
          }
    );
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

  const keepPrevious = (c: UserCandidate): MentionDto | null => {
    const p = params.previous?.find(
      (m) =>
        m?.type !== "ALL" &&
        m?.userId === c.userId &&
        typeof m.username === "string" &&
        m.username.toLowerCase() === c.token.toLowerCase()
    );
    return p && p.type !== "ALL"
      ? {
          type: "USER",
          userId: c.userId,
          username: p.username,
          offset: c.offset,
          length: c.length,
        }
      : null;
  };

  // ALL is purely structural: no lookup, so it survives a lookup outage.
  let resolveUser = keepPrevious;
  const users = candidates.filter((c) => c.type === "USER");
  if (users.length > 0) {
    const ids = [...new Set(users.map((c) => c.userId))];
    try {
      const [activeIds, snapshots, banned] = await Promise.all([
        params.memberRepo.findActiveUserIds(roomId, ids),
        params.userSnapshotService.getUserSnapshotsMap(ids, params.cacheRepo),
        params.bannedAmong?.(ids) ?? new Set<string>(),
      ]);
      const active = new Set(activeIds);
      resolveUser = (c) => {
        // A platform-banned member stays on the roster but is not mentionable.
        if (!active.has(c.userId) || banned.has(c.userId)) return null;
        const snapshot = snapshots.get(c.userId);
        if (snapshot?.isDeletedUser === true) return null;
        const handle =
          typeof snapshot?.memberId === "string" ? snapshot.memberId : "";
        // No snapshot / placeholder `memberId: ""` = lookup degraded, not a verdict.
        if (!handle) return keepPrevious(c);
        if (c.token.toLowerCase() !== handle.toLowerCase()) return null;
        return {
          type: "USER",
          userId: c.userId,
          username: handle,
          offset: c.offset,
          length: c.length,
        };
      };
    } catch (err) {
      // Fail closed for the mentions only — the message itself still sends.
      logger.warn(`resolveGroupMentions|room=${roomId}: ${String(err)}`);
    }
  }
  const out: MentionDto[] = [];
  for (const c of candidates) {
    const m =
      c.type === "ALL"
        ? { type: "ALL" as const, offset: c.offset, length: c.length }
        : resolveUser(c);
    if (m) out.push(m);
  }
  return out;
}

/** True when any `contents[*].mentions` carries an @all entry. */
export function hasMentionAll(contents: unknown[]): boolean {
  return contents.some((content) => {
    const mentions = (content as { mentions?: unknown } | null | undefined)
      ?.mentions;
    return (
      Array.isArray(mentions) &&
      mentions.some((m) => (m as { type?: unknown } | null)?.type === "ALL")
    );
  });
}

const MENTION_ALL_SUPPRESSED = Symbol.for("aimess.chat.mentionAllSuppressed");

/** Tag a sent message whose @all push the @all rate limit skipped. */
export function markMentionAllSuppressed<T extends object>(msg: T): T {
  (msg as Record<symbol, unknown>)[MENTION_ALL_SUPPRESSED] = true;
  return msg;
}

/** True when this send's @all still renders but must notify nobody. */
export function isMentionAllSuppressed(msg: unknown): boolean {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<symbol, unknown>)[MENTION_ALL_SUPPRESSED] === true
  );
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
