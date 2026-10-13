import {
  accountBannedMessage,
  accountSuspendedMessage,
  DEFAULT_LOCALE,
  t,
  type SupportedLocale,
} from "@aimess/constants";

interface AccountRestrictedEmailParams {
  banned: boolean;
  reason: string;
  until: number | null;
  locale?: SupportedLocale;
  timeZone?: string;
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string
  );

/** Same sentence the sign-in screen shows (403 ACCOUNT_BANNED / ACCOUNT_SUSPENDED). */
export function accountRestrictedEmail({
  banned,
  reason,
  until,
  locale = DEFAULT_LOCALE,
  timeZone = "UTC",
}: AccountRestrictedEmailParams): { subject: string; html: string } {
  const subject = t(
    banned ? "NOTIF_ACCOUNT_BANNED_TITLE" : "NOTIF_ACCOUNT_SUSPENDED_TITLE",
    locale
  );
  const body = banned
    ? accountBannedMessage(reason, locale)
    : accountSuspendedMessage(until, reason, locale, timeZone);

  const html = `<!DOCTYPE html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:32px 12px;background-color:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2937;">
    <div style="max-width:480px;margin:0 auto;background-color:#ffffff;border-radius:12px;overflow:hidden;">
      <div style="background-color:#4f46e5;padding:24px 32px;text-align:center;">
        <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">AIMess</h1>
      </div>
      <div style="padding:32px;">
        <h2 style="margin:0 0 12px 0;font-size:20px;font-weight:600;color:#111827;">${escapeHtml(subject)}</h2>
        <p style="margin:0;font-size:15px;line-height:1.5;color:#4b5563;">${escapeHtml(body)}</p>
      </div>
    </div>
  </body>
</html>`;

  return { subject, html };
}
