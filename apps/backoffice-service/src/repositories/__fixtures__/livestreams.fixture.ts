/**
 * Phase 1 mock dataset for the Livestream Management admin API.
 *
 * Deterministic, hardcoded fixtures (no Date.now / no randomness) so the API
 * behaves identically across runs. Each row is a full `LivestreamDetail`; the
 * list endpoint projects these down to `LivestreamListItem`, and each row embeds
 * its own `reports[]` so the per-stream reports endpoint is self-contained. In
 * Phase 2 this file is dropped entirely — a PrismaLivestreamRepository reads
 * `admin_db` (and OSSRS telemetry) instead.
 *
 * The dataset spreads 19 rows across LIVE / ENDED / CANCELLED, every category,
 * varying viewerCount / reportCount / reportSeverity, and dates Jan–Jun 2026.
 * The first rows are realistic, fully-populated livestreams.
 */
import type {
  AccountStatus,
  EndReasonCode,
  LivestreamCategoryRef,
  LivestreamDetail,
  LivestreamReportItem,
  LivestreamReportStatus,
  LivestreamReportType,
  LivestreamStatus,
  ReportSeverity,
} from "../../types/livestream.types.js";

// --- deterministic time helpers (operate on fixed ISO strings — no Date.now) ---
const MINUTE = 60_000;
const HOUR = 3_600_000;
const shift = (iso: string, ms: number): string =>
  new Date(new Date(iso).getTime() + ms).toISOString();

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

/** Fixed category catalogue (mirrors the community category seed). */
const CATEGORIES: LivestreamCategoryRef[] = [
  { id: "cat_gaming", name: "Gaming", slug: "gaming" },
  { id: "cat_music", name: "Music", slug: "music" },
  { id: "cat_talk", name: "Talk Shows", slug: "talk_shows" },
  { id: "cat_sports", name: "Sports", slug: "sports" },
  { id: "cat_education", name: "Education", slug: "education" },
  { id: "cat_irl", name: "Just Chatting", slug: "just_chatting" },
];

const ADMINS = [
  { id: "adm_1", name: "Sara Admin" },
  { id: "adm_2", name: "Leo Mod" },
  { id: "adm_3", name: "Priya Sr" },
];

const REGIONS = ["us-east-1", "eu-west-1", "ap-south-1"];
const RESOLUTIONS = ["1920x1080", "1280x720", "854x480"];
const REPORT_STATUSES: LivestreamReportStatus[] = [
  "OPEN",
  "REVIEWING",
  "RESOLVED",
  "DISMISSED",
];
const REPORT_TYPES: LivestreamReportType[] = [
  "HARASSMENT",
  "SPAM",
  "COPYRIGHT",
  "NUDITY",
  "VIOLENCE",
  "HATE_SPEECH",
  "OTHER",
];

type Seed = {
  title: string;
  community: string;
  creator: string;
  categoryIdx: number;
  status: LivestreamStatus;
  /** Fixed reference creation time. */
  createdAt: string;
  /** Whole minutes the stream has run (drives durationSeconds + watch time). */
  durationMinutes: number;
  viewerCount: number;
  reportCount: number;
  reportSeverity: ReportSeverity;
  creatorStatus: AccountStatus;
  /** Reason an ENDED/CANCELLED stream was closed by an admin (if any). */
  endReasonCode?: EndReasonCode;
  isRecording?: boolean;
};

