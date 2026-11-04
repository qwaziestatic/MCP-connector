import { describe, expect, it } from "vitest";
import { parseNotionDatabaseId } from "./notion-database-id.js";

const id = "1a2b3c4d5e6f40718293a4b5c6d7e8f9";

describe("parseNotionDatabaseId", () => {
  it.each([
    [id],
    [id.toUpperCase()],
    ["1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9"],
    [`  ${id}  `],
    [`https://www.notion.so/my-team/Weekly-plans-${id}?v=0f9e8d7c6b5a49382716a5b4c3d2e1f0`],
    [`https://www.notion.so/${id}`],
    [`https://notion.so/Tasks-${id}`],
    [`https://my-team.notion.site/Roadmap-${id}?pvs=4`],
    ["https://www.notion.so/my-team/1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9"]
  ])("reads %s", (input) => {
    expect(parseNotionDatabaseId(input)).toBe(id);
  });

  it("ignores the view ID in the link", () => {
    expect(parseNotionDatabaseId(`https://www.notion.so/Tasks-${id}?v=ffffffffffffffffffffffffffffffff`)).toBe(id);
  });

  it.each([
    ["", "Paste the database's link or ID"],
    ["my database", "not a Notion database link or ID"],
    [`https://example.com/Tasks-${id}`, "not a Notion link"],
    [`http://www.notion.so/Tasks-${id}`, "not a Notion link"],
    ["https://www.notion.so/my-team/Tasks", "no database ID"],
    ["1a2b3c4d5e6f", "not a Notion database link or ID"]
  ])("explains %j", (input, message) => {
    expect(() => parseNotionDatabaseId(input)).toThrow(message);
  });
});
