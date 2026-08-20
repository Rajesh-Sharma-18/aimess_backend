/**
 * The copy-builder refs are a PERSISTED CONTRACT.
 *
 * Every notification row stores `data.copyRef = {"ref":"<ns>.<builder>", args}`.
 * Renaming a builder or its namespace silently orphans every row already
 * pointing at it: those rows stop following the reader's language and fall back
 * to the sentence they were written with. The failure is invisible in code
 * review and invisible in the type system, so it is pinned here — a rename must
 * be a deliberate edit to this list, not a side effect of a refactor.
 */
import {
  authCopy,
  callCopy,
  chatCopy,
  communityCopy,
  friendCopy,
  groupCopy,
  renderNotificationCopy,
  renderNotificationData,
  resolutionCopy,
  SUPPORTED_LOCALES,
  t,
} from "@aimess/constants";

/** One representative call per builder, with plausible arguments. */
const SAMPLES: Record<string, () => { descriptor?: { ref: string } }> = {
  "friend.requested": () => friendCopy.requested("Ana"),
  "friend.acceptedForRequester": () => friendCopy.acceptedForRequester("Ana"),
  "friend.acceptedForAddressee": () => friendCopy.acceptedForAddressee("Ana"),
  "friend.rejected": () => friendCopy.rejected("Ana"),
  "friend.rejectedSelf": () => friendCopy.rejectedSelf("Ana"),
  "friend.cancelled": () => friendCopy.cancelled("Ana"),
  "resolution.friendAccepted": () => resolutionCopy.friendAccepted("Ana"),
  "resolution.friendNowFriends": () => resolutionCopy.friendNowFriends(),
  "resolution.friendDeclined": () => resolutionCopy.friendDeclined(),
  "resolution.friendDeclinedSelf": () => resolutionCopy.friendDeclinedSelf(),
  "resolution.friendCancelled": () => resolutionCopy.friendCancelled(),
  "community.joinRequested": () => communityCopy.joinRequested("C", "Ana"),
  "community.livestreamStarted": () =>
    communityCopy.livestreamStarted("C", "Ana"),
  "community.livestreamEnded": () =>
    communityCopy.livestreamEnded("C", "Ana", "5m"),
  "community.joinRequestApproved": () =>
    communityCopy.joinRequestApproved("C", "Ana"),
  "community.joinRequestRejected": () => communityCopy.joinRequestRejected("C"),
  "community.memberJoined": () => communityCopy.memberJoined("C"),
  "community.memberAdded": () => communityCopy.memberAdded("C"),
  "community.memberAddedForModerators": () =>
    communityCopy.memberAddedForModerators("C"),
  "community.adminTransferred": () => communityCopy.adminTransferred("C"),
  "community.roleChanged": () => communityCopy.roleChanged("ADMIN", "C"),
  "community.memberKicked": () => communityCopy.memberKicked("C"),
  "community.memberBanned": () => communityCopy.memberBanned("C"),
  "community.memberUnbanned": () => communityCopy.memberUnbanned("C"),
  "community.memberMuted": () =>
    communityCopy.memberMuted("2026-09-01T00:00:00.000Z", "C"),
  "community.memberUnmuted": () => communityCopy.memberUnmuted("C"),
  "community.memberWarned": () => communityCopy.memberWarned("", "C"),
  "community.inviteSent": () => communityCopy.inviteSent("C"),
  "community.inviteAccepted": () => communityCopy.inviteAccepted("C"),
  "community.reportCreated": () => communityCopy.reportCreated("C"),
  "community.reportActioned": () => communityCopy.reportActioned("C"),
  "community.reportResolved": () => communityCopy.reportResolved("C"),
  "community.deleted": () => communityCopy.deleted("C"),
  "community.closed": () => communityCopy.closed("C"),
  "community.reopened": () => communityCopy.reopened("C"),
  "chat.message": () =>
    chatCopy.message({ isCommunity: false, senderName: "Ana", preview: "hi" }),
  "group.memberAdded": () => groupCopy.memberAdded("G"),
  "group.memberMuted": () => groupCopy.memberMuted("G", null),
  "group.memberUnmuted": () => groupCopy.memberUnmuted("G"),
  "call.ringing": () => callCopy.ringing("Ana", "VIDEO"),
  "call.missed": () => callCopy.missed("Ana", "AUDIO"),
  "call.cancelled": () => callCopy.cancelled(),
  "call.activity": () =>
    callCopy.activity("Ana", "AUDIO", "MISSED", "INCOMING", 0, 0),
  "auth.newLogin": () => authCopy.newLogin("Chrome", "Hanoi"),
  "auth.passwordChanged": () => authCopy.passwordChanged(),
  "auth.emailChanged": () => authCopy.emailChanged(),
};

const RESOLUTION_REFS = new Set(
  Object.keys(SAMPLES).filter((ref) => ref.startsWith("resolution."))
);

describe("notification copy registry", () => {
  it.each(Object.keys(SAMPLES))("%s keeps its persisted ref", (ref) => {
    expect(SAMPLES[ref]!().descriptor?.ref).toBe(ref);
  });

  it("replays every builder from its stored ticket, in every locale", () => {
    for (const [ref, build] of Object.entries(SAMPLES)) {
      const ticket = JSON.stringify(build().descriptor);
      for (const locale of SUPPORTED_LOCALES) {
        if (RESOLUTION_REFS.has(ref)) {
          expect(renderNotificationData(ticket, locale)).not.toBeNull();
        } else {
          const copy = renderNotificationCopy(ticket, locale);
          expect(copy).not.toBeNull();
          expect(typeof copy?.body).toBe("string");
        }
      }
    }
  });

  it("survives a ticket it cannot replay rather than throwing", () => {
    for (const bad of [
      undefined,
      "",
      "{{{",
      JSON.stringify({ ref: "friend.removedInSomeFutureRefactor", args: [] }),
    ]) {
      expect(renderNotificationCopy(bad, "en")).toBeNull();
      expect(renderNotificationData(bad, "en")).toBeNull();
    }
  });

  it("replays an argument-less ticket onto the builder's own fallbacks", () => {
    // A truncated ticket is still better than a frozen sentence: the builder
    // runs with no arguments and produces its "Someone" / "unnamed" fallback,
    // in the reader's language, rather than the row reverting to whatever
    // language it was written in.
    const copy = renderNotificationCopy(
      JSON.stringify({ ref: "friend.requested" }),
      "vi"
    );
    expect(copy?.body).toBe(
      t("NOTIF_FRIEND_REQUESTED", "vi", { name: t("SYS_NAME_SOMEONE", "vi") })
    );
  });
});
