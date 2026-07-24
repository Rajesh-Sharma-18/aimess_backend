import { z } from "zod";

/** Query schema for GET /v1/dashboard/charts (active-vs-churned + donut). */
export const dashboardChartsQuerySchema = z.object({
  // Controls the active-vs-churned chart granularity.
  period: z.enum(["daily", "weekly", "monthly"]).default("monthly"),
  // Optional ISO bounds (accepted for forward-compat; v1 serves a single
  // current bucket and does not yet range over from/to).
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export type DashboardChartsQueryInput = z.infer<
  typeof dashboardChartsQuerySchema
>;

/**
 * Query schema for GET /v1/dashboard/calls. Inclusive YYYY-MM-DD bounds; both
 * optional, and omitting them reports over all time.
 */
export const callAnalyticsQuerySchema = z.object({
  fromDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "fromDate must be YYYY-MM-DD")
    .optional(),
  toDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "toDate must be YYYY-MM-DD")
    .optional(),
});

export type CallAnalyticsQueryInput = z.infer<typeof callAnalyticsQuerySchema>;
