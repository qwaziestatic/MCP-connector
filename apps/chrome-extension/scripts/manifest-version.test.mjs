import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { builtManifest, manifestVersions } from "./manifest-version.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
/** What Chrome accepts as "version". */
const CHROME_VERSION = /^\d{1,5}(\.\d{1,5}){0,3}$/u;

describe("manifestVersions", () => {
  it("uses a plain version for both", () => {
    assert.deepEqual(manifestVersions("0.1.0"), { version: "0.1.0", versionName: "0.1.0" });
    assert.deepEqual(manifestVersions("12.0.345"), { version: "12.0.345", versionName: "12.0.345" });
  });

  it("puts the numbers of a pre-release in version and the whole label in version_name", () => {
    assert.deepEqual(manifestVersions("0.3.0-beta.1"), { version: "0.3.0", versionName: "0.3.0-beta.1" });
    assert.deepEqual(manifestVersions("1.2.3-rc.10"), { version: "1.2.3", versionName: "1.2.3-rc.10" });
    assert.deepEqual(manifestVersions("1.2.3-alpha"), { version: "1.2.3", versionName: "1.2.3-alpha" });
    assert.deepEqual(manifestVersions("1.2.3+build.5"), { version: "1.2.3", versionName: "1.2.3+build.5" });
    assert.deepEqual(manifestVersions("1.2.3-beta.2+sha.abc123"), { version: "1.2.3", versionName: "1.2.3-beta.2+sha.abc123" });
  });

  it("always gives Chrome a version it accepts", () => {
    for (const version of ["0.0.1", "0.3.0-beta.1", "65535.65535.65535", "2.0.0-0.3.7", "1.0.0-x.7.z.92"]) {
      assert.match(manifestVersions(version).version, CHROME_VERSION, version);
    }
  });

  it("refuses what is not a release version, saying why", () => {
    for (const version of ["", "1.2", "v1.2.3", "1.2.3.4", "01.2.3", "1.2.3-", "1.2.3 beta", "latest", undefined]) {
      assert.throws(() => manifestVersions(version), /is not a version such as 0\.3\.0 or 0\.3\.0-beta\.1/u, String(version));
    }
    assert.throws(() => manifestVersions("1.70000.0"), /no number above 65535 in a version, and "1\.70000\.0" has 70000/u);
  });
});

describe("the built manifest", () => {
  it("replaces the placeholder in static/manifest.json and changes nothing else", async () => {
    const source = await readJson(join(root, "static", "manifest.json"));
    // The source says 0.0.0 so that nobody takes it for the real version.
    assert.equal(source.version, "0.0.0");
    assert.equal("version_name" in source, false);

    const built = builtManifest(source, "0.3.0-beta.1");
    assert.equal(built.version, "0.3.0");
    assert.equal(built.version_name, "0.3.0-beta.1");
    assert.deepEqual({ ...built, version: "0.0.0", version_name: undefined }, { ...source, version_name: undefined });
  });

  it("gets the package's version when the extension is really built", async () => {
    const outdir = await mkdtemp(join(tmpdir(), "mcp-chrome-build-"));
    try {
      await promisify(execFile)(process.execPath, [join(root, "scripts", "build.mjs"), `--outdir=${outdir}`]);
      const manifest = await readJson(join(outdir, "manifest.json"));
      const { version } = await readJson(join(root, "package.json"));

      // A local build and a release build differ only in package.json's version,
      // which the release workflow sets with "npm version" before building.
      assert.deepEqual([manifest.version, manifest.version_name], [manifestVersions(version).version, version]);
      assert.notEqual(manifest.version, "0.0.0");
      assert.match(manifest.version, CHROME_VERSION);
    } finally {
      await rm(outdir, { recursive: true, force: true });
    }
  });
});
