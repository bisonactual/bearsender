import { resolve } from "path";
import { mkdirSync, readFileSync, writeFileSync } from "fs";

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
// The fonts go in the page as data, so it looks the same with no internet: style.css's import of
// fonts/fonts.css is replaced by its rules, each font file inlined.
const fontsDir = resolve(rootDir, "fonts");
const fontFaces = readFileSync(resolve(fontsDir, "fonts.css"), "utf-8")
  .replace(/url\(([\w.-]+\.woff2)\)/g, (_, file) => `url(data:font/woff2;base64,${readFileSync(resolve(fontsDir, file)).toString("base64")})`);
const css = readFileSync(resolve(rootDir, "style.css"), "utf-8")
  .replace(/@import url\('fonts\/fonts\.css'\);/, fontFaces);
if (css.includes("fonts/fonts.css')")) { console.error("Build failed: style.css's font import wasn't replaced"); process.exit(1); }

// Inline CSS and JS for single-file distribution
const out = html
  .replace(/<link rel="stylesheet" href="\/style\.css">/, `<style>${css}</style>`)
  .replace(/<script src="\/bundle\.js" type="module"><\/script>/, `<script type="module">${js}</script>`)
  .replace(/<!-- DEV-RELOAD -->[\s\S]*?<!-- \/DEV-RELOAD -->/, '')
  .replace(/<!-- CSS extracted to style\.css[^>]*-->/, '');

const distDir = resolve(rootDir, "dist");
mkdirSync(distDir, { recursive: true });
writeFileSync(resolve(distDir, "bearsender.html"), out);

// The old addresses go to BearSender, keeping any ?query and #hash, so bookmarks still work.
const redirect = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>BearSender</title>
<meta http-equiv="refresh" content="0; url=bearsender.html">
<script>location.replace('bearsender.html' + location.search + location.hash);</script>
</head>
<body><p>BearSender has moved to <a href="bearsender.html">bearsender.html</a>.</p></body>
</html>
`;
for (const page of ["index.html", "flexisender.html", "Flexisender-Flightrecorder.html"]) {
  writeFileSync(resolve(distDir, page), redirect);
}
console.log("Built → dist/bearsender.html, with index.html, flexisender.html and Flexisender-Flightrecorder.html redirecting to it");
