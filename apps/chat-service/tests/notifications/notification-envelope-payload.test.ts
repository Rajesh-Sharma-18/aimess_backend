/**
 * One row → one object → one language, on the REST half.
 *
 * The reported bug arrived over the socket, but the same object is also served
 * by `GET /notifications`, and it has the same two halves: the envelope
 * `title`/`body` and the legacy nested `payload.title`/`payload.body` that old
 * clients still read. Any rewrite that reaches one and not the other produces a
 * card that contradicts itself — in language, or in the name it uses.
 *
 * These pin both rewrites the serializer performs: the locale replay, and the
 * stale-actor-name refresh.
 */
import { authCopy, friendCopy, runWithLocale } from "@aimess/constants";

import type { Notification } from "../../src/generated/prisma/index.js";
import { serializeNotification } from "../../src/lib/notification-serializer.js";

const LOCALES = ["en", "vi", "th"] as const;

function row(over: Partial<Notification> & { payload: unknown }): Notification {
  return {
    id: "n1",
    userId: "viewer-1",
    actorId: "",
    entity: {},
    actorSnapshot: {},
    isRead: false,
    readAt: null,
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date("2026-08-26T10:00:00Z"),
    updatedAt: new Date("2026-08-26T10:00:00Z"),
    loginSessionId: null,
    loginExpiresAt: null,
    loginResolvedAt: null,
    groupKey: null,
    version: 1,
    type: "auth.security_new_login",
    ...over,
  } as Notification;
}

const payloadOf = (dto: { payload: Record<string, unknown> }) =>
  dto.payload as { title?: string; body?: string };

describe("the reported repro, served over REST", () => {
  const copy = authCopy.newLogin("Chrome", "India");
  // Exactly what pushToUser writes: text baked in the ACCOUNT's language plus
  // the replay ticket.
  const stored = row({
    payload: {
      title: copy("en").title,
      body: copy("en").body,
      data: {
        actionType: "SESSION_CREATED",
        copyRef: JSON.stringify(copy.descriptor),
      },
    },
  });

  it.each(LOCALES)(
    "reads %s in envelope AND payload, whatever the row was written in",
    async (locale) => {
      const dto = await runWithLocale(locale, () =>
        serializeNotification(stored, "viewer-1")
      );

      expect(dto.body).toBe(copy(locale).body);
      expect(payloadOf(dto).body).toBe(copy(locale).body);
      expect(payloadOf(dto).title).toBe(copy(locale).title);
    }
  );

  it("never leaves the replay ticket on the wire", async () => {
    const dto = await runWithLocale("vi", () =>
      serializeNotification(stored, "viewer-1")
    );
    const data = (dto.payload as { data?: Record<string, string> }).data ?? {};

    expect(data.copyRef).toBeUndefined();
    expect(data.actionType).toBe("SESSION_CREATED");
  });

  it("keeps the interpolated device and location out of translation", async () => {
    for (const locale of LOCALES) {
      const dto = await runWithLocale(locale, () =>
        serializeNotification(stored, "viewer-1")
      );
      expect(dto.body).toContain("chrome");
      expect(dto.body).toContain("India");
    }
  });
});

describe("the stale-actor-name refresh reaches both halves", () => {
  // A social row published before the actor's profile resolved: the sentence
  // was baked with the "Someone" fallback, and a fresh snapshot now has the
  // real name. The refresh used to rewrite the envelope only.
  const copy = friendCopy.requested("");
  const stored = row({
    type: "friend.requested",
    actorId: "peer-1",
    payload: {
      title: copy("en").title,
      body: copy("en").body,
      data: { copyRef: JSON.stringify(copy.descriptor) },
    },
  });
  const refresh = {
    actorById: new Map([
      [
        "peer-1",
        { displayName: "Mohit Vasundhara", avatarUrl: "", isDeleted: false },
      ],
    ]),
    communityById: new Map(),
  };

  it("puts the real name in the payload, not just the envelope", async () => {
    const dto = await runWithLocale("en", () =>
      serializeNotification(stored, "viewer-1", refresh as never)
    );

    expect(dto.body).toContain("Mohit Vasundhara");
    expect(payloadOf(dto).body).toContain("Mohit Vasundhara");
    expect(payloadOf(dto).body).toBe(dto.body);
  });

  it("holds in every language", async () => {
    for (const locale of LOCALES) {
      const dto = await runWithLocale(locale, () =>
        serializeNotification(stored, "viewer-1", refresh as never)
      );
      expect(payloadOf(dto).body).toBe(dto.body);
      expect(payloadOf(dto).body).toContain("Mohit Vasundhara");
    }
  });

  it("leaves an already-named row untouched", async () => {
    const named = friendCopy.requested("Mohit Vasundhara");
    const dto = await runWithLocale("vi", () =>
      serializeNotification(
        row({
          type: "friend.requested",
          actorId: "peer-1",
          payload: {
            title: named("vi").title,
            body: named("vi").body,
            data: { copyRef: JSON.stringify(named.descriptor) },
          },
        }),
        "viewer-1",
        refresh as never
      )
    );

    expect(payloadOf(dto).body).toBe(named("vi").body);
    expect(dto.body).toBe(named("vi").body);
  });
});
