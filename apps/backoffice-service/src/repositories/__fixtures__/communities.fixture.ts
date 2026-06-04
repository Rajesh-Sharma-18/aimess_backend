/**
 * Phase 1 mock dataset for the Community Management admin API.
 *
 * Deterministic, hardcoded fixtures (no Date.now / no randomness) so the API
 * behaves identically across runs. Each row is a full `CommunityDetail`; the
 * list endpoint projects these down to `CommunityListItem`. In Phase 2 this file
 * is dropped entirely — a gRPC-backed repository reads community/stream/user
 * services instead (the repo singleton is the only swap).
 *
 * This dataset MIRRORS the Community Management table mockup: 20 rows, realistic
 * names, and the first four rows reproduce the design verbatim:
 *   Tech Community / John Doe / PUBLIC / Technology / ACTIVE  / 1250 / 2 of 5
 *   Gaming Hub     / Jane Smith / PRIVATE / Gaming    / CLOSED / 3400 / 5 of 5
 *   Art Studio     / Alice Wonder / PUBLIC / Arts     / ACTIVE  / 582  / 0 of 5
 *   Trail Runners  / Alice Wonder / PRIVATE / Sports   / CLOSED / 250  / 0 of 5
 * The frontend renders status CLOSED as "Closed" and livestreamCount as "x/5".
 */
import type {
  AccountStatus,
  CategoryRef,
  CloseReasonCode,
  CommunityDetail,
  CommunityModerationStatus,
  CommunityType,
} from "../../types/community.types.js";

// --- deterministic helpers (operate on fixed ISO strings — no Date.now) ---
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
const handleOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const CATEGORIES: Record<string, CategoryRef> = {
  Technology: { id: "cat_tech", name: "Technology", slug: "technology" },
  Gaming: { id: "cat_gaming", name: "Gaming", slug: "gaming" },
  Arts: { id: "cat_arts", name: "Arts", slug: "arts" },
  Sports: { id: "cat_sports", name: "Sports", slug: "sports" },
  Music: { id: "cat_music", name: "Music", slug: "music" },
  Education: { id: "cat_education", name: "Education", slug: "education" },
  Food: { id: "cat_food", name: "Food", slug: "food" },
  Travel: { id: "cat_travel", name: "Travel", slug: "travel" },
  Fitness: { id: "cat_fitness", name: "Fitness", slug: "fitness" },
  Finance: { id: "cat_finance", name: "Finance", slug: "finance" },
};

const MODERATORS = [
  { adminId: "adm_1", name: "Sara Admin" },
  { adminId: "adm_2", name: "Leo Mod" },
  { adminId: "adm_3", name: "Priya Sr" },
] as const;

type Seed = {
  name: string;
  ownerName: string;
  ownerUserId: string;
  ownerStatus: AccountStatus;
  type: CommunityType;
  category: keyof typeof CATEGORIES;
  status: CommunityModerationStatus;
  memberCount: number;
  livestreamValue: number;
  createdAt: string;
  /** Close metadata for CLOSED rows (drives moderationHistory + core fields). */
  closeReasonCode?: CloseReasonCode;
  closedAt?: string;
};

