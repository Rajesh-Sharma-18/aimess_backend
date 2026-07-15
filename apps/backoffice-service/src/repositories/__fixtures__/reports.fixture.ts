/**
 * Phase 1 mock dataset for the Reports & Moderation admin API.
 *
 * Deterministic, hardcoded fixtures (no Date.now / no randomness) so the API
 * behaves identically across runs. Each row is a full `ReportDetail`; the list
 * endpoint projects these down to `ReportListItem`. In Phase 2 this file is
 * dropped entirely — a PrismaReportRepository reads `admin_db` instead.
 *
 * This dataset MIRRORS the Reports & Moderation table mockup: 20 rows, realistic
 * names, and the first four rows reproduce the design (John Doe / Siena Weiss /
 * Spam Messages / Open, …). The frontend maps the API enums to the friendly
 * labels shown in the UI — see the canonical REPORT_TYPE_LABELS / STATUS_LABELS
 * tables in docs/REPORTS-MODERATION-API-SPEC.md §9:
 *   reportType SPAM→"Spam Messages", HATE_SPEECH→"Offensive Language",
 *   ILLEGAL_CONTENT→"Inappropriate Content", OTHER→"Other", …
 *   status PENDING→"Open", RESOLVED→"Resolved", DISMISSED→"Dismissed", …
 */
import type {
  AccountStatus,
  DismissReason,
  ModeratorRef,
  ReportDetail,
  ReportPriority,
  ReportStatus,
  ReportType,
  ResolutionType,
  TargetType,
} from "../../types/moderation.types.js";
import type { MediaObject } from "@aimess/shared-types";

/**
 * Fixture data stores a fully-resolved URL (no raw object key to presign in
 * Phase 1 mock mode) — wrap it in the standard MediaObject shape so the mock
 * repository satisfies the same `avatar: MediaObject | null` contract as the
 * live Prisma repository.
 */
/** "John Doe" → { firstName: "John", lastName: "Doe" } (single-word names get an empty lastName). */
function splitName(fullName: string): { firstName: string; lastName: string } {
  const [firstName, ...rest] = fullName.trim().split(/\s+/);
  return { firstName: firstName ?? "", lastName: rest.join(" ") };
}

function fixtureAvatar(url: string | null): MediaObject | null {
  if (!url) return null;
  return {
    mediaId: null,
    fileId: null,
    objectKey: null,
    fileName: null,
    contentType: null,
    size: null,
    downloadUrl: url,
    downloadUrlExpiresIn: null,
    uploadUrl: null,
    uploadUrlExpiresIn: null,
  };
}

// --- deterministic time helpers (operate on fixed ISO strings — no Date.now) ---
const HOUR = 3_600_000;
const DAY = 86_400_000;
const shift = (iso: string, ms: number): string =>
  new Date(new Date(iso).getTime() + ms).toISOString();

const MODERATORS: ModeratorRef[] = [
  { id: "adm_1", name: "Sara Admin" },
  { id: "adm_2", name: "Leo Mod" },
  { id: "adm_3", name: "Priya Sr" },
];
const RESOLUTIONS: ResolutionType[] = [
  "ACTION_TAKEN",
  "WARNING_ISSUED",
  "CONTENT_REMOVED",
];
const DISMISS_REASONS: DismissReason[] = [
  "NO_VIOLATION",
  "INSUFFICIENT_EVIDENCE",
  "DUPLICATE",
  "FALSE_REPORT",
];

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
const isCommunity = (t: TargetType): boolean =>
  t === "GROUP" || t === "COMMUNITY" || t === "POST" || t === "COMMENT";

type Seed = {
  reported: string;
  reporter: string;
  reportType: ReportType;
  targetType: TargetType;
  status: ReportStatus;
  priority: ReportPriority;
  reason: string;
  createdAt: string;
  reportedStatus: AccountStatus;
  withEvidence?: boolean;
  withRelated?: boolean;
};

