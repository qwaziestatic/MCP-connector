// Checks what the built extension is allowed to do, on the manifest and on
// the bundles as esbuild makes them, so a later change cannot quietly widen it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the manifest", () => {
  let manifest: Record<string, unknown>;
  before(async () => {
    manifest = JSON.parse(await readFile(join(root, "static", "manifest.json"), "utf8")) as Record<string, unknown>;
  });

  it("asks for ChatGPT and this computer only", () => {
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*", "http://127.0.0.1/*"]);
    assert.deepEqual(manifest.permissions, ["storage", "sidePanel"]);
    assert.equal("optional_permissions" in manifest || "optional_host_permissions" in manifest, false);
    assert.deepEqual(
      (manifest.content_scripts as Array<{ matches: string[] }>).map((script) => script.matches),
      [["https://chatgpt.com/*"]]
    );
  });

  it("lets no web page message the extension or load its files", () => {
    assert.equal("externally_connectable" in manifest, false);
    assert.equal("web_accessible_resources" in manifest, false);
  });

  it("allows its pages and worker to load nothing remote and to reach only 127.0.0.1", () => {
    const policy = (manifest.content_security_policy as { extension_pages: string }).extension_pages;
    const directives = Object.fromEntries(policy.split(";").map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/u);
      return [name, values.join(" ")];
    }));
    assert.deepEqual(directives, {
      "default-src": "'none'",
      "script-src": "'self'",
      "style-src": "'self'",
      "img-src": "'self'",
      "connect-src": "http://127.0.0.1:*",
      "base-uri": "'none'",
      "form-action": "'none'"
    });
  });
});

describe("the bundles", () => {
  const bundles: Record<string, string> = {};
  before(async () => {
    const result = await build({
      absWorkingDir: root,
      entryPoints: {
        background: "src/background.ts",
        content: "src/content.ts",
        panel: "src/panel.ts",
        options: "src/options.ts"
      },
      outdir: "unused",
      bundle: true,
      format: "iife",
      target: "chrome116",
      legalComments: "none",
      write: false,
      logLevel: "silent"
    });
    for (const file of result.outputFiles) {
      bundles[file.path.replace(/^.*[\\/]/u, "").replace(/\.js$/u, "")] = file.text;
    }
  });

  it("keeps the key and every request to MCP Connector in the background worker", () => {
    assert.match(bundles.background!, /Bearer /u);
    assert.match(bundles.background!, /chrome\.storage\.local/u);
    for (const name of ["content", "panel", "options"]) {
      const code = bundles[name]!;
      assert.doesNotMatch(code, /\bfetch\b/u, `${name} must not make requests`);
      assert.doesNotMatch(code, /Bearer|authorization/iu, `${name} must not handle the key`);
      assert.doesNotMatch(code, /chrome\.storage/u, `${name} must not read storage`);
      assert.doesNotMatch(code, /XMLHttpRequest|WebSocket|EventSource|sendBeacon/u, `${name} must not make requests`);
    }
  });

  it("gives the content script nothing but a report to the panel and the chat box", () => {
    const code = bundles.content!;
    // One message out, and it is the page report, which the worker does not answer.
    assert.equal(code.match(/chrome\.runtime\.sendMessage/gu)?.length, 1);
    assert.match(code, /chrome\.runtime\.sendMessage\(state\)/u);
    assert.doesNotMatch(code, /"run"|"finish-preview"|"preview-status"|"set-ticks"|"save-pairing"/u);
    assert.doesNotMatch(code, /chrome\.(tabs|sidePanel|scripting|storage)/u);
  });

  it("answers messages in the worker only for the extension's own pages", () => {
    assert.match(bundles.background!, /if \(!isExtensionPage\(sender, chrome\.runtime\.id, extensionUrl\)\) return false;/u);
  });

  it("loads no code at run time and writes no HTML from text", () => {
    for (const [name, code] of Object.entries(bundles)) {
      assert.doesNotMatch(code, /\beval\(|new Function\(|importScripts|import\(/u, name);
      assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/u, name);
      // The only web addresses are ChatGPT, this computer and the app's Releases page.
      const addresses = [...code.matchAll(/https?:\/\/[^\s"'`)]+/gu)].map((match) => match[0]);
      for (const address of addresses) {
        assert.match(address, /^(https:\/\/chatgpt\.com\/|http:\/\/127\.0\.0\.1:|https:\/\/github\.com\/qwaziestatic\/MCP-connector\/releases$)/u, `${name}: ${address}`);
      }
    }
  });
});
