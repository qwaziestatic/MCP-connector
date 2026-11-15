// Zips the built Chrome extension for the Chrome Web Store or for sharing:
//   npm run package:chrome
// Builds apps/chrome-extension first, then writes
// release/mcp-connector-chrome-<version>.zip with manifest.json at its root.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles, zip } from "./zip.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "apps", "chrome-extension", "dist");

if (!(await stat(join(dist, "manifest.json")).catch(() => null))?.isFile()) {
  throw new Error(`No manifest.json in ${dist}. Run "npm run build --workspace=apps/chrome-extension" first.`);
}
const { version } = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
const output = join(root, "release", `mcp-connector-chrome-${version}.zip`);

const entries = [];
for (const file of await listFiles(dist)) {
  entries.push({ name: relative(dist, file).split(sep).join("/"), data: await readFile(file) });
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, zip(entries));
console.log(`Wrote ${relative(root, output)} with ${entries.length} files:`);
for (const { name } of entries) console.log(`  ${name}`);
