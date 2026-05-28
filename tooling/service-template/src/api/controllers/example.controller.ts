import type { RequestHandler } from "express";

import type { ApiSuccess } from "../../types/index.js";
import { ExampleService } from "../../services/example.service.js";

const exampleService = new ExampleService();

export const getExampleById: RequestHandler = async (req, res, next) => {
  try {
    const row = await exampleService.getOne(req.params.id as string);
    const body: ApiSuccess<typeof row> = { success: true, data: row };
    res.json(body);
  } catch (err) {
    next(err);
  }
};
