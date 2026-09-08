import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler, validateQuery } from "@aimess/utils";
import { logger } from "@aimess/logger";
import {
  BadRequestError,
  ForbiddenError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "@aimess/errors";

import { env } from "../../config/env.js";

// GET /api/v1/search?q=&filter=all|message|community|people|group&cursor=&limit=
// `filter` selects which downstream legs run, so a single-category tab costs one
// downstream call; `all` fans out to three in parallel with the caller's own
// bearer token, so every downstream permission gate still applies. Rows are
// passed through verbatim — this route adds a fan-out and a cursor, not a new
// row contract. Each leg owns its opaque cursor codec; `all` wraps all three.
//
// `people` and `group` are two FILTERS over ONE leg: user-service's response
// already carries both kinds in its `chat`/`other` arrays, discriminated by
// `type`, so partitioning them here costs nothing. They are not two legs, and
// asking for groups must never become a second downstream call.

const SCAN_TIMEOUT_MS = 5000;

type Leg = "message" | "community" | "people";

const ALL_LEGS: Leg[] = ["message", "community", "people"];

type Filter = Leg | "group";

// Which leg serves a single-category tab, and which row type it keeps.
const FILTER_LEG: Record<Filter, Leg> = {
  message: "message",
  community: "community",
  people: "people",
  group: "people",
};

// Composite-cursor key per leg. Absent = not started, null = exhausted, string = resume.
const LEG_KEY: Record<Leg, "m" | "c" | "p"> = {
  message: "m",
  community: "c",
  people: "p",
};

// Max ObjectId — puts community-service on its `id desc` keyset from row one.
// Its offset path always answers `pagination.nextCursor: null`, so a cursor-less
// first page would strand the community leg after page 1.
const COMMUNITY_CURSOR_START = "ffffffffffffffffffffffff";

const CODE_LIKE = /^[A-Z][A-Z0-9_]*$/;

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  filter: z
    .enum(["all", "message", "community", "people", "group"])
    .default("all"),
  // Opaque: EITHER one leg's own cursor (single-filter, forwarded untouched) or
  // the composite `all` token below. 2048 caps the composite, which carries three.
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

type SearchQuery = z.infer<typeof searchQuerySchema>;

type LegCursors = Partial<Record<Leg, string | null>>;

type SearchItem =
  | { type: "message"; id: string; message: Record<string, unknown> }
  | { type: "community"; id: string; community: Record<string, unknown> }
  | {
      type: "person";
      id: string;
      bucket: "chat" | "other";
      person: Record<string, unknown>;
    }
  | {
      type: "group";
      id: string;
      bucket: "chat" | "other";
      group: Record<string, unknown>;
    };

// The row type each single-category filter keeps out of its leg's page.
const FILTER_ITEM_TYPE: Record<Filter, SearchItem["type"]> = {
  message: "message",
  community: "community",
  people: "person",
  group: "group",
};

interface LegPage {
  rows: SearchItem[];
  // null = exhausted, string = resume from, undefined = this leg never answered.
  cursor: string | null | undefined;
}

type Fetched =
  | { ok: true; data: unknown }
  | { ok: false; status: number | null; code: string | null };

const encodeAllCursor = (legs: {
  v: 1;
  m: string | null | undefined;
  c: string | null | undefined;
  p: string | null | undefined;
}): string => Buffer.from(JSON.stringify(legs), "utf8").toString("base64url");

// A cursor this route cannot read is a 400, never a silent page 1 — the silent
// restart is what makes infinite scroll re-serve the first page forever.
function decodeAllCursor(raw: string): LegCursors {
  let parsed: unknown;
  try {
    // `Buffer.from(…, "base64url")` never throws; garbage bytes fail here instead.
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new BadRequestError("INVALID_CURSOR");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new BadRequestError("INVALID_CURSOR");
  }

  const wrapper = parsed as Record<string, unknown>;
  if (wrapper.v !== 1) throw new BadRequestError("INVALID_CURSOR");

  const cursors: LegCursors = {};
  for (const leg of ALL_LEGS) {
    const value = wrapper[LEG_KEY[leg]];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string") {
      throw new BadRequestError("INVALID_CURSOR");
    }
    cursors[leg] = value;
  }
  return cursors;
}

