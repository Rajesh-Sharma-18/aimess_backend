/**
 * One-off backfill: call timeline rows written before calls had their own
 * message kind were persisted as `messageType: "SYSTEM"` (terminal outcomes) or
 * `"TEXT"` (MISSED). Both now persist as VOICE_CALL / VIDEO_CALL so every read
 * path reports the call kind without parsing `content.text`.
 *
 * SAFETY — this deliberately does NOT sweep all SYSTEM rows. A row is only
 * rewritten when the DB itself proves it is a call AND proves which kind:
 *
 *   - terminal rows: `systemEvent = "CALL_ENDED"` (only the call writer sets it)
 *     with `content.call.callType` — the structured sub-object the same writer
 *     has always stored alongside the text.
 *   - MISSED rows:  `content.call.outcome = "MISSED"` with `content.call.callType`.
 *     These carry no systemEvent, so `content.call` is the whole proof.
 *
 * Rows whose `content.call.callType` is missing/unreadable are COUNTED AND
 * SKIPPED, never guessed: an unmigrated row still renders (the client reads
 * `content.call` for the card) — a row mislabelled VOICE_CALL when it was video
 * would show the wrong call type forever. `content.text` is never consulted.
 *
 * Idempotent and safe to re-run: it only matches rows still holding the old
 * kind. Covers both PrivateMessage (1:1) and GroupMessage timelines.
 *
 * Usage: pnpm --filter @aimess/chat-service db:backfill:call-content-type
 */
import { callContentType } from "@aimess/constants";
import { prisma } from "../src/config/prisma.js";

const LEGACY_KINDS = ["SYSTEM", "TEXT"];

type CallRow = {
  id: string;
  messageType: string;
  content: unknown;
};

/** The call sub-object, or null when the row can't prove its own call type. */
function readCallType(content: unknown): string | null {
  if (!content || typeof content !== "object") return null;
  const call = (content as Record<string, unknown>).call;
  if (!call || typeof call !== "object") return null;
  const callType = (call as Record<string, unknown>).callType;
  const value = String(callType ?? "").toUpperCase();
  return value === "AUDIO" || value === "VIDEO" ? value : null;
}

async function migrate(
  label: string,
  rows: CallRow[],
  update: (id: string, messageType: string) => Promise<unknown>
): Promise<void> {
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const callType = readCallType(row.content);
    if (!callType) {
      skipped++;
      continue;
    }
    await update(row.id, callContentType(callType));
    updated++;
  }
  console.log(
    `${label}: ${updated} row(s) migrated, ${skipped} skipped (no readable content.call.callType).`
  );
}

async function backfillCallContentType() {
  const privateRows = (await prisma.privateMessage.findMany({
    where: {
      messageType: { in: LEGACY_KINDS },
      OR: [
        { systemEvent: "CALL_ENDED" },
        { clientMessageId: { endsWith: ":missed" } },
      ],
    },
    select: { id: true, messageType: true, content: true },
  })) as CallRow[];

  await migrate("PrivateMessage", privateRows, (id, messageType) =>
    prisma.privateMessage.update({ where: { id }, data: { messageType } })
  );

  // Group calls only ever wrote CALL_ENDED rows, so no clientMessageId branch.
  const groupRows = (await prisma.groupMessage.findMany({
    where: { messageType: { in: LEGACY_KINDS }, systemEvent: "CALL_ENDED" },
    select: { id: true, messageType: true, content: true },
  })) as CallRow[];

  await migrate("GroupMessage", groupRows, (id, messageType) =>
    prisma.groupMessage.update({ where: { id }, data: { messageType } })
  );
}

backfillCallContentType()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
