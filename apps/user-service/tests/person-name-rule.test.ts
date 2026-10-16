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
  ["می‌خواهم", "می‌خواهم", null],
  ["‌Raj‌", "Raj", null],
  ["Nguyễn", "Nguyễn", null],
  ["﻿‌‍", "", "INVALID"],
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
  // AIMESS-273: real scripts keep their marks; stacked marks (Zalgo) are rejected.
  ["ખિલન વિઠ્ઠાણી", "ખિલન વિઠ્ઠાણી", null],
  ["हर्षिल क्षत्रिय", "हर्षिल क्षत्रिय", null],
  ["สมศักดิ์", "สมศักดิ์", null],
  ["Nguyễn Thị Phượng", "Nguyễn Thị Phượng", null],
  ["Nguyễn", "Nguyễn", null],
  ["ખ" + "િ".repeat(20) + "લન", "ખિિિલન", "INVALID"],
  ["T̍̎̏̐̑̒̓̔͐͑", "T̍̎̏", "INVALID"],
  ["a̶̶​̶̶", "a̶̶̶", "INVALID"],
];

describe("validatePersonName", () => {
  it.each(cases)("%j -> %j (%s)", (input, value, error) => {
    expect(validatePersonName(input)).toEqual({ value, error });
  });
});