const trimBase = (url: string): string => url.replace(/\/+$/, "");

// null when that leg's service is not configured.
function legUrl(
  leg: Leg,
  q: string,
  limit: number,
  cursor: string | undefined
): string | null {
  const encoded = encodeURIComponent(q);
  const page = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";

  switch (leg) {
    case "message":
      return env.CHAT_SERVICE_URL
        ? `${trimBase(env.CHAT_SERVICE_URL)}/api/chat/messages/search?q=${encoded}&limit=${limit}${page}`
        : null;
    case "community":
      return env.COMMUNITY_SERVICE_URL
        ? `${trimBase(env.COMMUNITY_SERVICE_URL)}/api/v1/communities/mine?q=${encoded}&filter=all&limit=${limit}${page}`
        : null;
    case "people":
      return env.USER_SERVICE_URL
        ? `${trimBase(env.USER_SERVICE_URL)}/api/v1/users/search?q=${encoded}&limit=${limit}${page}`
        : null;
  }
}

async function fetchJson(url: string, req: Request): Promise<Fetched> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        authorization: String(req.headers.authorization),
        accept: "application/json",
        // Without this every localized downstream string came back in the
        // default locale, unlike the alias routers in this directory.
        ...(typeof req.headers["x-lang"] === "string"
          ? { "x-lang": req.headers["x-lang"] }
          : {}),
      },
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as {
      data?: unknown;
      code?: unknown;
    } | null;
    if (!res.ok) {
      const code = typeof body?.code === "string" ? body.code : null;
      // Logged, not swallowed: a non-ok leg becomes an empty category or a 503,
      // and without this line there is nothing anywhere saying which downstream
      // refused or why — the failure is indistinguishable from "no matches".
      logger.warn(
        `[search] downstream ${res.status}${code ? ` ${code}` : ""} for ${url}`
      );
      return { ok: false, status: res.status, code };
    }
    return { ok: true, data: body?.data ?? null };
  } catch (err) {
    logger.warn(`[search] downstream fetch failed for ${url}: ${String(err)}`);
    return { ok: false, status: null, code: null };
  } finally {
    clearTimeout(timeout);
  }
}

const asRows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (row): row is Record<string, unknown> =>
          typeof row === "object" && row !== null
      )
    : [];

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

const cursorOf = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const EMPTY_PAGE: LegPage = { rows: [], cursor: undefined };

// chat-service leg: { data, hasMore, nextCursor }.
function messagePage(fetched: Fetched | undefined): LegPage {
  if (!fetched?.ok) return EMPTY_PAGE;
  const body = fetched.data as { data?: unknown; nextCursor?: unknown } | null;
  return {
    rows: asRows(body?.data).map((row) => ({
      type: "message",
      id: str(row.messageId),
      message: row,
    })),
    cursor: cursorOf(body?.nextCursor),
  };
}

// community-service leg: { pagination, data } — the continuation signals live
// INSIDE pagination, and no list response of its has ever had an `items` key.
function communityPage(fetched: Fetched | undefined): LegPage {
  if (!fetched?.ok) return EMPTY_PAGE;
  const body = fetched.data as {
    data?: unknown;
    pagination?: { nextCursor?: unknown } | null;
  } | null;
  return {
    rows: asRows(body?.data).map((row) => ({
      type: "community",
      id: str(row.id),
      community: row,
    })),
    cursor: cursorOf(body?.pagination?.nextCursor),
  };
}

