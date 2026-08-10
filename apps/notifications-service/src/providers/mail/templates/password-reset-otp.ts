import { DEFAULT_LOCALE, t, type SupportedLocale } from "@aimess/constants";

import { authOtpEmail } from "./auth-otp.js";

interface PasswordResetOtpEmailParams {
  code: string;
  ttlSeconds: number;
  locale?: SupportedLocale;
}

interface PasswordResetOtpEmail {
  subject: string;
  html: string;
}

export function passwordResetOtpEmail({
  code,
  ttlSeconds,
  locale = DEFAULT_LOCALE,
}: PasswordResetOtpEmailParams): PasswordResetOtpEmail {
  return authOtpEmail({
    code,
    ttlSeconds,
    locale,
    title: t("NOTIF_EMAIL_PASSWORD_RESET_SUBJECT", locale),
    intro: t("NOTIF_EMAIL_PASSWORD_RESET_INTRO", locale),
    outro: t("NOTIF_EMAIL_PASSWORD_RESET_OUTRO", locale),
  });
}
