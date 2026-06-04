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
