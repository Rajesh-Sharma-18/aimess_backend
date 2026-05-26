import { authOtpEmail } from "./auth-otp.js";

interface PasswordResetOtpEmailParams {
  code: string;
  ttlSeconds: number;
}

interface PasswordResetOtpEmail {
  subject: string;
  html: string;
}

export function passwordResetOtpEmail({
  code,
  ttlSeconds,
}: PasswordResetOtpEmailParams): PasswordResetOtpEmail {
  return authOtpEmail({
    code,
    ttlSeconds,
    title: "Your AIMess password reset code",
    intro: "Use the verification code below to reset your AIMess password.",
    outro:
      "If you did not request this, you can safely ignore this email; your password will not be changed.",
  });
}
