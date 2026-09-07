import { renderMessageKey, t } from "@aimess/constants";
import type { Request, RequestHandler, Response } from "express";

import { zodErrorMessage, zodFieldErrors } from "./format-zod-error.js";
import { sendApiError } from "./send-api-error.js";

/**
 * Minimal structural shape of a Zod schema — avoids coupling this shared
 * package to a specific `zod` version, exactly as `format-zod-error` does.
 */
interface ZodLikeSchema {
  safeParse(value: unknown):
    | { success: true; data: unknown }
    | {
        success: false;
        error: {
          issues: ReadonlyArray<{
            path: ReadonlyArray<PropertyKey>;
            message: string;
          }>;
        };
      };
}

/**
 * Eighteen near-identical copies of these three factories existed across six
 * services, and they had drifted: only user-service emitted field-level errors,
 * only some emitted a `code`, and chat-service's `validateQuery` discarded the
 * coerced result so schema defaults never reached the controller. This is that
 * logic, once.
 */
type ZodIssues = ReadonlyArray<{
  path: ReadonlyArray<PropertyKey>;
  message: string;
}>;

/**
 * Translate any issue message that is actually a MESSAGE KEY.
 *
 * The contract below is that a Zod issue message is already the user-facing
 * sentence, and almost every schema honours it ("Password must be at least 8
 * characters"). The password policy cannot: `checkPasswordPolicy` returns a
 * key — AUTH_PASSWORD_TOO_SHORT, AUTH_PASSWORD_CONTAINS_IDENTIFIER — because
 * the same failure is also thrown from services that DO translate it. Without
 * this step that key reached the client verbatim, and a user setting a password
 * was shown `AUTH_PASSWORD_CONTAINS_IDENTIFIER` instead of the en/vi/th
 * sentence that has existed in the catalogue all along.
 *
 * `renderMessageKey` answers null for anything that is not a known key, so a
 * hand-written sentence passes through untouched — which matters because this
 * runs for every validated request in every service, not just the auth ones.
 */
function localizeIssues(issues: ZodIssues, req: Request): ZodIssues {
  return issues.map((issue) => {
    const localized = renderMessageKey(issue.message, req.locale);
    return localized === null ? issue : { ...issue, message: localized };
  });
}

function respondInvalid(
  req: Request,
  res: Response,
  error: {
    issues: ZodIssues;
  }
): void {
  // Localized once, then shared by both formatters, so the joined `message` and
  // the per-field `details` can never disagree about the wording.
  const issues = localizeIssues(error.issues, req);
  const localized = { issues };

  sendApiError(req, res, {
    statusCode: 400,
    code: "VALIDATION_FAILED",
    // The merged Zod sentences ARE the user-facing message — they are written
    // per-field in the schemas ("Password must be at least 8 characters") and
    // are far more useful than a generic "Validation failed".
    fallbackMessage:
      zodErrorMessage(localized) || t("VALIDATION_FAILED", req.locale),
    // Lets a form mark the offending input instead of showing one joined line.
    details: zodFieldErrors(localized),
  });
}

/** Validates `req.body`, replacing it with the parsed (and coerced) value. */
export function validateBody(schema: ZodLikeSchema): RequestHandler {
  return (req, res, next) => {
    // Express 5 leaves `req.body` undefined when the request carries no body at
    // all (Express 4 defaulted it to `{}`). Endpoints whose schema is entirely
    // optional must still accept a body-less POST, so normalize here instead of
    // teaching every such schema to accept undefined. Schemas with required
    // fields still reject `{}` with the same 400.
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      respondInvalid(req, res, parsed.error);
      return;
    }
    req.body = parsed.data;
    next();
  };
}

/** Validates `req.params`, merging the parsed (and coerced) value back in. */
export function validateParams(schema: ZodLikeSchema): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) {
      respondInvalid(req, res, parsed.error);
      return;
    }
    Object.assign(req.params, parsed.data);
    next();
  };
}

/** Validates `req.query`, merging the parsed (and coerced) value back in. */
export function validateQuery(schema: ZodLikeSchema): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      respondInvalid(req, res, parsed.error);
      return;
    }
    // Express 5 re-parses `req.query` on every access, so mutating it in place
    // is lost — coerced and defaulted values never reach the controller.
    // Merged rather than replaced: replacing drops any key the schema does not
    // declare, and chat-service's controllers have always read raw query keys
    // that their schemas never listed.
    Object.defineProperty(req, "query", {
      value: { ...req.query, ...(parsed.data as object) },
      writable: true,
      configurable: true,
      enumerable: true,
    });
    next();
  };
}
