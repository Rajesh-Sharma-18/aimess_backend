/**
 * One notification object, one language — envelope AND the nested legacy payload.
 *
 * The reported frame carried a Vietnamese `title`/`body` above an English
 * `payload.title`/`payload.body`. Neither half was malfunctioning: `payload` is
 * the stored row, rendered once at write time in the ACCOUNT's language, and
 * the envelope is rendered here, per socket. Two independent resolutions of
 * "what language is this person reading in", for one object.
 *
 * These tests pin the property that makes that impossible: both halves come
 * from the SAME render of the SAME replay ticket, so they cannot disagree
 * whatever the socket's locale is.
 */
import {
  accountCopy,
  authCopy,
  callCopy,
  chatCopy,
  communityCopy,
  friendCopy,
  groupCopy,
  resolutionCopy,
  type LocalizedCopy,
  type SupportedLocale,
} from "@aimess/constants";

import { localizeNotificationFrame } from "../../src/sockets/localize-notification.js";

const LOCALES: SupportedLocale[] = ["en", "vi", "th"];

/** Exactly the shape `createNotificationImpl`'s `publishRow` emits. */
function frameFor(type: string, copy: LocalizedCopy, stored: SupportedLocale) {
  const text = copy(stored);
  return {
    notificationId: "n1",
    type,
    title: text.title,
    body: text.body,
    // The stored row, baked in the account's language at write time.
    payload: {
      title: text.title,
      body: text.body,
      data: { actionType: "SESSION_CREATED" },
    },
    data: {
      actionType: "SESSION_CREATED",
      copyRef: JSON.stringify(copy.descriptor),
    },
  };
}

type Rendered = {
  title: string;
  body: string;
  payload: { title: string; body: string; data: Record<string, string> };
};

describe("the reported repro", () => {
  const copy = authCopy.newLogin("Chrome", "India");

  it("no longer produces a Vietnamese envelope over an English payload", () => {
    // Account English (what the row was written in), socket Vietnamese —
    // exactly the pair that produced the reported object.
    const out = localizeNotificationFrame(
      frameFor("auth.security_new_login", copy, "en"),
      "u1",
      "vi"
    ) as Rendered;

    expect(out.title).toBe(copy("vi").title);
    expect(out.payload.title).toBe(copy("vi").title);
    expect(out.payload.body).toBe(copy("vi").body);
    expect(out.payload.title).not.toBe("Login Detected");
  });

  it("holds in the mirror case: account Vietnamese, session English", () => {
    const out = localizeNotificationFrame(
      frameFor("auth.security_new_login", copy, "vi"),
      "u1",
      "en"
    ) as Rendered;

    expect(out.title).toBe(copy("en").title);
    expect(out.payload.title).toBe(copy("en").title);
    expect(out.payload.body).toBe(copy("en").body);
  });

  it("keeps the interpolated device and location verbatim in every language", () => {
    for (const locale of LOCALES) {
      const out = localizeNotificationFrame(
        frameFor("auth.security_new_login", copy, "en"),
        "u1",
        locale
      ) as Rendered;
      expect(out.body).toContain("chrome");
      expect(out.body).toContain("India");
      expect(out.payload.body).toBe(out.body);
    }
  });

  it("leaves every non-text field alone", () => {
    const input = frameFor("auth.security_new_login", copy, "en");
    const out = localizeNotificationFrame(input, "u1", "th") as Rendered & {
      notificationId: string;
      type: string;
      data: Record<string, string>;
    };

    expect(out.notificationId).toBe("n1");
    expect(out.type).toBe("auth.security_new_login");
    expect(out.data.actionType).toBe("SESSION_CREATED");
    expect(out.payload.data).toEqual({ actionType: "SESSION_CREATED" });
  });
});

