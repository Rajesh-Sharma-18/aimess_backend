import type { PrismaClient } from "../../src/generated/prisma/client.js";

/**
 * Idempotent seed for the `UserIndex` read-model backing the admin User
 * Management API. ~40 realistic rows spanning every UserStatus and report
 * bucket. Deterministic ids (`u_seed_NN`) so re-running upserts in place rather
 * than duplicating.
 *
 * This is backfill data only — production rows arrive via event consumers
 * (a separate future task). Mirrors the upsert style of the other seeds.
 */
type Status = "ACTIVE" | "SUSPENDED" | "BANNED" | "DELETED";

type SeedUser = {
  userId: string;
  username: string;
  email: string;
  status: Status;
  reportCount: number;
  joinedAt: string;
  lastActiveAt: string | null;
  bannedAt: string | null;
  banReason: string | null;
  suspendedUntil: string | null;
};

const FIRST_NAMES = [
  "alex",
  "sam",
  "jordan",
  "taylor",
  "casey",
  "morgan",
  "riley",
  "jamie",
  "quinn",
  "drew",
  "skyler",
  "parker",
  "reese",
  "rowan",
  "emerson",
  "harper",
  "finley",
  "sage",
  "blake",
  "devon",
];

const REASONS = [
  "SPAM",
  "HARASSMENT",
  "HATE_SPEECH",
  "NUDITY",
  "VIOLENCE",
  "IMPERSONATION",
  "MISINFORMATION",
  "ILLEGAL_CONTENT",
  "OTHER",
];

function id(n: number): string {
  return `u_seed_${String(n).padStart(2, "0")}`;
}

function username(n: number): string {
  return `${FIRST_NAMES[n % FIRST_NAMES.length]}_${String(n).padStart(2, "0")}`;
}

/** Spread joinedAt across 2024-2026. */
function joinedAt(n: number): string {
  const year = 2024 + (n % 3);
  const month = String((n % 12) + 1).padStart(2, "0");
  const day = String((n % 27) + 1).padStart(2, "0");
  return `${String(year)}-${month}-${day}T09:${String(n % 60).padStart(2, "0")}:00.000Z`;
}

function lastActiveAt(n: number): string {
  // Some time after joinedAt, within 2026.
  const month = String((n % 6) + 1).padStart(2, "0");
  const day = String((n % 27) + 1).padStart(2, "0");
  return `2026-${month}-${day}T14:${String(n % 60).padStart(2, "0")}:00.000Z`;
}

function buildUsers(): SeedUser[] {
  const users: SeedUser[] = [];
  let n = 1;

  // --- ACTIVE clean (no reports) — 14 rows ----------------------------------
  for (let i = 0; i < 14; i += 1, n += 1) {
    users.push({
      userId: id(n),
      username: username(n),
      email: `${username(n)}@aimess.app`,
      status: "ACTIVE",
      reportCount: 0,
      joinedAt: joinedAt(n),
      lastActiveAt: lastActiveAt(n),
      bannedAt: null,
      banReason: null,
      suspendedUntil: null,
    });
  }

  // --- ACTIVE lightly reported (reportCount 1-3) — 6 rows -------------------
  for (let i = 0; i < 6; i += 1, n += 1) {
    users.push({
      userId: id(n),
      username: username(n),
      email: `${username(n)}@aimess.app`,
      status: "ACTIVE",
      reportCount: (i % 3) + 1,
      joinedAt: joinedAt(n),
      lastActiveAt: lastActiveAt(n),
      bannedAt: null,
      banReason: null,
      suspendedUntil: null,
    });
  }

  // --- ACTIVE heavily reported (reportCount >= 5) — 5 rows ------------------
  for (let i = 0; i < 5; i += 1, n += 1) {
    users.push({
      userId: id(n),
      username: username(n),
      email: `${username(n)}@aimess.app`,
      status: "ACTIVE",
      reportCount: 5 + i * 2,
      joinedAt: joinedAt(n),
      lastActiveAt: lastActiveAt(n),
      bannedAt: null,
      banReason: null,
      suspendedUntil: null,
    });
  }

  // --- SUSPENDED (suspendedUntil + bannedAt + banReason) — 6 rows ----------
  for (let i = 0; i < 6; i += 1, n += 1) {
    const since = joinedAt(n);
    users.push({
      userId: id(n),
      username: username(n),
      email: `${username(n)}@aimess.app`,
      status: "SUSPENDED",
      reportCount: 3 + i,
      joinedAt: since,
      lastActiveAt: lastActiveAt(n),
      bannedAt: `2026-0${String((i % 6) + 1)}-10T10:00:00.000Z`,
      banReason: REASONS[i % REASONS.length],
      suspendedUntil: `2026-0${String((i % 6) + 1)}-24T10:00:00.000Z`,
    });
  }

  // --- BANNED (permanent, high reportCount) — 5 rows -----------------------
  for (let i = 0; i < 5; i += 1, n += 1) {
    users.push({
      userId: id(n),
      username: username(n),
      email: `${username(n)}@aimess.app`,
      status: "BANNED",
      reportCount: 8 + i * 3,
      joinedAt: joinedAt(n),
      lastActiveAt: lastActiveAt(n),
      bannedAt: `2026-0${String((i % 6) + 1)}-05T08:00:00.000Z`,
      banReason: REASONS[(i + 2) % REASONS.length],
      suspendedUntil: null,
    });
  }

  // --- DELETED (tombstoned email) — 4 rows ---------------------------------
  for (let i = 0; i < 4; i += 1, n += 1) {
    users.push({
      userId: id(n),
      username: `deleted_user_${String(n)}`,
      email: `deleted+${id(n)}@aimess.app`,
      status: "DELETED",
      reportCount: i,
      joinedAt: joinedAt(n),
      lastActiveAt: null,
      bannedAt: null,
      banReason: null,
      suspendedUntil: null,
    });
  }

  return users;
}

export async function seedUserIndex(prisma: PrismaClient): Promise<number> {
  const users = buildUsers();
  for (const u of users) {
    const data = {
      username: u.username,
      email: u.email,
      status: u.status,
      reportCount: u.reportCount,
      joinedAt: new Date(u.joinedAt),
      lastActiveAt: u.lastActiveAt ? new Date(u.lastActiveAt) : null,
      bannedAt: u.bannedAt ? new Date(u.bannedAt) : null,
      banReason: u.banReason,
      suspendedUntil: u.suspendedUntil ? new Date(u.suspendedUntil) : null,
    };
    await prisma.userIndex.upsert({
      where: { userId: u.userId },
      update: data,
      create: { userId: u.userId, ...data },
    });
  }
  return users.length;
}
