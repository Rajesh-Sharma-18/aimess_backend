import { authOtpEmail } from "./auth-otp.js";

interface LinkEmailOtpEmailParams {
  code: string;
  ttlSeconds: number;
}

interface LinkEmailOtpEmail {
  subject: string;
  html: string;
}

export function linkEmailOtpEmail({
  code,
  ttlSeconds,
}: LinkEmailOtpEmailParams): LinkEmailOtpEmail {
  return authOtpEmail({
    code,
    ttlSeconds,
    title: "Your AIMess email verification code",
    intro:
      "Use the verification code below to link and verify this email on your AIMess account.",
    outro:
      "If you did not request this, you can safely ignore this email and your account will remain unchanged.",
  });
}
