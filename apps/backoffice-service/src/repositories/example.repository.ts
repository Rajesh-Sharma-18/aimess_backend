import type { PlaceholderModel } from "../models/index.js";

/** Data access — DB, external APIs, caches, etc. */
export class ExampleRepository {
  async findById(_id: string): Promise<PlaceholderModel | null> {
    return null;
  }
}
