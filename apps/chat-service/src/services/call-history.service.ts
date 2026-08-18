import {
  callHistoryGroupKey,
  matchesCallHistoryFilter,
  resolveCallDirection,
  resolveCallResult,
  resolveCallTimelineStatus,
  type CallHistoryDirection,
  type CallHistoryFilter,
  type CallHistoryResult,
} from "@aimess/constants";
import { BadRequestError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import type { Call } from "../generated/prisma/index.js";
import type { CallRepository } from "../repositories/call.repository.js";

export interface CallHistoryContact {
  id: string;
  name: string;
  avatarUrl: string;
  isDeleted: boolean;
}

/**
 * Bulk identity lookup for the peers on a page of history. Injected as a
 * function (not the snapshot service + cache repo themselves) so this service
 * stays testable without Redis or gRPC, exactly like `GetCallPrivacyFn` on
 * CallService.
 */
export type ResolveCallContactsFn = (
  userIds: string[]
) => Promise<Map<string, CallHistoryContact>>;

/** One row of the Calls list: a run of consecutive, identical call attempts. */
export interface CallHistoryItem {
  /** Stable list key. Always the LATEST call in the run — see `latestCallId`. */
  id: string;
  /**
   * The newest call in the group. This is the id "Call back" and "open call
   * details" must use: the group's type/result describe THIS call.
   */
  latestCallId: string;
  /** The oldest call in the run — the group's own pagination anchor. */
  oldestCallId: string;
  contact: CallHistoryContact;
  direction: CallHistoryDirection;
  result: CallHistoryResult;
  /** Canonical presentation status (`CallTimelineStatus`), for the row's label. */
  callStatus: string;
  /** "AUDIO" | "VIDEO" — drives both the row icon and the call-back mode. */
  callType: string;
  /** Number of calls collapsed into this row. 1 renders without a count. */
  attemptCount: number;
  /** Epoch ms of the NEWEST call — the timestamp the row displays. */
  lastCallAt: number;
  /** Epoch ms of the OLDEST call in the run. */
  firstCallAt: number;
  /** Talk time of the latest call; 0 unless it was answered. */
  durationSec: number;
  /** The pair's DM room, for opening the conversation from the row. */
  roomId: string | null;
}

export interface CallHistoryPage {
  items: CallHistoryItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface MutableGroup extends CallHistoryItem {
  key: string;
  contactId: string;
  oldestInitiatedAt: Date;
}

/**
 * How many batches one request may scan before it gives up trying to close the
 * trailing group. With `batchSize` below this is >= 3000 rows, i.e. a single
 * uninterrupted run of 3000 identical calls to the same person.
 * ponytail: past that ceiling the run is emitted mid-flight and MAY be split
 * across two pages; raise the budget or key groups on a time bucket if a real
 * account ever reaches it.
 */
const MAX_SCAN_ROUNDS = 10;

/** Drops the grouping bookkeeping that never leaves this service. */
const toItem = (group: MutableGroup): CallHistoryItem => ({
  id: group.id,
  latestCallId: group.latestCallId,
  oldestCallId: group.oldestCallId,
  contact: group.contact,
  direction: group.direction,
  result: group.result,
  callStatus: group.callStatus,
  callType: group.callType,
  attemptCount: group.attemptCount,
  lastCallAt: group.lastCallAt,
  firstCallAt: group.firstCallAt,
  durationSec: group.durationSec,
  roomId: group.roomId,
});

/**
 * WhatsApp-style Call History aggregation.
 *
 * WHY APPLICATION-LEVEL, NOT AN AGGREGATION PIPELINE: the grouping rule is
 * "consecutive runs in the sorted sequence", which `$group` cannot express (it
 * collapses every matching document, including ones separated by other
 * contacts). `$setWindowFields` could, but only over the whole scanned set, and
 * two of the four axes — direction and result — are viewer-relative projections
 * that do not exist as fields on the document. Grouping in the service keeps ONE
 * definition of those axes (`@aimess/constants/chat/call-history`) shared with
 * the client, and the DB still does all the selection work: the query is
 * participant + status filtered, index-ordered and cursor-bounded, so this never
 * loads a user's whole history — it reads batches until it has one page of
 * groups and stops.
 */
export class CallHistoryService {
  constructor(
    private readonly callRepo: Pick<CallRepository, "findHistoryPage">,
    private readonly resolveContacts: ResolveCallContactsFn
  ) {}

  async getHistory(params: {
    userId: string;
    filter: CallHistoryFilter;
    cursor?: string | null;
    limit: number;
  }): Promise<CallHistoryPage> {
    const { userId, filter, limit } = params;
    const before = this.parseCursor(params.cursor);
    // Over-fetch: `limit` GROUPS need at least `limit` rows, and usually more —
    // a run of four attempts is four rows for one row of output.
    const batchSize = Math.min(100, Math.max(limit * 3, 30));

    const groups: MutableGroup[] = [];
    let scanBefore = before;
    let exhausted = false;

    for (let round = 0; round < MAX_SCAN_ROUNDS; round++) {
      const rows = await this.callRepo.findHistoryPage({
        userId,
        filter,
        before: scanBefore,
        take: batchSize,
      });
      if (rows.length < batchSize) exhausted = true;
      if (rows.length === 0) break;
      scanBefore = rows[rows.length - 1]!.initiatedAt;
      for (const row of rows) this.append(groups, row, userId, filter);
      // The trailing group can still grow on the next batch, so it is only
      // "complete" once something differing follows it (or history ran out).
      // Stop as soon as one full page of COMPLETE groups exists.
      if (!exhausted && groups.length > limit) break;
      if (exhausted) break;
    }

    const complete = exhausted ? groups.length : Math.max(0, groups.length - 1);
    let page = groups.slice(0, Math.min(limit, complete));

    if (page.length === 0 && groups.length > 0) {
      // One run longer than the whole scan budget. Emitting it is the only way
      // to make progress; the next page re-anchors after its oldest row.
      logger.warn(
        `CallHistoryService|getHistory|scan budget exhausted inside one group userId=${userId} filter=${filter}`
      );
      page = groups.slice(0, 1);
    }

    const hasMore = groups.length > page.length;
    const last = page[page.length - 1];
    // Exclusive `lt` cursor on the group's OLDEST row, so the next page starts
    // at the first row this page did not consume — a group is never split.
    const nextCursor =
      hasMore && last ? last.oldestInitiatedAt.toISOString() : null;

    await this.attachContacts(page, userId);

    return { items: page.map(toItem), nextCursor, hasMore };
  }

  /**
   * Fold one row into the run at the tail, or start a new run. Rows arrive
   * newest-first, so the FIRST row of a run is its latest call — that is where
   * the group's displayed timestamp, type, result and `latestCallId` come from.
   */
  private append(
    groups: MutableGroup[],
    row: Call,
    userId: string,
    filter: CallHistoryFilter
  ): void {
    const direction = resolveCallDirection(row, userId);
    const callStatus = resolveCallTimelineStatus(row);
    // Viewer-relative: the caller's side of an unanswered call is NO_ANSWER,
    // the callee's is MISSED. Which side hung up first never reaches the row.
    const result = resolveCallResult(callStatus, direction);
    // Backstop only — the query already selects exactly what each tab shows.
    // Kept so the tab's definition lives in ONE place: if the shared rule ever
    // changes, a row the DB let through still cannot land in the wrong tab.
    if (!matchesCallHistoryFilter(filter, direction, result)) return;

    const contactId = direction === "OUTGOING" ? row.calleeId : row.callerId;
    if (!contactId) return;

    const callType =
      String(row.type ?? "").toUpperCase() === "VIDEO" ? "VIDEO" : "AUDIO";
    const key = callHistoryGroupKey({ contactId, direction, callType, result });
    const tail = groups[groups.length - 1];

    if (tail && tail.key === key) {
      tail.attemptCount += 1;
      tail.oldestCallId = row.callId;
      tail.oldestInitiatedAt = row.initiatedAt;
      tail.firstCallAt = row.initiatedAt.getTime();
      return;
    }

    groups.push({
      key,
      contactId,
      id: row.callId,
      latestCallId: row.callId,
      oldestCallId: row.callId,
      contact: { id: contactId, name: "", avatarUrl: "", isDeleted: false },
      direction,
      result,
      callStatus,
      callType,
      attemptCount: 1,
      lastCallAt: row.initiatedAt.getTime(),
      firstCallAt: row.initiatedAt.getTime(),
      durationSec: row.durationSec ?? 0,
      roomId: row.privateRoomId ?? null,
      oldestInitiatedAt: row.initiatedAt,
    });
  }

  /** One bulk identity lookup for the whole page, never one per row. */
  private async attachContacts(
    page: MutableGroup[],
    userId: string
  ): Promise<void> {
    if (page.length === 0) return;
    const ids = [...new Set(page.map((g) => g.contactId))];
    let contacts = new Map<string, CallHistoryContact>();
    try {
      contacts = await this.resolveContacts(ids);
    } catch (error) {
      // A name/avatar outage must not blank the whole call log.
      logger.warn(
        `CallHistoryService|attachContacts|failed userId=${userId} error=${String(error)}`
      );
    }
    for (const group of page) {
      const contact = contacts.get(group.contactId);
      if (contact) group.contact = contact;
      else group.contact = { ...group.contact, id: group.contactId };
    }
  }

  /**
   * Same ISO-`initiatedAt` cursor the raw history feed uses. Rejected loudly
   * when unparseable — `new Date("nonsense")` silently produces a Prisma filter
   * that matches nothing, which reads to the client as "you have no calls".
   */
  private parseCursor(cursor?: string | null): Date | null {
    if (!cursor) return null;
    const date = new Date(cursor);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestError("INVALID_CURSOR");
    }
    return date;
  }
}
