// Builds the extension into dist/, the folder Chrome loads:
//   npm run build --workspace=apps/chrome-extension
// Each script is bundled into one readable file, not minified, so the folder
// can be read before it is loaded. Nothing is fetched at run time.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: {
    background: "src/background.ts",
    content: "src/content.ts",
    panel: "src/panel.ts",
    options: "src/options.ts"
  },
  outdir: dist,
  bundle: true,
  // Content scripts and the service worker are classic scripts.
  format: "iife",
  target: "chrome116",
  legalComments: "none",
  logLevel: "warning"
});

await cp(join(root, "static"), dist, { recursive: true });
await cp(join(root, "..", "..", "LICENSE"), join(dist, "LICENSE"));

// The version is kept in package.json only.
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifestPath = join(dist, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
await writeFile(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);

console.log(`Built the Chrome extension ${version} in apps/chrome-extension/dist`);
