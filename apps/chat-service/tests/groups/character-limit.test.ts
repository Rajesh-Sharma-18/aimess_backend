import { TEXT_NAME_MAX_LENGTH } from "@aimess/constants";

import {
  createGroupSchema,
  updateGroupSchema,
} from "../../src/api/validators/group-room.validator.js";

/**
 * The 30-character rule for a group's name, at the schemas POST /groups and
 * PATCH /groups/:id mount — create and edit asserted together, because they are
 * the pair that drifts.
 */
const MAX = TEXT_NAME_MAX_LENGTH;
const chars = (n: number, unit = "a") => unit.repeat(n);

const create = (name: string) => createGroupSchema.safeParse({ name });
const update = (name: string) => updateGroupSchema.safeParse({ name });

it.each([1, 29, MAX])("accepts %i characters on create and on rename", (n) => {
  expect(create(chars(n)).success).toBe(true);
  expect(update(chars(n)).success).toBe(true);
});

it.each([MAX + 1, 50, 100])("rejects %i characters on create and on rename", (n) => {
  const created = create(chars(n));
  expect(created.success).toBe(false);
  expect(created.error?.issues[0]?.message).toBe(
    "VALIDATION_GROUP_NAME_MAX_LENGTH"
  );
  expect(update(chars(n)).success).toBe(false);
});

it("counts characters, not code units", () => {
  expect(create(chars(MAX, "กิ")).success).toBe(true);
  expect(create(chars(MAX, "ễ")).success).toBe(true);
  expect(create(chars(MAX, "😀")).success).toBe(true);
  expect(create(chars(MAX + 1, "😀")).success).toBe(false);
});

it("measures the TRIMMED value and still requires one", () => {
  expect(create(`  ${chars(MAX)}  `).success).toBe(true);
  expect(create(`  ${chars(MAX + 1)}  `).success).toBe(false);
  expect(create("").success).toBe(false);
  expect(create("   ").success).toBe(false);
});

it("leaves the other group fields alone", () => {
  const parsed = createGroupSchema.safeParse({
    name: "Team",
    description: "d".repeat(1000),
  });
  expect(parsed.success).toBe(true);
  expect(parsed.data?.memberLimit).toBe(256);
});
