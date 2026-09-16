import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: "local-reveal-assets",
    closeBundle() {
      const source = dirname(createRequire(import.meta.url).resolve("reveal.js/package.json"));
      const target = resolve("dist/vendor/reveal");
      mkdirSync(target, { recursive: true });
      for (const directory of ["dist", "plugin"]) cpSync(resolve(source, directory), resolve(target, directory), { recursive: true });
    },
  }],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});