// First four rows = the mockup, verbatim. Remaining 16 give a realistic spread
// across every status, most report types, all priorities, and dates Jan–Jun 2026.
const SEEDS: Seed[] = [
  {
    reported: "John Doe",
    reporter: "Siena Weiss",
    reportType: "SPAM",
    targetType: "MESSAGE",
    status: "PENDING",
    priority: "MEDIUM",
    reason: "Posting repetitive promotional links",
    createdAt: "2026-02-02T09:12:00Z",
    reportedStatus: "ACTIVE",
    withEvidence: true,
    withRelated: true,
  },
  {
    reported: "Jane Smith",
    reporter: "Elora Pruitt",
    reportType: "HATE_SPEECH",
    targetType: "MESSAGE",
    status: "RESOLVED",
    priority: "HIGH",
    reason: "Offensive language toward another member",
    createdAt: "2026-02-02T10:40:00Z",
    reportedStatus: "SUSPENDED",
    withEvidence: true,
  },
  {
    reported: "Alice Wonder",
    reporter: "Clay Little",
    reportType: "ILLEGAL_CONTENT",
    targetType: "MESSAGE",
    status: "DISMISSED",
    priority: "LOW",
    reason: "Inappropriate content shared in chat",
    createdAt: "2026-02-02T12:05:00Z",
    reportedStatus: "ACTIVE",
  },
  {
    reported: "Alice Wonder",
    reporter: "Eliseo Pham",
    reportType: "OTHER",
    targetType: "USER",
    status: "RESOLVED",
    priority: "MEDIUM",
    reason: "General community guideline concern",
    createdAt: "2026-02-02T14:28:00Z",
    reportedStatus: "ACTIVE",
  },

  {
    reported: "Marcus Lee",
    reporter: "Mia Carter",
    reportType: "HARASSMENT",
    targetType: "MESSAGE",
    status: "UNDER_REVIEW",
    priority: "HIGH",
    reason: "Sending threatening messages repeatedly",
    createdAt: "2026-01-15T08:30:00Z",
    reportedStatus: "ACTIVE",
    withEvidence: true,
  },
  {
    reported: "Sofia Rossi",
    reporter: "Noah Webb",
    reportType: "SPAM",
    targetType: "COMMENT",
    status: "RESOLVED",
    priority: "LOW",
    reason: "Bulk advertising in comments",
    createdAt: "2026-01-22T11:15:00Z",
    reportedStatus: "SUSPENDED",
  },
  {
    reported: "Liam Walsh",
    reporter: "Ava Reed",
    reportType: "VIOLENCE",
    targetType: "POST",
    status: "ESCALATED",
    priority: "CRITICAL",
    reason: "Graphic violent content shared",
    createdAt: "2026-01-28T16:50:00Z",
    reportedStatus: "BANNED",
    withEvidence: true,
  },
  {
    reported: "Nadia Khan",
    reporter: "Ethan Cole",
    reportType: "NUDITY",
    targetType: "MEDIA",
    status: "PENDING",
    priority: "HIGH",
    reason: "Explicit imagery in a public channel",
    createdAt: "2026-02-05T07:45:00Z",
    reportedStatus: "ACTIVE",
  },
  {
    reported: "Omar Farouk",
    reporter: "Lily Brooks",
    reportType: "MISINFORMATION",
    targetType: "USER",
    status: "RESOLVED",
    priority: "MEDIUM",
    reason: "Spreading false medical claims",
    createdAt: "2026-02-11T13:20:00Z",
    reportedStatus: "DELETED",
  },
  {
    reported: "Emma Stone",
    reporter: "Jack Hayes",
    reportType: "IMPERSONATION",
    targetType: "USER",
    status: "DISMISSED",
    priority: "LOW",
    reason: "Pretending to be a staff account",
    createdAt: "2026-02-18T09:05:00Z",
    reportedStatus: "ACTIVE",
  },
  {
    reported: "Ravi Patel",
    reporter: "Zoe Park",
    reportType: "SELF_HARM",
    targetType: "COMMENT",
    status: "UNDER_REVIEW",
    priority: "HIGH",
    reason: "Encouraging self-harm",
    createdAt: "2026-03-02T18:40:00Z",
    reportedStatus: "SUSPENDED",
    withEvidence: true,
  },
  {
    reported: "Chloe Kim",
    reporter: "Owen Fox",
    reportType: "HARASSMENT",
    targetType: "GROUP",
    status: "PENDING",
    priority: "MEDIUM",
    reason: "Coordinated harassment in a group",
    createdAt: "2026-03-09T10:10:00Z",
    reportedStatus: "ACTIVE",
    withRelated: true,
  },
  {
    reported: "Diego Souza",
    reporter: "Nora Vance",
    reportType: "TERRORISM",
    targetType: "COMMUNITY",
    status: "ESCALATED",
    priority: "CRITICAL",
    reason: "Promoting an extremist organization",
    createdAt: "2026-03-17T15:25:00Z",
    reportedStatus: "BANNED",
  },
  {
    reported: "Hannah Berg",
    reporter: "Leo Marsh",
    reportType: "SPAM",
    targetType: "MESSAGE",
    status: "RESOLVED",
    priority: "LOW",
    reason: "Repetitive promotional links",
    createdAt: "2026-03-25T12:00:00Z",
    reportedStatus: "ACTIVE",
    withEvidence: true,
  },
  {
    reported: "Yuki Tanaka",
    reporter: "Iris Lund",
    reportType: "HATE_SPEECH",
    targetType: "USER",
    status: "DISMISSED",
    priority: "MEDIUM",
    reason: "Reported slur was a quoted rebuttal",
    createdAt: "2026-04-03T08:55:00Z",
    reportedStatus: "ACTIVE",
  },
  {
    reported: "Tom Becker",
    reporter: "Sam Ortiz",
    reportType: "CSAM",
    targetType: "GROUP",
    status: "ESCALATED",
    priority: "CRITICAL",
    reason: "Suspected child exploitation material",
    createdAt: "2026-04-12T20:15:00Z",
    reportedStatus: "SUSPENDED",
    withEvidence: true,
  },
  {
    reported: "Aisha Noor",
    reporter: "Tara Singh",
    reportType: "MISINFORMATION",
    targetType: "POST",
    status: "PENDING",
    priority: "LOW",
    reason: "Misleading election claims",
    createdAt: "2026-04-21T11:35:00Z",
    reportedStatus: "ACTIVE",
  },
  {
    reported: "Pablo Ruiz",
    reporter: "Felix Braun",
    reportType: "VIOLENCE",
    targetType: "MEDIA",
    status: "RESOLVED",
    priority: "HIGH",
    reason: "Violent threat in an attachment",
    createdAt: "2026-05-06T14:50:00Z",
    reportedStatus: "BANNED",
  },
  {
    reported: "Greta Nilsson",
    reporter: "Maya Lin",
    reportType: "OTHER",
    targetType: "COMMENT",
    status: "UNDER_REVIEW",
    priority: "MEDIUM",
    reason: "Off-topic disruptive behavior",
    createdAt: "2026-05-19T09:30:00Z",
    reportedStatus: "ACTIVE",
  },
  {
    reported: "Ivan Petrov",
    reporter: "Dana Cruz",
    reportType: "NUDITY",
    targetType: "MESSAGE",
    status: "DISMISSED",
    priority: "CRITICAL",
    reason: "Image was within community guidelines",
    createdAt: "2026-06-01T07:20:00Z",
    reportedStatus: "ACTIVE",
    withEvidence: true,
  },
];

