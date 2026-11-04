// Reads a Notion database ID from what users usually have at hand: the link
// Notion's "Copy link" gives, or the ID itself, with or without dashes.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAIN_IN_PATH = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;
const DASHED_IN_PATH = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;

const HOW_TO = "In Notion, open the database as a full page, click ••• and choose Copy link, then paste it here.";

/** Returns the 32-character ID, lowercase and without dashes. */
export function parseNotionDatabaseId(input: string): string {
  const text = input.trim();
  if (text.length === 0) throw new Error(`Paste the database's link or ID. ${HOW_TO}`);
  if (UUID.test(text)) return text.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/i.test(text)) return text.toLowerCase();

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`That is not a Notion database link or ID. ${HOW_TO}`);
  }
  const host = url.hostname.toLowerCase();
  const isNotion = host === "notion.so" || host.endsWith(".notion.so") || host.endsWith(".notion.site");
  if (url.protocol !== "https:" || !isNotion) {
    throw new Error(`That link is not a Notion link. ${HOW_TO}`);
  }
  // The database ID ends the path, after the title: /Tasks-<id>. The "?v="
  // part names a view of the database, so it is ignored.
  const id = url.pathname.match(PLAIN_IN_PATH)?.at(-1)
    ?? url.pathname.match(DASHED_IN_PATH)?.at(-1)?.replace(/-/g, "");
  if (id === undefined) throw new Error(`That Notion link has no database ID in it. ${HOW_TO}`);
  return id.toLowerCase();
}