// First four rows = the mockup, verbatim. Remaining 16 give a realistic spread
// across categories, both types, both statuses, member counts 12→50000, and
// createdAt dates Jan–May 2026. Alice Wonder owns two communities (admin-name
// search) and Marcus Lee owns two as well.
const SEEDS: Seed[] = [
  {
    name: "Tech Community",
    ownerName: "John Doe",
    ownerUserId: "usr_john",
    ownerStatus: "ACTIVE",
    type: "PUBLIC",
    category: "Technology",
    status: "ACTIVE",
    memberCount: 1250,
    livestreamValue: 2,
    createdAt: "2026-02-02T09:00:00.000Z",
  },
  {
    name: "Gaming Hub",
    ownerName: "Jane Smith",
    ownerUserId: "usr_jane",
    ownerStatus: "SUSPENDED",
    type: "PRIVATE",
    category: "Gaming",
    status: "CLOSED",
    memberCount: 3400,
    livestreamValue: 5,
    createdAt: "2026-02-02T10:00:00.000Z",
    closeReasonCode: "GUIDELINES_VIOLATION",
    closedAt: "2026-03-10T08:30:00.000Z",
  },
  {
    name: "Art Studio",
    ownerName: "Alice Wonder",
    ownerUserId: "usr_alice",
    ownerStatus: "ACTIVE",
    type: "PUBLIC",
    category: "Arts",
    status: "ACTIVE",
    memberCount: 582,
    livestreamValue: 0,
    createdAt: "2026-02-02T11:00:00.000Z",
  },
  {
    name: "Trail Runners",
    ownerName: "Alice Wonder",
    ownerUserId: "usr_alice",
    ownerStatus: "ACTIVE",
    type: "PRIVATE",
    category: "Sports",
    status: "CLOSED",
    memberCount: 250,
    livestreamValue: 0,
    createdAt: "2026-02-02T12:00:00.000Z",
    closeReasonCode: "INACTIVE",
    closedAt: "2026-04-01T14:15:00.000Z",
  },

  {
    name: "Indie Beats",
    ownerName: "Marcus Lee",
    ownerUserId: "usr_marcus",
    ownerStatus: "ACTIVE",
    type: "PUBLIC",
    category: "Music",
    status: "ACTIVE",
    memberCount: 8900,
    livestreamValue: 3,
    createdAt: "2026-01-08T08:30:00.000Z",
  },
  {
    name: "Open Classroom",
    ownerName: "Sofia Rossi",
    ownerUserId: "usr_sofia",
    ownerStatus: "ACTIVE",
    type: "PUBLIC",
    category: "Education",
    status: "ACTIVE",
    memberCount: 15400,
    livestreamValue: 1,
    createdAt: "2026-01-12T11:15:00.000Z",
  },
  {
    name: "Home Cooks United",
    ownerName: "Omar Farouk",
    ownerUserId: "usr_omar",
    ownerStatus: "ACTIVE",
    type: "PRIVATE",
    category: "Food",
    status: "CLOSED",
    memberCount: 4720,
    livestreamValue: 4,
    createdAt: "2026-01-19T16:50:00.000Z",
    closeReasonCode: "SPAM",
    closedAt: "2026-02-25T09:00:00.000Z",
  },
  {
    name: "Wanderlust Club",
    ownerName: "Nadia Khan",
    ownerUserId: "usr_nadia",
    ownerStatus: "ACTIVE",
    type: "PUBLIC",
    category: "Travel",
    status: "ACTIVE",
    memberCount: 27800,
    livestreamValue: 0,
    createdAt: "2026-01-23T07:45:00.000Z",
  },
  {
    name: "Iron & Sweat",
    ownerName: "Liam Walsh",
    ownerUserId: "usr_liam",
    ownerStatus: "ACTIVE",
    type: "PUBLIC",
    category: "Fitness",
    status: "ACTIVE",
    memberCount: 12,
    livestreamValue: 0,
    createdAt: "2026-01-28T13:20:00.000Z",
  },
  {
    name: "Crypto Corner",
    ownerName: "Ethan Cole",
    ownerUserId: "usr_ethan",
    ownerStatus: "BANNED",
    type: "PRIVATE",
    category: "Finance",
    status: "CLOSED",
    memberCount: 6300,
    livestreamValue: 5,
    createdAt: "2026-02-09T10:05:00.000Z",
    closeReasonCode: "ILLEGAL_CONTENT",
    closedAt: "2026-03-02T12:40:00.000Z",
  },

  {
    name: "DevOps Guild",
    ownerName: "Marcus Lee",
    ownerUserId: "usr_marcus",
    ownerStatus: "ACTIVE",
    type: "PRIVATE",
    category: "Technology",
    status: "ACTIVE",
    memberCount: 3120,
    livestreamValue: 1,
    createdAt: "2026-02-14T09:30:00.000Z",
  },
  {
    name: "Speedrun Arena",
    ownerName: "Mia Carter",
    ownerUserId: "usr_mia",
    ownerStatus: "ACTIVE",
    type: "PUBLIC",
    category: "Gaming",
    status: "ACTIVE",
    memberCount: 50000,
    livestreamValue: 4,
    createdAt: "2026-02-20T15:00:00.000Z",
  },
  {
    name: "Watercolor Society",
    ownerName: "Ava Reed",
    ownerUserId: "usr_ava",
    ownerStatus: "ACTIVE",
    type: "PUBLIC",
    category: "Arts",
    status: "CLOSED",
    memberCount: 940,
    livestreamValue: 0,
    createdAt: "2026-02-26T11:25:00.000Z",
    closeReasonCode: "ADMIN_ACTION",
    closedAt: "2026-04-18T10:10:00.000Z",
  },
  {
    name: "Marathon Prep",
    ownerName: "Noah Webb",
    ownerUserId: "usr_noah",
    ownerStatus: "ACTIVE",
    type: "PRIVATE",
    category: "Sports",
    status: "ACTIVE",
    memberCount: 1780,
    livestreamValue: 0,
    createdAt: "2026-03-03T08:00:00.000Z",
  },
  {
    name: "Synth Lab",
    ownerName: "Lily Brooks",
    ownerUserId: "usr_lily",
    ownerStatus: "ACTIVE",
    type: "PUBLIC",
    category: "Music",
    status: "ACTIVE",
    memberCount: 2210,
    livestreamValue: 2,
    createdAt: "2026-03-11T14:45:00.000Z",
  },
  {
    name: "Study Hall",
    ownerName: "Eliseo Pham",
    ownerUserId: "usr_eliseo",
    ownerStatus: "ACTIVE",
    type: "PRIVATE",
    category: "Education",
    status: "CLOSED",
    memberCount: 660,
    livestreamValue: 0,
    createdAt: "2026-03-19T09:50:00.000Z",
    closeReasonCode: "GUIDELINES_VIOLATION",
    closedAt: "2026-05-01T16:00:00.000Z",
  },
  {
    name: "Street Food Finds",
    ownerName: "Clay Little",
    ownerUserId: "usr_clay",
    ownerStatus: "ACTIVE",
    type: "PUBLIC",
    category: "Food",
    status: "ACTIVE",
    memberCount: 33100,
    livestreamValue: 1,
    createdAt: "2026-03-27T12:30:00.000Z",
  },
  {
    name: "Backpackers Hub",
    ownerName: "Elora Pruitt",
    ownerUserId: "usr_elora",
    ownerStatus: "ACTIVE",
    type: "PUBLIC",
    category: "Travel",
    status: "ACTIVE",
    memberCount: 4050,
    livestreamValue: 0,
    createdAt: "2026-04-05T07:10:00.000Z",
  },
  {
    name: "FIRE Movement",
    ownerName: "Siena Weiss",
    ownerUserId: "usr_siena",
    ownerStatus: "ACTIVE",
    type: "PRIVATE",
    category: "Finance",
    status: "CLOSED",
    memberCount: 9870,
    livestreamValue: 0,
    createdAt: "2026-04-22T10:40:00.000Z",
    closeReasonCode: "SPAM",
    closedAt: "2026-05-15T11:20:00.000Z",
  },
  {
    name: "Yoga Flow",
    ownerName: "Mia Carter",
    ownerUserId: "usr_mia",
    ownerStatus: "ACTIVE",
    type: "PUBLIC",
    category: "Fitness",
    status: "ACTIVE",
    memberCount: 18600,
    livestreamValue: 5,
    createdAt: "2026-05-09T13:55:00.000Z",
  },
];

