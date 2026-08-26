import {
  COPY_REF_KEY,
  DATA_REF_KEY,
  renderNotificationCopy,
  renderNotificationData,
  type SupportedLocale,
} from "@aimess/constants";

import type { PersonalizeFn } from "./emit-personalized.js";

/**
 * Render a `/notify` frame in each connected device's own language.
 *
 * A notification is written once and read on every device the user has open,
 * and those devices do not have to agree on a language. chat-service already
 * serializes the REST list in the reader's locale; this is the socket half, so
 * a phone set to Vietnamese and a laptop set to English show the same live
 * event in two languages instead of whichever one the writer happened to use.
 *
 * Reads the replay tickets the producer stored on the row (`data.copyRef` for
 * the title/body, `data.dataRef` for the friend card's resolution line) and
 * replays them. Anything without a ticket — a legacy row, or an admin-authored
 * announcement whose text is content rather than product copy — passes through
 * untouched, which is also what makes this safe to run over every frame type
 * (`notification:read`, `:deleted`, `:count_update` carry no tickets and are
 * returned as-is).
 *
 * Names are never touched: they are arguments to the builder, not part of it.
 *
 * Both the envelope `title`/`body` and the legacy nested `payload.title`/`body`
 * are written from the SAME render — see the note at the payload block below.
 */
export const localizeNotificationFrame: PersonalizeFn = (
  data: unknown,
  _userId: string,
  locale: SupportedLocale
): unknown => {
  if (!data || typeof data !== "object") return data;
  const frame = data as Record<string, unknown>;
  const frameData = frame.data as Record<string, unknown> | undefined;
  const ref = (key: string): string | undefined => {
    const value = frameData?.[key];
    return typeof value === "string" ? value : undefined;
  };

  const copy = renderNotificationCopy(ref(COPY_REF_KEY), locale);
  const extra = renderNotificationData(ref(DATA_REF_KEY), locale);
  if (!copy && !extra) return data;

  // The heading is replaced only when the serializer decided this row HAS one
  // and it is not a name. `inboxTitle` is a name (the caller, the community);
  // `null` means the serializer suppressed the heading because the body already
  // says everything — re-introducing one here would put a duplicate line back on
  // exactly the cards that were fixed by removing it.
  const hasInboxTitle =
    typeof frameData?.inboxTitle === "string" && frameData.inboxTitle !== "";
  const headingIsCopy =
    typeof frame.title === "string" && frame.title !== "" && !hasInboxTitle;

  // `payload` is the STORED row, rendered once at write time in the account's
  // language (`getUserLocale` in push.service.ts) — a single account-wide slot.
  // The envelope is rendered here, per socket. Two independent resolutions of
  // "what language is this person reading in" for ONE object is how a frame
  // ended up with a Vietnamese `title` above an English `payload.title`: the
  // account said English and the connection said Vietnamese, and both were
  // telling the truth about different things.
  //
  // The fix is not to pick a winner but to stop resolving twice: the same
  // `copy` is written into both, under the SAME `headingIsCopy` rule, so the
  // two halves cannot disagree — not about language, and not about whether the
  // heading is a name or a sentence. Only the prose is touched; `payload.data`
  // carries ids and codes and is passed through.
  const payload = frame.payload as Record<string, unknown> | undefined;
  const localizedPayload =
    copy && payload && typeof payload === "object"
      ? {
          payload: {
            ...payload,
            ...(copy.title && headingIsCopy && typeof payload.title === "string"
              ? { title: copy.title }
              : {}),
            ...(copy.body && typeof payload.body === "string"
              ? { body: copy.body }
              : {}),
          },
        }
      : {};

  return {
    ...frame,
    ...localizedPayload,
    ...(copy?.title && headingIsCopy ? { title: copy.title } : {}),
    ...(copy?.body ? { body: copy.body } : {}),
    ...(extra?.resolution ? { resolution: extra.resolution } : {}),
    ...(frameData
      ? {
          data: {
            ...frameData,
            ...(extra?.resolution ? { resolution: extra.resolution } : {}),
          },
        }
      : {}),
  };
};
