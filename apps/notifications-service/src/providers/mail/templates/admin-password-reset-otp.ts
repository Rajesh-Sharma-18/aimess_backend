import { DEFAULT_LOCALE, t, type SupportedLocale } from "@aimess/constants";

import { authOtpEmail } from "./auth-otp.js";

interface AdminPasswordResetOtpEmailParams {
  code: string;
  ttlSeconds: number;
  locale?: SupportedLocale;
}

interface AdminPasswordResetOtpEmail {
  subject: string;
  html: string;
}

export function adminPasswordResetOtpEmail({
  code,
  ttlSeconds,
  locale = DEFAULT_LOCALE,
}: AdminPasswordResetOtpEmailParams): AdminPasswordResetOtpEmail {
  return authOtpEmail({
    code,
    ttlSeconds,
    locale,
    title: t("NOTIF_EMAIL_ADMIN_PASSWORD_RESET_SUBJECT", locale),
    intro: t("NOTIF_EMAIL_ADMIN_PASSWORD_RESET_INTRO", locale),
    outro: t("NOTIF_EMAIL_PASSWORD_RESET_OUTRO", locale),
  });
}