// user-service leg: { chat?, other, hasMore, nextCursor }. `chat` is a bounded
// head with no cursor of its own, served on the first page only, so it rides on
// top of the quota rather than being sliced — no later page can return it again.
//
// Both arrays mix USER and GROUP rows, discriminated by the row's own `type`.
// They are split here into two ROW types rather than all being stamped
// `type: "person"` — a group stamped as a person is a row no client can render
// as either: the people list drops it for not being a user, and the group list
// never sees it. `id` is likewise read from the field that row kind actually
// has, not from a userId-or-roomId fallback that hides which one answered.
function peoplePage(fetched: Fetched | undefined): LegPage {
  if (!fetched?.ok) return EMPTY_PAGE;
  const body = fetched.data as {
    chat?: unknown;
    other?: unknown;
    nextCursor?: unknown;
  } | null;
  const toItem =
    (bucket: "chat" | "other") =>
    (row: Record<string, unknown>): SearchItem =>
      row.type === "GROUP"
        ? { type: "group", id: str(row.roomId), bucket, group: row }
        : { type: "person", id: str(row.userId), bucket, person: row };

  // People before groups, so the two categories arrive contiguous rather than
  // interleaved by whichever bucket they happened to sit in upstream.
  const rows = [
    ...asRows(body?.chat).map(toItem("chat")),
    ...asRows(body?.other).map(toItem("other")),
  ];
  return {
    rows: [
      ...rows.filter((row) => row.type === "person"),
      ...rows.filter((row) => row.type === "group"),
    ],
    cursor: cursorOf(body?.nextCursor),
  };
}

export const searchRouter: IRouter = Router();

