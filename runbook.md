# Runbook

## Prerequisites
[Bun](https://bun.sh); 1.4.4 is what the Pages workflow uses. No node or npm is needed. Run `bun install` once.

## Dev server
```bash
bun run dev
```
Serves the source on `http://localhost:3000` (or `PORT`). `src/main.ts` is bundled on each request for `/bundle.js`, and editing a file reloads the page.

## Type check
```bash
bun run check
```

## Build
```bash
bun run build
```
Type-checks, then writes `dist/` (not in git):
- **`dist/bearsender.html`:** the app, one file with the JS and CSS inlined, and the dev reload stripped;
- **the old addresses:** `dist/index.html`, `dist/flexisender.html` and `dist/Flexisender-Flightrecorder.html`, which redirect to it and keep any `?query` and `#hash`.

## Publishing (GitHub Pages)
`.github/workflows/pages.yml` runs on every push to `main`, and can be started by hand. It installs, builds, and publishes `dist/` with the official Pages actions, each pinned to a commit.
- **The Pages source must be "GitHub Actions":** repository Settings, Pages, Build and deployment, Source.
- **Switch the source first.** With "Deploy from a branch", the push would publish `main`'s root, which no longer has the old built pages.

## Project layout
| Path | What it is |
|---|---|
| `index.html` | The page: the shell's mount point, the file picker, the resume dialog and the probe preview's overlay |
| `style.css` | All styles; the colour tokens are on `:root` |
| `src/main.ts` | The entry point |
| `src/app/` | The screens and panels (Preact) |
| `src/stores/` | The signals they read |
| `serve.ts` | The dev server |
| `build.ts` | The build |

`CLANKER_INDEX.md` says what each file does, and `reference.md` how they fit together.
