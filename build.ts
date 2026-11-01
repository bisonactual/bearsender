import { resolve } from "path";
import { readFileSync, writeFileSync } from "fs";

const rootDir = import.meta.dir;
const srcDir = resolve(rootDir, "src");

// Type check first; a type error fails the build.
const check = Bun.spawnSync([process.execPath, resolve(rootDir, "node_modules/typescript/bin/tsc"), "-p", rootDir], {
  stdout: "inherit",
  stderr: "inherit",
});
if (check.exitCode !== 0) {
  console.error("Type check failed");
  process.exit(1);
}
console.log("Type check passed");

const result = await Bun.build({
  entrypoints: [`${srcDir}/main.ts`],
  format: "esm",
  minify: true,
});

if (!result.success) {
  console.error("Build failed:");
  result.logs.forEach(l => console.error(l.message));
  process.exit(1);
}

const js = await result.outputs[0].text();
const html = readFileSync(resolve(rootDir, "index.html"), "utf-8");
const css = readFileSync(resolve(rootDir, "style.css"), "utf-8");

// Inline CSS and JS for single-file distribution
const out = html
  .replace(/<link rel="stylesheet" href="\/style\.css">/, `<style>${css}</style>`)
  .replace(/<script src="\/bundle\.js" type="module"><\/script>/, `<script type="module">${js}</script>`)
  .replace(/<!-- DEV-RELOAD -->[\s\S]*?<!-- \/DEV-RELOAD -->/, '')
  .replace(/<!-- CSS extracted to style\.css[^>]*-->/, '');

writeFileSync(resolve(rootDir, "dist", "bearsender.html"), out);
console.log("Built → dist/bearsender.html");