function build(seed: Seed, i: number): ReportDetail {
  const n = i + 1;
  const reportId = `RPT-2026-${String(n).padStart(7, "0")}`;
  const closed = seed.status === "RESOLVED" || seed.status === "DISMISSED";
  const assigned = seed.status !== "PENDING";
  const moderator = assigned ? MODERATORS[i % MODERATORS.length]! : null;
  const resolvedAtIso = closed ? shift(seed.createdAt, DAY) : null;
  const resolvedAt = resolvedAtIso ? Date.parse(resolvedAtIso) : null;

  const availableActions = closed
    ? ["VIEW"]
    : seed.status === "ESCALATED"
      ? ["RESOLVE", "DISMISS", "ASSIGN"]
      : ["RESOLVE", "DISMISS", "ESCALATE", "ASSIGN"];

  const resolution: ResolutionType | null =
    seed.status === "RESOLVED" ? RESOLUTIONS[i % RESOLUTIONS.length]! : null;
  const dismissReason: DismissReason | null =
    seed.status === "DISMISSED"
      ? DISMISS_REASONS[i % DISMISS_REASONS.length]!
      : null;

  const history: ReportDetail["history"] = [
    {
      id: `h_${n}_1`,
      action: "CREATED",
      actorType: "USER",
      actorId: `u_rp_${n}`,
      actorName: seed.reporter,
      at: Date.parse(seed.createdAt),
      note: null,
    },
  ];
  if (assigned && moderator) {
    history.push({
      id: `h_${n}_2`,
      action: "ASSIGNED",
      actorType: "ADMIN",
      actorId: moderator.id,
      actorName: moderator.name,
      at: Date.parse(shift(seed.createdAt, HOUR)),
      note: "Picked up from queue",
    });
  }
  if (closed && moderator) {
    history.push({
      id: `h_${n}_3`,
      action: seed.status,
      actorType: "ADMIN",
      actorId: moderator.id,
      actorName: moderator.name,
      at: resolvedAt!,
      note:
        seed.status === "RESOLVED" ? "Action applied" : "Closed without action",
    });
  }

  const evidence: ReportDetail["evidence"] = seed.withEvidence
    ? [
        {
          id: `ev_${n}_1`,
          type: "MESSAGE_SNAPSHOT",
          capturedAt: Date.parse(seed.createdAt),
          content: {
            text: `Offending content sample for ${reportId}`,
            messageId: `msg_${n}`,
          },
        },
        {
          id: `ev_${n}_2`,
          type: "ATTACHMENT",
          mimeType: "image/jpeg",
          url: `https://cdn.aimess.app/evidence/ev_${n}_2.jpg`,
          thumbnailUrl: `https://cdn.aimess.app/evidence/ev_${n}_2_thumb.jpg`,
          sizeBytes: 50_000 + n * 137,
          restricted:
            seed.reportType === "CSAM" || seed.reportType === "ILLEGAL_CONTENT",
        },
      ]
    : [];

  return {
    reportId,
    reportType: seed.reportType,
    targetType: seed.targetType,
    status: seed.status,
    priority: seed.priority,
    reason: seed.reason,
    reporterNote: i % 2 === 0 ? `Reporter note for ${reportId}.` : null,
    sourceService: isCommunity(seed.targetType)
      ? "community-service"
      : "messaging-service",
    communityId: isCommunity(seed.targetType) ? `comm_${n}` : null,
    communityName: isCommunity(seed.targetType) ? `Community ${n}` : null,
    createdAt: Date.parse(seed.createdAt),
    updatedAt: Date.parse(shift(seed.createdAt, HOUR)),
    resolvedAt,
    slaDueAt: Date.parse(shift(seed.createdAt, DAY)),
    reportedUser: {
      id: `u_rd_${n}`,
      username: slug(seed.reported),
      displayName: seed.reported,
      ...splitName(seed.reported),
      avatar: fixtureAvatar(
        i % 3 === 0 ? null : `https://cdn.aimess.app/av/u_rd_${n}.jpg`
      ),
      accountStatus: seed.reportedStatus,
      joinedAt: Date.parse("2025-06-01T08:00:00Z"),
      priorReportsCount: i % 6,
      priorActionsCount: i % 3,
    },
    reporterUser: {
      id: `u_rp_${n}`,
      username: slug(seed.reporter),
      displayName: seed.reporter,
      ...splitName(seed.reporter),
      avatar: fixtureAvatar(
        i % 2 === 0 ? `https://cdn.aimess.app/av/u_rp_${n}.jpg` : null
      ),
      accountStatus: "ACTIVE",
      reportsFiledCount: 1 + (i % 4),
      falseReportRate: Number(((i % 5) / 10).toFixed(1)),
    },
    target: {
      type: seed.targetType,
      id: `tgt_${n}`,
      ...(seed.targetType === "MESSAGE" ? { conversationId: `conv_${n}` } : {}),
      snapshot: {
        text: `Snapshot for ${reportId}`,
        sentAt: seed.createdAt,
        deleted: false,
      },
      deepLink: isCommunity(seed.targetType)
        ? `/admin/community/entities/tgt_${n}`
        : `/admin/messaging/entities/tgt_${n}`,
    },
    evidence,
    history,
    relatedReports: seed.withRelated
      ? [
          {
            reportId: `RPT-2026-${String(1000 + n).padStart(7, "0")}`,
            reportType: seed.reportType,
            status: "RESOLVED",
            createdAt: Date.parse("2026-01-05T00:00:00Z"),
          },
        ]
      : [],
    availableActions,
    resolution,
    dismissReason,
    decisionNote:
      seed.status === "RESOLVED"
        ? `Resolved: ${seed.reason}`
        : seed.status === "DISMISSED"
          ? `Dismissed (${dismissReason})`
          : null,
    moderator,
  };
}

export const reportFixtures: ReportDetail[] = SEEDS.map(build);
