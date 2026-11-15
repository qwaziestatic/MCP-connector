// Zips skills/mcp-connector for upload to a skill marketplace such as Agensi:
//   npm run package:skill
// Writes release/mcp-connector-skill.zip with the skill folder at its root, after
// checking the SKILL.md frontmatter. zip.mjs uses only Node's own zlib, so it
// needs no dependencies and works the same on Windows, macOS and Linux.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles, zip } from "./zip.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillName = "mcp-connector";
const skillDirectory = join(root, "skills", skillName);
const output = join(root, "release", `${skillName}-skill.zip`);

function checkFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (match === null) throw new Error("SKILL.md must start with YAML frontmatter between --- lines.");
  const fields = Object.fromEntries(match[1].split(/\r?\n/).map((line) => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
  }));
  if (fields.name !== skillName) throw new Error(`The frontmatter name must be "${skillName}", the folder's name.`);
  if (!/^[a-z0-9-]{1,64}$/.test(fields.name)) throw new Error("The name may use only lowercase letters, numbers and hyphens.");
  if (!fields.description || fields.description.length > 1024) {
    throw new Error("The description is required and must be at most 1024 characters.");
  }
}

if (!(await stat(join(skillDirectory, "SKILL.md")).catch(() => null))?.isFile()) {
  throw new Error(`No SKILL.md in ${skillDirectory}.`);
}
checkFrontmatter(await readFile(join(skillDirectory, "SKILL.md"), "utf8"));
const entries = [];
for (const file of await listFiles(skillDirectory)) {
  const name = [skillName, ...relative(skillDirectory, file).split(sep)].join("/");
  entries.push({ name, data: await readFile(file) });
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, zip(entries));
console.log(`Wrote ${relative(root, output)} with ${entries.length} files:`);
for (const { name } of entries) console.log(`  ${name}`);