const CLOSE_REASON_LABEL: Record<CloseReasonCode, string> = {
  GUIDELINES_VIOLATION: "Repeated community guideline violations",
  SPAM: "Persistent spam / promotional abuse",
  ILLEGAL_CONTENT: "Sharing illegal content",
  INACTIVE: "Community inactive for an extended period",
  ADMIN_ACTION: "Administrative action",
};

/** Pad to `comm_001` … `comm_020` for stable, sortable ids. */
const idOf = (n: number): string => `comm_${String(n).padStart(3, "0")}`;

/** Derive plausible-but-deterministic member breakdowns from the total. */
function memberStats(total: number): CommunityDetail["memberStats"] {
  const active = Math.max(0, total - Math.floor(total * 0.05));
  const pending = Math.floor(total * 0.02);
  const banned = total - active - pending >= 0 ? Math.floor(total * 0.01) : 0;
  const moderators = total > 1000 ? 5 : total > 100 ? 2 : 1;
  const joinedLast7d = Math.floor(total * 0.03);
  return { total, active, pending, banned, moderators, joinedLast7d };
}

function buildRow(seed: Seed, index: number): CommunityDetail {
  const communityId = idOf(index + 1);
  const category = CATEGORIES[seed.category];
  const username = seed.ownerName.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const isClosed = seed.status === "CLOSED";
  // CLOSED rows carry a populated moderation history; ACTIVE rows are empty.
  const moderationHistory: CommunityDetail["moderationHistory"] =
    isClosed && seed.closeReasonCode && seed.closedAt
      ? [
          {
            id: `mh_${communityId}_1`,
            type: "suspend_community",
            reason: CLOSE_REASON_LABEL[seed.closeReasonCode],
            actor: {
              adminId: MODERATORS[index % MODERATORS.length].adminId,
              name: MODERATORS[index % MODERATORS.length].name,
            },
            createdAt: seed.closedAt,
            metadata: { reasonCode: seed.closeReasonCode },
          },
        ]
      : [];

  return {
    community: {
      communityId,
      name: seed.name,
      handle: handleOf(seed.name),
      description: `${seed.name} — a ${seed.type === "PUBLIC" ? "public" : "private"} ${category.name} community.`,
      type: seed.type,
      category,
      status: seed.status,
      avatarUrl: `community/avatar/${seed.ownerUserId}/${slug(seed.name)}.png`,
      coverUrl: null,
      createdAt: seed.createdAt,
      // Deterministic "last activity" 2 days after creation.
      lastActivityAt: new Date(
        new Date(seed.createdAt).getTime() + 2 * 86_400_000
      ).toISOString(),
    },
    owner: {
      userId: seed.ownerUserId,
      displayName: seed.ownerName,
      username,
      avatarUrl: `user/avatar/${seed.ownerUserId}.png`,
      email: `${username}@example.com`,
      accountStatus: seed.ownerStatus,
    },
    memberStats: memberStats(seed.memberCount),
    livestreamStats: {
      total: seed.livestreamValue + 2,
      live: seed.livestreamValue,
      scheduled: 1,
      maxConcurrent: 5,
      stale: true,
    },
    moderationHistory,
    settingsSummary: {
      joinPolicy: seed.type === "PUBLIC" ? "OPEN" : "REQUEST_TO_JOIN",
      type: seed.type,
      memberCount: seed.memberCount,
      inviteLinksActive: seed.type === "PRIVATE" ? 1 : 0,
      openReports: isClosed ? 2 : 0,
      createdAt: seed.createdAt,
    },
    partial: false,
  };
}

export const communityFixtures: CommunityDetail[] = SEEDS.map(buildRow);
