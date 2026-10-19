/** AIMESS-340: closed communities follow the same activity order and sink below open ones in search. */
import { rankCommunitiesByHandle } from "../../src/lib/community-search.util.js";
import { orderByWireActivity } from "../../src/services/community.service.js";

const row = (id: string, handle: string, status: "ACTIVE" | "CLOSED") => ({
  id,
  handle,
  status,
  moderationStatus: "ACTIVE",
});

describe("orderByWireActivity", () => {
  it("orders a page by the lastActivityAt the client sees, newest first", () => {
    const page = [
      { id: "limit5", lastActivityAt: 1792391303348 },
      { id: "limit4", lastActivityAt: 1792391324000 },
      { id: "limit3", lastActivityAt: 1792391346000 },
      { id: "limit2", lastActivityAt: 1792391367000 },
    ];
    expect(orderByWireActivity(page, "desc").map((c) => c.id)).toEqual([
      "limit2",
      "limit3",
      "limit4",
      "limit5",
    ]);
    expect(orderByWireActivity(page, "asc").map((c) => c.id)).toEqual([
      "limit5",
      "limit4",
      "limit3",
      "limit2",
    ]);
  });
});

describe("rankCommunitiesByHandle", () => {
  it("ranks open communities above closed name-only matches", () => {
    const rows = [
      row("qa5", "qa_limit_5", "CLOSED"),
      row("qa4", "qa_limit_4", "CLOSED"),
      row("web", "web_test_184", "ACTIVE"),
      row("android", "android_test", "ACTIVE"),
    ];
    expect(
      rankCommunitiesByHandle(rows as never[], "zz").map((c: { id: string }) => c.id)
    ).toEqual(["web", "android", "qa5", "qa4"]);
  });

  it("keeps handle relevance first: an exact closed handle still leads", () => {
    const rows = [row("open", "qa_open", "ACTIVE"), row("closed", "qa", "CLOSED")];
    expect(
      rankCommunitiesByHandle(rows as never[], "qa").map((c: { id: string }) => c.id)
    ).toEqual(["closed", "open"]);
  });
});
