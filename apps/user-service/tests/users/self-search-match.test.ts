/** AIMESS-215 — which queries surface the viewer's own "Message yourself" row. */
import { matchesSelf } from "../../src/services/user-search.service.js";
import { normalizeForSearch } from "../../src/lib/user-search.util.js";

const me = { username: "smiley_creatures", firstName: "Smiley", lastName: "Creatures" };
const hit = (q: string) => matchesSelf(me, normalizeForSearch(q));

describe("matchesSelf", () => {
  it.each(["You", "you", "yo", "yourself", "Message yourself", "message", "Smiley", "creat", "Smiley Creatures", "@smiley_creatures", "smileycre"])(
    "finds the self row for %s",
    (q) => expect(hit(q)).toBe(true)
  );

  it.each(["Kristi", "xyz", "yourselves", ""])("ignores %s", (q) =>
    expect(hit(q)).toBe(false)
  );
});