// First rows = realistic, fully-populated livestreams. Remaining rows give a
// spread across every status, all categories, and dates Jan–Jun 2026.
const SEEDS: Seed[] = [
  {
    title: "Ranked Grind to Diamond",
    community: "Apex Legends Hub",
    creator: "Nova Strike",
    categoryIdx: 0,
    status: "LIVE",
    createdAt: "2026-06-01T18:00:00Z",
    durationMinutes: 95,
    viewerCount: 4210,
    reportCount: 0,
    reportSeverity: "NONE",
    creatorStatus: "ACTIVE",
    isRecording: true,
  },
  {
    title: "Late Night Lo-Fi Session",
    community: "Chillhop Collective",
    creator: "Mira Solace",
    categoryIdx: 1,
    status: "LIVE",
    createdAt: "2026-06-02T22:15:00Z",
    durationMinutes: 142,
    viewerCount: 1875,
    reportCount: 2,
    reportSeverity: "LOW",
    creatorStatus: "ACTIVE",
    isRecording: true,
  },
  {
    title: "Founders AMA — Building in Public",
    community: "Indie Makers",
    creator: "Dev Okafor",
    categoryIdx: 2,
    status: "LIVE",
    createdAt: "2026-06-03T15:30:00Z",
    durationMinutes: 38,
    viewerCount: 932,
    reportCount: 5,
    reportSeverity: "HIGH",
    creatorStatus: "ACTIVE",
    endReasonCode: undefined,
  },
  {
    title: "Sunday Marathon Watch Party",
    community: "FC United Fans",
    creator: "Theo Marsh",
    categoryIdx: 3,
    status: "ENDED",
    createdAt: "2026-01-12T13:00:00Z",
    durationMinutes: 180,
    viewerCount: 6120,
    reportCount: 1,
    reportSeverity: "LOW",
    creatorStatus: "ACTIVE",
    endReasonCode: "MANUAL_ADMIN",
    isRecording: true,
  },

  {
    title: "Calculus Crash Course",
    community: "STEM Study Hall",
    creator: "Lena Frost",
    categoryIdx: 4,
    status: "ENDED",
    createdAt: "2026-01-20T09:00:00Z",
    durationMinutes: 75,
    viewerCount: 540,
    reportCount: 0,
    reportSeverity: "NONE",
    creatorStatus: "ACTIVE",
    isRecording: true,
  },
  {
    title: "Just Vibing & Q/A",
    community: "Cozy Corner",
    creator: "Remy Vale",
    categoryIdx: 5,
    status: "ENDED",
    createdAt: "2026-01-28T20:30:00Z",
    durationMinutes: 64,
    viewerCount: 2230,
    reportCount: 3,
    reportSeverity: "MEDIUM",
    creatorStatus: "SUSPENDED",
    endReasonCode: "HARASSMENT",
  },
  {
    title: "Speedrun Any% World Record Attempt",
    community: "Retro Runners",
    creator: "Kai Tanaka",
    categoryIdx: 0,
    status: "ENDED",
    createdAt: "2026-02-05T16:45:00Z",
    durationMinutes: 122,
    viewerCount: 8740,
    reportCount: 0,
    reportSeverity: "NONE",
    creatorStatus: "ACTIVE",
    isRecording: true,
  },
  {
    title: "Acoustic Covers Night",
    community: "Open Mic Live",
    creator: "Sasha Bloom",
    categoryIdx: 1,
    status: "ENDED",
    createdAt: "2026-02-14T19:00:00Z",
    durationMinutes: 88,
    viewerCount: 1450,
    reportCount: 4,
    reportSeverity: "HIGH",
    creatorStatus: "BANNED",
    endReasonCode: "COPYRIGHT",
  },
  {
    title: "Debate: Future of Remote Work",
    community: "Tech Talks Daily",
    creator: "Omar Reyes",
    categoryIdx: 2,
    status: "ENDED",
    createdAt: "2026-02-22T17:20:00Z",
    durationMinutes: 56,
    viewerCount: 990,
    reportCount: 1,
    reportSeverity: "LOW",
    creatorStatus: "ACTIVE",
  },
  {
    title: "Championship Finals Reactions",
    community: "Court Side",
    creator: "Bianca Cruz",
    categoryIdx: 3,
    status: "CANCELLED",
    createdAt: "2026-03-01T21:00:00Z",
    durationMinutes: 0,
    viewerCount: 0,
    reportCount: 0,
    reportSeverity: "NONE",
    creatorStatus: "ACTIVE",
  },
  {
    title: "Intro to Machine Learning",
    community: "AI Academy",
    creator: "Ravi Menon",
    categoryIdx: 4,
    status: "ENDED",
    createdAt: "2026-03-09T11:30:00Z",
    durationMinutes: 110,
    viewerCount: 3320,
    reportCount: 2,
    reportSeverity: "MEDIUM",
    creatorStatus: "ACTIVE",
    isRecording: true,
  },
  {
    title: "Morning Coffee & Chat",
    community: "Cozy Corner",
    creator: "Iris Lund",
    categoryIdx: 5,
    status: "ENDED",
    createdAt: "2026-03-18T08:15:00Z",
    durationMinutes: 47,
    viewerCount: 760,
    reportCount: 0,
    reportSeverity: "NONE",
    creatorStatus: "ACTIVE",
  },
  {
    title: "Co-op Horror Night",
    community: "Spooky Squad",
    creator: "Felix Braun",
    categoryIdx: 0,
    status: "ENDED",
    createdAt: "2026-03-27T23:00:00Z",
    durationMinutes: 134,
    viewerCount: 5210,
    reportCount: 6,
    reportSeverity: "HIGH",
    creatorStatus: "SUSPENDED",
    endReasonCode: "VIOLENCE",
    isRecording: true,
  },
  {
    title: "Electronic Set — Friday Drop",
    community: "Bassline",
    creator: "Dana Cruz",
    categoryIdx: 1,
    status: "ENDED",
    createdAt: "2026-04-04T20:00:00Z",
    durationMinutes: 96,
    viewerCount: 4080,
    reportCount: 1,
    reportSeverity: "LOW",
    creatorStatus: "ACTIVE",
    isRecording: true,
  },
  {
    title: "Startup Pitch Practice",
    community: "Indie Makers",
    creator: "Greta Nilsson",
    categoryIdx: 2,
    status: "CANCELLED",
    createdAt: "2026-04-13T14:00:00Z",
    durationMinutes: 0,
    viewerCount: 0,
    reportCount: 2,
    reportSeverity: "LOW",
    creatorStatus: "ACTIVE",
    endReasonCode: "SPAM",
  },
  {
    title: "Live Match Commentary",
    community: "FC United Fans",
    creator: "Pablo Ruiz",
    categoryIdx: 3,
    status: "ENDED",
    createdAt: "2026-04-22T18:30:00Z",
    durationMinutes: 105,
    viewerCount: 7650,
    reportCount: 0,
    reportSeverity: "NONE",
    creatorStatus: "ACTIVE",
    isRecording: true,
  },
  {
    title: "History of Ancient Rome",
    community: "STEM Study Hall",
    creator: "Yuki Tanaka",
    categoryIdx: 4,
    status: "ENDED",
    createdAt: "2026-05-06T10:00:00Z",
    durationMinutes: 82,
    viewerCount: 1190,
    reportCount: 3,
    reportSeverity: "MEDIUM",
    creatorStatus: "ACTIVE",
  },
  {
    title: "Unfiltered Late Show",
    community: "Cozy Corner",
    creator: "Tom Becker",
    categoryIdx: 5,
    status: "ENDED",
    createdAt: "2026-05-19T22:45:00Z",
    durationMinutes: 70,
    viewerCount: 2980,
    reportCount: 7,
    reportSeverity: "HIGH",
    creatorStatus: "BANNED",
    endReasonCode: "NUDITY",
  },
  {
    title: "Indie Game Showcase",
    community: "Retro Runners",
    creator: "Aisha Noor",
    categoryIdx: 0,
    status: "LIVE",
    createdAt: "2026-06-03T12:00:00Z",
    durationMinutes: 22,
    viewerCount: 615,
    reportCount: 1,
    reportSeverity: "LOW",
    creatorStatus: "ACTIVE",
    isRecording: true,
  },
];