searchRouter.get(
  "/",
  validateQuery(searchQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.headers.authorization) throw new UnauthorizedError("UNAUTHORIZED");

    const { q, filter, cursor, limit } = req.query as unknown as SearchQuery;
    const legs: Leg[] =
      filter === "all" ? ALL_LEGS : [FILTER_LEG[filter as Filter]];

    // No category may consume the page: each leg's downstream `limit` IS its
    // quota, so one busy category cannot starve the other two.
    const quota: Record<Leg, number> =
      filter === "all"
        ? {
            message: Math.max(Math.ceil(limit / 2), 1),
            community: Math.max(Math.ceil(limit / 4), 1),
            people: Math.max(Math.floor(limit / 4), 1),
          }
        : { message: limit, community: limit, people: limit };

    const incoming: LegCursors =
      cursor == null
        ? {}
        : filter === "all"
          ? decodeAllCursor(cursor)
          : ({ [FILTER_LEG[filter as Filter]]: cursor } as LegCursors);

    const targets: { leg: Leg; url: string }[] = [];
    // What each leg was actually SENT — the community sentinel means a leg can
    // carry a cursor the caller never supplied.
    const sentCursor = new Map<Leg, string>();
    for (const leg of legs) {
      // null = that leg is exhausted; calling it again would re-serve its last page.
      if (incoming[leg] === null) continue;
      const legCursor =
        incoming[leg] ??
        (leg === "community" ? COMMUNITY_CURSOR_START : undefined);
      const url = legUrl(leg, q, quota[leg], legCursor);
      if (!url) continue;
      targets.push({ leg, url });
      if (legCursor) sentCursor.set(leg, legCursor);
    }

    // Zero downstream calls means zero token checks — a downstream 401 is the
    // only authentication this route has — and the route itself never emits an
    // all-exhausted composite, so one that arrives here was hand-made.
    if (targets.length === 0) {
      throw cursor == null
        ? new ServiceUnavailableError("SEARCH_UNAVAILABLE")
        : new BadRequestError("INVALID_CURSOR");
    }

    const fetched = new Map<Leg, Fetched>(
      await Promise.all(
        targets.map(
          async (target) =>
            [target.leg, await fetchJson(target.url, req)] as const
        )
      )
    );

    for (const [leg, result] of fetched) {
      if (result.ok) continue;
      // A rejected token is the one failure the caller must see rather than read
      // as "nothing matched" — every downstream shares it, so one 401 is decisive.
      if (result.status === 401) throw new UnauthorizedError("UNAUTHORIZED");
      // A 403 is a real answer, not a bad token: ACCOUNT_BANNED collapsed into a
      // 401 sent a banned user through the generic sign-out with no ban message.
      if (result.status === 403) {
        throw new ForbiddenError(
          result.code && CODE_LIKE.test(result.code) ? result.code : "FORBIDDEN"
        );
      }
      // A cursor we forwarded that its own leg refuses is a malformed cursor, not
      // an empty category — emptying it silently is how a scroll dies mid-list.
      if (result.status === 400 && sentCursor.has(leg)) {
        throw new BadRequestError("INVALID_CURSOR");
      }
      // Any other 4xx means the leg REFUSED the request this route built — a
      // contract mismatch, not an outage. It used to fall through to the 503
      // below, which is declared retryable, so the client replayed a request
      // that could never succeed: one bad `limit` became a burst. Surfaced with
      // the leg's own code so the cause is in the response, not just the log.
      if (
        result.status !== null &&
        result.status >= 400 &&
        result.status < 500
      ) {
        logger.error(
          `[search] leg "${leg}" rejected the request: ${result.status}${result.code ? ` ${result.code}` : ""}`
        );
        throw new BadRequestError(
          result.code && CODE_LIKE.test(result.code)
            ? result.code
            : "SEARCH_REQUEST_REJECTED"
        );
      }
    }

    const answered = [...fetched.values()];
    if (answered.length > 0 && answered.every((result) => !result.ok)) {
      throw new ServiceUnavailableError("SEARCH_UNAVAILABLE");
    }

    const pages: Record<Leg, LegPage> = {
      message: messagePage(fetched.get("message")),
      community: communityPage(fetched.get("community")),
      people: peoplePage(fetched.get("people")),
    };
    const outCursor = (leg: Leg): string | null | undefined => {
      if (incoming[leg] === null) return null;
      const result = fetched.get(leg);
      // A leg we called that answered nothing holds the position it was called
      // with: dropping its key reads as "not started" next page and re-serves
      // rows already on screen.
      if (result && !result.ok) return incoming[leg];
      return pages[leg].cursor;
    };

    let nextCursor: string | null;
    if (filter === "all") {
      const composite = {
        v: 1 as const,
        m: outCursor("message"),
        c: outCursor("community"),
        p: outCursor("people"),
      };
      // Only a leg that still holds a cursor extends paging — a failed leg keeps
      // its own, so a blip retries that page instead of truncating the category.
      // A leg that goes on failing alone is the 503 above, not an endless scroll.
      const more = [composite.m, composite.c, composite.p].some(
        (value) => typeof value === "string"
      );
      nextCursor = more ? encodeAllCursor(composite) : null;
    } else if (filter === "group") {
      // One page, always. The people leg's cursor walks PEOPLE — groups are a
      // bounded head that user-service drops on every continuation page — so a
      // paged group tab would fetch people forever and render nothing.
      nextCursor = null;
    } else {
      nextCursor = pages[FILTER_LEG[filter as Filter]].cursor ?? null;
    }
    const hasMore = nextCursor !== null;

    // Fixed section order, never a gateway-memory sort: there is no relevance
    // score anywhere on this platform (the message search is $regex, and the
    // projected searchScore it replaced is always 0), so any re-ordering here
    // would be an invented ranking rather than a better one.
    const rows: SearchItem[] = [
      ...pages.message.rows,
      ...pages.community.rows,
      ...pages.people.rows,
    ];
    // `people` and `group` share the people leg, so a single-category tab has to
    // drop the other kind here — without this, the People tab returns groups and
    // the Group tab returns people.
    const data: SearchItem[] =
      filter === "all"
        ? rows
        : rows.filter((row) => row.type === FILTER_ITEM_TYPE[filter as Filter]);

    return res.status(HTTP_STATUS.OK).json(
      new ApiResponse(
        {
          pagination: {
            // Page length, not a corpus total: no leg reports one across three
            // services. Never derive a page count from it — page on nextCursor.
            totalData: data.length,
            totalPage: 1,
            currentPage: 1,
            limit,
            nextCursor,
            hasMore,
          },
          data,
          hasMore,
          nextCursor,
        },
        t("SEARCH_FETCHED", req.locale)
      )
    );
  })
);
