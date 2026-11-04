// Zips skills/mcp-connector for upload to a skill marketplace such as Agensi:
//   npm run package:skill
// Writes release/mcp-connector-skill.zip with the skill folder at its root, after
// checking the SKILL.md frontmatter. Uses only Node's own zlib, so it needs no
// dependencies and works the same on Windows, macOS and Linux.
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillName = "mcp-connector";
const skillDirectory = join(root, "skills", skillName);
const output = join(root, "release", `${skillName}-skill.zip`);

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

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

// A ZIP file, as described in PKWARE's APPNOTE: a local header and data for
// each file, then the central directory, then its end record.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const time = 0; // 00:00:00
  const date = (2026 - 1980) << 9 | 1 << 5 | 1; // 1 January 2026, so builds are reproducible
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
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
