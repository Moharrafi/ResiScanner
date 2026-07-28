// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import fs from "node:fs";
import path from "node:path";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  nitro: {
    preset: process.env.NITRO_PRESET || (process.env.VERCEL ? "vercel" : "vercel"),
    hooks: {
      compiled() {
        const outputDir = path.resolve(".vercel/output");
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        // 1. Generate root config.json
        const configPath = path.join(outputDir, "config.json");
        const vercelConfig = {
          version: 3,
          routes: [
            { handle: "filesystem" },
            { src: "/(.*)", dest: "/__server" }
          ]
        };
        fs.writeFileSync(configPath, JSON.stringify(vercelConfig, null, 2));
        console.log("[nitro-hook] Successfully generated .vercel/output/config.json!");

        // 2. Generate .vc-config.json for server functions
        const functionsDir = path.join(outputDir, "functions");
        if (fs.existsSync(functionsDir)) {
          const entries = fs.readdirSync(functionsDir);
          for (const entry of entries) {
            if (entry.endsWith(".func")) {
              const funcDir = path.join(functionsDir, entry);
              if (fs.statSync(funcDir).isDirectory()) {
                const vcConfigPath = path.join(funcDir, ".vc-config.json");
                const vcConfig = {
                  runtime: "nodejs20.x",
                  handler: "index.mjs",
                  launcherType: "Nodejs"
                };
                fs.writeFileSync(vcConfigPath, JSON.stringify(vcConfig, null, 2));
                console.log(`[nitro-hook] Successfully generated ${vcConfigPath}!`);
              }
            }
          }
        }
      },
    },
  },
});

