import { DEFAULT_LOCALE, t, type SupportedLocale } from "@aimess/constants";

interface AuthOtpEmailParams {
  code: string;
  ttlSeconds: number;
  /** Already-localized copy from the caller (see the per-flow templates). */
  title: string;
  intro: string;
  outro: string;
  /** Recipient's language; also becomes the document's `lang` attribute. */
  locale?: SupportedLocale;
}

interface AuthOtpEmail {
  subject: string;
  html: string;
}

export function authOtpEmail({
  code,
  ttlSeconds,
  title,
  intro,
  outro,
  locale = DEFAULT_LOCALE,
}: AuthOtpEmailParams): AuthOtpEmail {
  const expiryMinutes = Math.round(ttlSeconds / 60);
  const expiry = t(
    expiryMinutes === 1
      ? "NOTIF_EMAIL_OTP_EXPIRY_ONE"
      : "NOTIF_EMAIL_OTP_EXPIRY_OTHER",
    locale,
    { count: expiryMinutes }
  );

  const html = `<!DOCTYPE html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,Cantarell,sans-serif;color:#1f2937;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f4f6f8;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:480px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
            <tr>
              <td style="background-color:#4f46e5;padding:24px 32px;text-align:center;">
                <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:0.5px;">AIMess</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h2 style="margin:0 0 12px 0;font-size:20px;font-weight:600;color:#111827;">${title}</h2>
                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.5;color:#4b5563;">
                  ${intro} <strong>${expiry}</strong>
                </p>
                <div style="text-align:center;margin:24px 0;">
                  <div style="display:inline-block;padding:18px 28px;background-color:#f3f4f6;border-radius:10px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#111827;">
                    ${code}
                  </div>
                </div>
                <p style="margin:24px 0 0 0;font-size:13px;line-height:1.5;color:#6b7280;">
                  ${outro}
                </p>
              </td>
            </tr>
            <tr>
              <td style="background-color:#f9fafb;padding:16px 32px;text-align:center;font-size:12px;color:#9ca3af;">
                &copy; AIMess
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return {
    subject: title,
    html,
  };
}
