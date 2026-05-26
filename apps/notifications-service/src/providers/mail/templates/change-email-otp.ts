import { authOtpEmail } from "./auth-otp.js";

interface ChangeEmailOtpEmailParams {
  code: string;
  ttlSeconds: number;
}

interface ChangeEmailOtpEmail {
  subject: string;
  html: string;
}

export function changeEmailOtpEmail({
  code,
  ttlSeconds,
}: ChangeEmailOtpEmailParams): ChangeEmailOtpEmail {
  return authOtpEmail({
    code,
    ttlSeconds,
    title: "Your AIMess new-email verification code",
    intro:
      "Use the verification code below to confirm changing your AIMess account email to this address.",
    outro:
      "If you did not request this email change, you can ignore this message and your current email will stay unchanged.",
  });
}
