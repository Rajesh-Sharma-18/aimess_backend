import type { PlaceholderModel } from "../models/index.js";
import { ExampleRepository } from "../repositories/example.repository.js";

/** Application / domain logic. */
export class ExampleService {
  constructor(private readonly repo = new ExampleRepository()) {}

  async getOne(id: string): Promise<PlaceholderModel | null> {
    return this.repo.findById(id);
  }
}
