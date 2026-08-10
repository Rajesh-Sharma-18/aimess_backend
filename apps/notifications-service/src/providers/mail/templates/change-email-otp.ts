import { DEFAULT_LOCALE, t, type SupportedLocale } from "@aimess/constants";

import { authOtpEmail } from "./auth-otp.js";

interface ChangeEmailOtpEmailParams {
  code: string;
  ttlSeconds: number;
  locale?: SupportedLocale;
}

interface ChangeEmailOtpEmail {
  subject: string;
  html: string;
}

export function changeEmailOtpEmail({
  code,
  ttlSeconds,
  locale = DEFAULT_LOCALE,
}: ChangeEmailOtpEmailParams): ChangeEmailOtpEmail {
  return authOtpEmail({
    code,
    ttlSeconds,
    locale,
    title: t("NOTIF_EMAIL_CHANGE_EMAIL_SUBJECT", locale),
    intro: t("NOTIF_EMAIL_CHANGE_EMAIL_INTRO", locale),
    outro: t("NOTIF_EMAIL_CHANGE_EMAIL_OUTRO", locale),
  });
}