/** Build a deterministic embedded report for a stream. */
function buildReport(
  livestreamId: string,
  n: number,
  j: number,
  createdAt: string
): LivestreamReportItem {
  const status = REPORT_STATUSES[(n + j) % REPORT_STATUSES.length]!;
  const reportType = REPORT_TYPES[(n + j) % REPORT_TYPES.length]!;
  const closed = status === "RESOLVED" || status === "DISMISSED";
  const admin = ADMINS[(n + j) % ADMINS.length]!;
  const reportedAt = shift(createdAt, j * 5 * MINUTE);
  return {
    reportId: `LSR-2026-${String(n).padStart(5, "0")}-${String(j + 1).padStart(2, "0")}`,
    livestreamId,
    reporter: {
      id: `u_lsr_${n}_${j + 1}`,
      username: slug(`viewer ${n} ${j + 1}`),
      displayName: `Viewer ${n}-${j + 1}`,
    },
    reportType,
    description: `Reported ${reportType} during the stream (mark ${j + 1}).`,
    status,
    resolution: closed
      ? {
          action: status === "RESOLVED" ? "CONTENT_REMOVED" : "NO_ACTION",
          note:
            status === "RESOLVED"
              ? "Reviewed and actioned"
              : "No violation found",
          resolvedBy: admin.name,
          resolvedAt: shift(reportedAt, HOUR),
        }
      : null,
    createdAt: reportedAt,
    evidence: {
      timestampSeconds: j % 2 === 0 ? 120 + j * 30 : null,
      clipUrl:
        j % 2 === 0
          ? `https://cdn.aimess.app/clips/${livestreamId}_${j + 1}.mp4`
          : null,
    },
  };
}

