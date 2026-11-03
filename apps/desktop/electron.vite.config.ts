import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

// Main and preload dependencies are externalized by default (build.externalizeDeps).
export default defineConfig({
  main: {
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
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html")
      }
    }
  }
});
