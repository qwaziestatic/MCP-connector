// Builds the extension into dist/, the folder Chrome loads:
//   npm run build --workspace=apps/chrome-extension
// Each script is bundled into one readable file, not minified, so the folder
// can be read before it is loaded. Nothing is fetched at run time.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { builtManifest } from "./manifest-version.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// --outdir=<folder> builds somewhere else; the tests use it to leave dist/ alone.
const outdir = process.argv.find((argument) => argument.startsWith("--outdir="))?.slice("--outdir=".length);
const dist = outdir ?? join(root, "dist");

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

// The version is kept in package.json only; static/manifest.json holds a
// placeholder. A release sets package.json's version before building.
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifestPath = join(dist, "manifest.json");
const manifest = builtManifest(JSON.parse(await readFile(manifestPath, "utf8")), version);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built the Chrome extension ${manifest.version_name} (manifest version ${manifest.version}) in ${outdir ?? "apps/chrome-extension/dist"}`);
