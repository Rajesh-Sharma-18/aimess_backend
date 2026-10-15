/** AIMESS-258: one first/last name rule — the case table every client mirrors. */
import { validatePersonName } from "@aimess/constants";

const cases: Array<[string, string, string | null]> = [
  ["Rajesh", "Rajesh", null],
  ["Mary Jane", "Mary Jane", null],
  ["José García", "José García", null],
  ["O'Connor", "O'Connor", null],
  ["Jean-Pierre", "Jean-Pierre", null],
  ["Raj 😊", "Raj 😊", null],
  ["محمد", "محمد", null],
  ["李", "李", null],
  ["👩‍💻 Dev", "👩‍💻 Dev", null],
  ["  Mary   Jane  ", "Mary Jane", null],
  ["Ra​j", "Raj", null],
  ["", "", "REQUIRED"],
  ["    ", "", "REQUIRED"],
  ["​​", "", "INVALID"],
  ["ㅤ", "", "INVALID"],
  ["‍﻿⁠‎", "", "INVALID"],
  [" ​ ㅤ ", "", "INVALID"],
  ["a".repeat(30), "a".repeat(30), null],
  ["a".repeat(31), "a".repeat(31), "MAX_LENGTH"],
  ["😊".repeat(30), "😊".repeat(30), null],
];

describe("validatePersonName", () => {
  it.each(cases)("%j -> %j (%s)", (input, value, error) => {
    expect(validatePersonName(input)).toEqual({ value, error });
  });
});