describe("F1 — envelope and payload agree for EVERY registered copy builder", () => {
  // The whole registry, not a sample. Every builder that can ever appear in a
  // `data.copyRef` is enumerated from the exported namespaces, so a new
  // notification type is covered the day it is added rather than the day
  // someone remembers to extend a hand-written list here.
  //
  // Args are deliberately generic: the property under test is that ONE render
  // feeds both halves of the object, which is independent of what the sentence
  // says. A date-shaped second arg and a duration-shaped third keep the two
  // builders that parse their inputs (`memberMuted`, `livestreamEnded`) on
  // their real branches instead of an error path.
  const ARGS = ["Alpha", "2026-01-01T00:00:00.000Z", "1h 24m"] as const;
  const NAMESPACES = {
    friend: friendCopy,
    resolution: resolutionCopy,
    community: communityCopy,
    chat: chatCopy,
    group: groupCopy,
    call: callCopy,
    auth: authCopy,
    account: accountCopy,
  } as const;

  const BUILDERS: [string, LocalizedCopy][] = Object.entries(NAMESPACES)
    .flatMap(([ns, builders]) =>
      Object.entries(builders as Record<string, unknown>).map(
        ([name, build]): [string, LocalizedCopy] => [
          `${ns}.${name}`,
          (build as (...a: readonly unknown[]) => LocalizedCopy)(...ARGS),
        ]
      )
    )
    // `resolutionCopy` builds `data.resolution`, not a title/body pair — it
    // rides `dataRef`, is asserted separately below, and has no envelope half.
    .filter(([ref]) => !ref.startsWith("resolution."));

  it("enumerates the whole registry (guards against an empty sweep)", () => {
    expect(BUILDERS.length).toBeGreaterThanOrEqual(40);
    for (const [ref, copy] of BUILDERS) {
      expect(`${ref}:${String(copy.descriptor?.ref)}`).toBe(`${ref}:${ref}`);
    }
  });

  it.each(BUILDERS)(
    "%s renders one language across envelope and payload",
    (type, copy) => {
      for (const stored of LOCALES) {
        for (const session of LOCALES) {
          const out = localizeNotificationFrame(
            frameFor(type, copy, stored),
            "u1",
            session
          ) as Rendered;
          const expected = copy(session);
          // The two halves must always AGREE. Whether the heading is replaced
          // at all depends on `inboxTitle`/emptiness, and the same rule governs
          // both — so equality between them is the invariant, and matching the
          // freshly-rendered copy is asserted where the rule says it applies.
          expect(out.payload.title).toBe(out.title);
          expect(out.payload.body).toBe(out.body);
          if (expected.body) {
            expect(out.body).toBe(expected.body);
          }
          if (expected.title) {
            expect(out.title).toBe(expected.title);
          }
        }
      }
    }
  );

  it("renders the `dataRef` resolution line per socket too", () => {
    const resolution = resolutionCopy.friendAccepted();
    const frame = {
      type: "friend.accepted",
      title: "Alpha",
      body: "Alpha accepted",
      payload: { title: "Alpha", body: "Alpha accepted", data: {} },
      data: { dataRef: JSON.stringify(resolution.descriptor) },
    };
    for (const locale of LOCALES) {
      const out = localizeNotificationFrame(frame, "u1", locale) as {
        resolution: string;
        data: { resolution: string };
      };
      expect(out.resolution).toBe(resolution(locale).resolution);
      expect(out.data.resolution).toBe(resolution(locale).resolution);
    }
  });
});

describe("F3 — fallbacks never leak a key or a random language", () => {
  const copy = authCopy.newLogin("Chrome", "India");

  it("passes an authored row through untouched when it has no ticket", () => {
    // Admin announcements and ban notices are CONTENT, not product copy.
    const authored = {
      type: "system.announcement",
      title: "Scheduled maintenance",
      body: "We are down 02:00–03:00 UTC.",
      payload: {
        title: "Scheduled maintenance",
        body: "We are down 02:00–03:00 UTC.",
      },
      data: { announcementId: "a1" },
    };
    expect(localizeNotificationFrame(authored, "u1", "vi")).toBe(authored);
  });

  it("keeps the stored sentence when the ticket names an unknown builder", () => {
    const frame = frameFor("auth.security_new_login", copy, "en");
    const orphaned = {
      ...frame,
      data: {
        ...frame.data,
        copyRef: JSON.stringify({ ref: "auth.notInThisBuild", args: [] }),
      },
    };
    const out = localizeNotificationFrame(orphaned, "u1", "vi") as Rendered;

    expect(out.title).toBe(copy("en").title);
    expect(out.payload.title).toBe(copy("en").title);
    expect(out.title).not.toContain("auth.notInThisBuild");
  });

  it("survives a malformed ticket without throwing", () => {
    const frame = frameFor("auth.security_new_login", copy, "en");
    const broken = { ...frame, data: { ...frame.data, copyRef: "{not json" } };
    expect(() => localizeNotificationFrame(broken, "u1", "vi")).not.toThrow();
  });

  it("does not invent a payload for a frame that has none", () => {
    const frame = frameFor("auth.security_new_login", copy, "en");
    const { payload: _dropped, ...noPayload } = frame;
    const out = localizeNotificationFrame(noPayload, "u1", "vi") as Rendered & {
      payload?: unknown;
    };

    expect(out.payload).toBeUndefined();
    expect(out.title).toBe(copy("vi").title);
  });
});
