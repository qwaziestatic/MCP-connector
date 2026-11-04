import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { buildContentSecurityPolicy } from "./src/security/content-security-policy";

// The packaged app loads the renderer from file://, where the main process's
// CSP header does not apply, so production builds carry the policy in a <meta>
// tag. It is added only at build time: the dev server needs the relaxed
// development policy that main.ts sends as a header.
function productionContentSecurityPolicy(): Plugin {
  return {
    name: "mcp-connector:production-csp",
    apply: "build",
    transformIndexHtml: () => [{
      tag: "meta",
      attrs: {
        "http-equiv": "Content-Security-Policy",
        content: buildContentSecurityPolicy("production", { forMetaTag: true })
      },
      injectTo: "head-prepend"
    }]
  };
}

// Sign-in settings built into the main process. Neither is a secret (see
// src/settings/sign-in-config.ts); set them when building the installer.
const signInConfig = {
  githubClientId: process.env.MCP_GITHUB_CLIENT_ID?.trim() ?? "",
  notionSignInUrl: process.env.MCP_NOTION_SIGN_IN_URL?.trim() ?? ""
};

// Main and preload dependencies are externalized by default (build.externalizeDeps).
export default defineConfig({
  main: {
    define: {
      __MCP_SIGN_IN__: JSON.stringify(signInConfig)
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/main.ts")
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/preload.ts")
      }
    }
  },
  renderer: {
    plugins: [react(), productionContentSecurityPolicy()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html")
      }
    }
  }
});
