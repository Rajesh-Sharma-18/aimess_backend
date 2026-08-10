import { DEFAULT_LOCALE, t, type SupportedLocale } from "@aimess/constants";

import { authOtpEmail } from "./auth-otp.js";

interface LinkEmailOtpEmailParams {
  code: string;
  ttlSeconds: number;
  locale?: SupportedLocale;
}

interface LinkEmailOtpEmail {
  subject: string;
  html: string;
}

export function linkEmailOtpEmail({
  code,
  ttlSeconds,
  locale = DEFAULT_LOCALE,
}: LinkEmailOtpEmailParams): LinkEmailOtpEmail {
  return authOtpEmail({
    code,
    ttlSeconds,
    locale,
    title: t("NOTIF_EMAIL_LINK_EMAIL_SUBJECT", locale),
    intro: t("NOTIF_EMAIL_LINK_EMAIL_INTRO", locale),
    outro: t("NOTIF_EMAIL_LINK_EMAIL_OUTRO", locale),
  });
}
