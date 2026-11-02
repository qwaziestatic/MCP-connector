import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = (path) => join(root, path);

for (const path of ["out/main/main.js", "out/preload/preload.js", "out/renderer/index.html"]) {
  await access(file(path), constants.F_OK);
}

const main = await readFile(file("out/main/main.js"), "utf8");
if (!main.includes("../preload/preload.js")) {
  throw new Error("Built main process does not reference the built preload entrypoint.");
}

const renderer = await readFile(file("out/renderer/index.html"), "utf8");
if (!renderer.includes('http-equiv="Content-Security-Policy"')) {
  throw new Error("Production renderer is missing its Content-Security-Policy meta tag.");
}