function build(seed: Seed, i: number): LivestreamDetail {
  const n = i + 1;
  const livestreamId = `LS-2026-${String(n).padStart(5, "0")}`;
  const category = CATEGORIES[seed.categoryIdx]!;
  const live = seed.status === "LIVE";
  const cancelled = seed.status === "CANCELLED";
  const durationSeconds = seed.durationMinutes * 60;
  // CANCELLED streams never went live; their startedAt == createdAt and they end immediately.
  const startedAt = seed.createdAt;
  const endedAt = live
    ? null
    : cancelled
      ? seed.createdAt
      : shift(startedAt, seed.durationMinutes * MINUTE);

  const admin = ADMINS[i % ADMINS.length]!;
  const endReasonCode = seed.endReasonCode ?? null;
  const endedBy =
    !live && endReasonCode
      ? { adminId: admin.id, adminName: admin.name }
      : null;

  // Embedded reports — count comes straight from the seed.
  const reports: LivestreamReportItem[] = Array.from(
    { length: seed.reportCount },
    (_unused, j) => buildReport(livestreamId, n, j, seed.createdAt)
  );

  const byType: Record<LivestreamReportType, number> = {
    HARASSMENT: 0,
    SPAM: 0,
    COPYRIGHT: 0,
    NUDITY: 0,
    VIOLENCE: 0,
    HATE_SPEECH: 0,
    OTHER: 0,
  };
  let open = 0;
  let reviewing = 0;
  let resolved = 0;
  let dismissed = 0;
  for (const r of reports) {
    byType[r.reportType] += 1;
    if (r.status === "OPEN") open += 1;
    else if (r.status === "REVIEWING") reviewing += 1;
    else if (r.status === "RESOLVED") resolved += 1;
    else dismissed += 1;
  }
  const firstReportedAt = reports.length > 0 ? reports[0]!.createdAt : null;
  const lastReportedAt =
    reports.length > 0 ? reports[reports.length - 1]!.createdAt : null;

  // Moderation timeline. Always a CREATED entry; ENDED-by-admin adds an ENDED entry.
  const moderationHistory: LivestreamDetail["moderationHistory"] = [
    {
      id: `lsh_${n}_1`,
      action: "STREAM_CREATED",
      adminId: "system",
      adminName: "System",
      reasonCode: null,
      note: null,
      createdAt: seed.createdAt,
    },
  ];
  if (endedBy && endReasonCode) {
    moderationHistory.push({
      id: `lsh_${n}_2`,
      action: cancelled ? "STREAM_CANCELLED" : "STREAM_ENDED",
      adminId: endedBy.adminId,
      adminName: endedBy.adminName,
      reasonCode: endReasonCode,
      note: "Ended by moderation",
      createdAt: endedAt!,
    });
  }

  // Telemetry — derived deterministically from the seed counters.
  const peakViewers = Math.round(seed.viewerCount * 1.4);
  const totalUniqueViewers = Math.round(seed.viewerCount * 2.1) + 50;
  const totalWatchTimeSeconds = seed.viewerCount * durationSeconds;
  const averageWatchTimeSeconds =
    totalUniqueViewers === 0
      ? 0
      : Math.round(totalWatchTimeSeconds / totalUniqueViewers);

  return {
    livestreamId,
    title: seed.title,
    description: `${seed.title} — hosted in ${seed.community}.`,
    community: {
      id: `comm_${slug(seed.community)}`,
      name: seed.community,
      slug: slug(seed.community),
      memberCount: 1_000 + n * 137,
      creatorRole: i % 4 === 0 ? "OWNER" : "MODERATOR",
    },
    creator: {
      id: `u_cr_${n}`,
      username: slug(seed.creator),
      displayName: seed.creator,
      avatarUrl: i % 3 === 0 ? null : `https://cdn.aimess.app/av/u_cr_${n}.jpg`,
      accountStatus: seed.creatorStatus,
      totalStreams: 3 + (i % 12),
      priorStrikes: i % 3,
    },
    category,
    createdAt: seed.createdAt,
    startedAt,
    endedAt,
    durationSeconds: cancelled ? 0 : durationSeconds,
    status: seed.status,
    viewerCount: seed.viewerCount,
    reportCount: seed.reportCount,
    reportSeverity: seed.reportSeverity,
    thumbnailUrl:
      i % 5 === 0 ? null : `https://cdn.aimess.app/thumbs/${livestreamId}.jpg`,
    endReasonCode,
    endedBy,
    viewerStats: {
      currentViewers: live ? seed.viewerCount : 0,
      peakViewers,
      totalUniqueViewers,
      totalWatchTimeSeconds,
      averageWatchTimeSeconds,
      chatMessageCount: seed.viewerCount * 3 + n,
    },
    streamMetadata: {
      ingestProtocol: i % 2 === 0 ? "RTMP" : "SRT",
      // Stream KEY intentionally omitted/redacted — never expose ingest secrets.
      playbackUrl: `https://live.aimess.app/hls/${livestreamId}/index.m3u8`,
      resolution: RESOLUTIONS[i % RESOLUTIONS.length]!,
      bitrateKbps: 3_500 + (i % 3) * 1_500,
      fps: i % 2 === 0 ? 60 : 30,
      region: REGIONS[i % REGIONS.length]!,
      isRecording: seed.isRecording ?? false,
      recordingUrl:
        !live && seed.isRecording
          ? `https://cdn.aimess.app/recordings/${livestreamId}.mp4`
          : null,
    },
    reportsSummary: {
      total: reports.length,
      open,
      reviewing,
      resolved,
      dismissed,
      severity: seed.reportSeverity,
      byType,
      firstReportedAt,
      lastReportedAt,
    },
    moderationHistory,
    reports,
  };
}

export const livestreamFixtures: LivestreamDetail[] = SEEDS.map(build);
