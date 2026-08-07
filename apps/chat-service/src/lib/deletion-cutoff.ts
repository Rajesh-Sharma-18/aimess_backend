function parseCutoff(value: unknown): Date | undefined {
  return typeof value === "string" ? new Date(value) : undefined;
}

function latest(...dates: Array<Date | undefined>): Date | undefined {
  return dates
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => b.getTime() - a.getTime())[0];
}

export function getPrivateDeletionCutoff(
  room: { deletedFor?: unknown; clearFor?: unknown } | null | undefined,
  userId: string
): Date | undefined {
  const deletedAt = parseCutoff(
    (room?.deletedFor as Record<string, unknown> | undefined)?.[userId]
  );
  const clearAt = parseCutoff(
    (room?.clearFor as Record<string, unknown> | undefined)?.[userId]
  );
  return latest(deletedAt, clearAt);
}

export function getGroupVisibilityCutoff(
  member:
    | {
        clearedAt?: Date | null;
        clearChatAt?: Date | null;
        joinedAt?: Date | null;
      }
    | null
    | undefined
): Date | undefined {
  return latest(
    member?.clearedAt ?? undefined,
    member?.clearChatAt ?? undefined,
    member?.joinedAt ?? undefined
  );
}
