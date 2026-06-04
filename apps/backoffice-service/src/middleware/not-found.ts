import type { RequestHandler } from "express";

/** Terminal 404 — any unmatched route returns a JSON envelope (never HTML). */
export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ success: false, message: "Not found" });
};
