import { authOtpEmail } from "./auth-otp.js";

interface AdminPasswordResetOtpEmailParams {
  code: string;
  ttlSeconds: number;
}

interface AdminPasswordResetOtpEmail {
  subject: string;
  html: string;
}

export function adminPasswordResetOtpEmail({
  code,
  ttlSeconds,
}: AdminPasswordResetOtpEmailParams): AdminPasswordResetOtpEmail {
  return authOtpEmail({
    code,
    ttlSeconds,
    title: "Your AIMess admin password reset code",
    intro:
      "Use the verification code below to reset your AIMess admin account password.",
    outro:
      "If you did not request this, ignore this email and consider notifying your security team.",
  });
}
