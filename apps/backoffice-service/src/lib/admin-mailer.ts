import { logger } from "@aimess/logger";
import nodemailer from "nodemailer";

import { env } from "../config/env.js";

export const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_PORT === 465,
  // Omit auth for local/no-auth relays (e.g. MailHog) so the connection works
  // without credentials; supply auth only when a SMTP user is configured.
  ...(env.SMTP_USER
    ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }
    : {}),
});

function otpHtml(code: string, ttlSeconds: number): string {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  return `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background-color:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2937;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f4f6f8;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:480px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
            <tr>
              <td style="background-color:#4f46e5;padding:24px 32px;text-align:center;">
                <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:0.5px;">AIMess Admin</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h2 style="margin:0 0 12px 0;font-size:20px;font-weight:600;color:#111827;">Your admin password reset code</h2>
                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.5;color:#4b5563;">
                  Use the verification code below to reset your AIMess admin account password. This code expires in
                  <strong>${minutes} minute${minutes === 1 ? "" : "s"}</strong>.
                </p>
                <div style="text-align:center;margin:24px 0;">
                  <div style="display:inline-block;padding:18px 28px;background-color:#f3f4f6;border-radius:10px;font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#111827;">
                    ${code}
                  </div>
                </div>
                <p style="margin:24px 0 0 0;font-size:13px;line-height:1.5;color:#6b7280;">
                  If you did not request this, ignore this email and consider notifying your security team.
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
}

/** Send the admin password-reset OTP directly via SMTP. */
export async function sendAdminPasswordResetOtpEmail(
  to: string,
  code: string,
  ttlSeconds: number
): Promise<void> {
  const info = await transporter.sendMail({
    from: env.SMTP_FROM,
    to,
    subject: "Your AIMess admin password reset code",
    html: otpHtml(code, ttlSeconds),
  });
  logger.info(`Admin password-reset OTP emailed to ${to}: ${info.messageId}`);
}

/** Fire-and-forget: never fail the request if SMTP is down. */
export function sendAdminPasswordResetOtpEmailSafe(
  to: string,
  code: string,
  ttlSeconds: number
): void {
  void sendAdminPasswordResetOtpEmail(to, code, ttlSeconds).catch((error) => {
    logger.error("Failed to email admin password-reset OTP");
    logger.error(error);
  });
}
