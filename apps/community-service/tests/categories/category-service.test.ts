/**
 * Suite: category-service
 *
 * Service-level coverage for communityService's admin category CRUD, with
 * `communityRepository` mocked at the module boundary. Focuses on the
 * business rules that don't have HTTP-layer coverage in
 * tests/categories/admin-categories.test.ts (which mocks the service
 * itself): case-insensitive uniqueness on create/update, not-found handling,
 * and — most importantly — the delete branch: soft-delete
 * (`deletedAt`, mirrors `Community.deletedAt`) when the category is still
 * referenced by communities, hard-delete otherwise.
 */

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findCategoryByName: jest.fn(),
    createCategory: jest.fn(),
    findCategoryByIdAdmin: jest.fn(),
    updateCategoryById: jest.fn(),
    deleteCategoryById: jest.fn(),
    softDeleteCategoryById: jest.fn(),
    countCommunitiesWithCategory: jest.fn(),
    countActiveCommunitiesWithCategory: jest.fn(),
    listCategoriesAdmin: jest.fn(),
  },
}));

import { ConflictError, NotFoundError } from "@aimess/errors";

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;

const CAT = "a".repeat(24);
const row = (over: Record<string, unknown> = {}) => ({
  id: CAT,
  name: "Technology",
  slug: "technology",
  active: true,
  order: 0,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  repo.countActiveCommunitiesWithCategory.mockResolvedValue(0);
});

describe("communityService.createCategory", () => {
  it("creates when the name is free", async () => {
    repo.findCategoryByName.mockResolvedValue(null);
    repo.createCategory.mockResolvedValue(row());

    const result = await communityService.createCategory({
      name: "Technology",
    });

    expect(result.id).toBe(CAT);
    expect(repo.createCategory).toHaveBeenCalledWith({
      name: "Technology",
      slug: "technology",
    });
  });

  it("throws ConflictError on a case-insensitive duplicate name", async () => {
    repo.findCategoryByName.mockResolvedValue({ id: "other-id" });

    await expect(
      communityService.createCategory({ name: "technology" })
    ).rejects.toThrow(ConflictError);
    expect(repo.createCategory).not.toHaveBeenCalled();
  });
});

describe("communityService.updateCategory", () => {
  it("throws NotFoundError for an unknown id", async () => {
    repo.findCategoryByIdAdmin.mockResolvedValue(null);

    await expect(
      communityService.updateCategory(CAT, { name: "Renamed" })
    ).rejects.toThrow(NotFoundError);
  });

  it("throws ConflictError when the new name collides with another category", async () => {
    repo.findCategoryByIdAdmin.mockResolvedValue(row());
    repo.findCategoryByName.mockResolvedValue({ id: "other-id" });

    await expect(
      communityService.updateCategory(CAT, { name: "Dup" })
    ).rejects.toThrow(ConflictError);
    expect(repo.updateCategoryById).not.toHaveBeenCalled();
  });

  it("updates visibility without touching the name/slug", async () => {
    repo.findCategoryByIdAdmin.mockResolvedValue(row());
    repo.updateCategoryById.mockResolvedValue(row({ active: false }));
    repo.countActiveCommunitiesWithCategory.mockResolvedValue(2);

    const result = await communityService.updateCategory(CAT, {
      visible: false,
    });

    expect(repo.findCategoryByName).not.toHaveBeenCalled();
    expect(repo.updateCategoryById).toHaveBeenCalledWith(CAT, {
      active: false,
    });
    expect(result.visible).toBe(false);
    expect(result.communityCount).toBe(2);
  });
});

describe("communityService.deleteCategory", () => {
  it("throws NotFoundError for an unknown id", async () => {
    repo.findCategoryByIdAdmin.mockResolvedValue(null);

    await expect(communityService.deleteCategory(CAT)).rejects.toThrow(
      NotFoundError
    );
    expect(repo.countCommunitiesWithCategory).not.toHaveBeenCalled();
  });

  it("hard-deletes when no community references the category", async () => {
    repo.findCategoryByIdAdmin.mockResolvedValue(row());
    repo.countCommunitiesWithCategory.mockResolvedValue(0);
    repo.deleteCategoryById.mockResolvedValue(row());

    const result = await communityService.deleteCategory(CAT);

    expect(result).toEqual({ softDeleted: false });
    expect(repo.deleteCategoryById).toHaveBeenCalledWith(CAT);
    expect(repo.softDeleteCategoryById).not.toHaveBeenCalled();
  });

  it("soft-deletes (deletedAt) when the category is still referenced by CLOSED/DELETED communities only", async () => {
    repo.findCategoryByIdAdmin.mockResolvedValue(row());
    repo.countActiveCommunitiesWithCategory.mockResolvedValue(0);
    repo.countCommunitiesWithCategory.mockResolvedValue(3);
    repo.softDeleteCategoryById.mockResolvedValue(row({ active: false }));

    const result = await communityService.deleteCategory(CAT);

    expect(result).toEqual({ softDeleted: true });
    expect(repo.softDeleteCategoryById).toHaveBeenCalledWith(CAT);
    expect(repo.deleteCategoryById).not.toHaveBeenCalled();
  });

  it("throws ConflictError (blocked) when an ACTIVE community still uses the category", async () => {
    repo.findCategoryByIdAdmin.mockResolvedValue(row());
    repo.countActiveCommunitiesWithCategory.mockResolvedValue(1);

    await expect(communityService.deleteCategory(CAT)).rejects.toThrow(
      ConflictError
    );
    expect(repo.countCommunitiesWithCategory).not.toHaveBeenCalled();
    expect(repo.softDeleteCategoryById).not.toHaveBeenCalled();
    expect(repo.deleteCategoryById).not.toHaveBeenCalled();
  });
});
