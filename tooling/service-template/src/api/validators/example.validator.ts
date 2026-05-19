import { z } from "zod";

export const exampleIdParamsSchema = z.object({
  id: z.string().min(1),
});

export type ExampleIdParams = z.infer<typeof exampleIdParamsSchema>;
