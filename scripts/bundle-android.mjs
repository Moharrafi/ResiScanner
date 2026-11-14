import fs from "fs";
import path from "path";

async function main() {
  const root = process.cwd();
  const serverFuncPath = path.join(root, ".vercel", "output", "functions", "__server.func", "index.mjs");
  if (!fs.existsSync(serverFuncPath)) {
    console.error("Server function not found at:", serverFuncPath);
    console.error("Please run 'npm run build' first.");
    process.exit(1);
  }

  const mod = await import(`file://${serverFuncPath.replace(/\\/g, "/")}`);
  const handler = mod.default;
  const res = await handler.fetch(new Request("http://localhost/"));
  const html = await res.text();

  const distDir = path.join(root, "dist");
  const staticDir = path.join(root, ".vercel", "output", "static");
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

  // Copy static assets
  fs.cpSync(staticDir, distDir, { recursive: true });

  // Write pre-rendered index.html
  fs.writeFileSync(path.join(distDir, "index.html"), html, "utf8");

  console.log("Successfully generated dist with standalone bundle!");
}

main().catch((err) => {
  console.error("Failed to bundle:", err);
  process.exit(1);
});
