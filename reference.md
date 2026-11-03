# BearSender: how it is put together

Where each file is, in a line, is in `CLANKER_INDEX.md`. This is how the parts fit together.

## Build
- **Bun and TypeScript:** `bun run build` (`build.ts`) type-checks with `tsc`, so a type error fails the build. It then bundles `src/main.ts`, and inlines the JS and `style.css` into `index.html`, with the fonts in `fonts/` as data, so the page needs no internet for them.
- **The output** is `dist/bearsender.html`, one file. Beside it are three redirect pages: `index.html`, `flexisender.html` and `Flexisender-Flightrecorder.html`.
- **Dependencies:** Preact with `@preact/signals` for the UI, and `three` from npm for the 3D view.
- **Dev server:** `serve.ts` bundles on each request, and reloads the page when a file changes.
- **Publishing:** `.github/workflows/pages.yml` builds on every push to `main` and publishes `dist/` to GitHub Pages.

## The parts
- **The shell** (`src/app/`) is Preact, sized to the window: nothing scrolls but a panel's own contents.
  - `App.tsx` has the top bar, the position line, the message line, the five screens and the bottom bar.
  - Each screen and panel is its own file, and is built only while it shows (the job screen's right-hand panels stay mounted).
- **Stores** (`src/stores/`) are signals, one per feature, and the shell reads only these:
  - `machine`, `connection`, `job`, `program`, `queue`, `messages`, `flight`, `options`, `macros` and more;
  - the settings, zones, tool table, options and camera modules keep their own signals beside their logic.
- **The command layer** (`src/command.ts`) carries every line to the controller.
  - It counts the bytes in the RX buffer, and matches each `ok` or `error:N` to its command in send order.
  - `send(line)` returns a promise of the reply; `post(line)` is for lines nobody waits for; `realtime(byte)` sends a realtime byte.
  - Push messages (status, alarms, `[MSG:]`, `[GC:]`, the banner) go to subscribers, never to a command.
  - A job is a source it pulls lines from while the buffer has room. After a reset, a banner, a jog cancel or an alarm with lines unanswered, it resyncs (`$` until `[HLP:]` comes back).
- **The kept error:** grblHAL keeps the last error and gives it to the next G-code line until a `$` command or an empty line clears it. So a job, and each macro, starts with an empty line.
- **The G-code interpreter** (`src/gcode/`) reads the program for the preview, the tool sections, the times, the limits and the resume plan.
- **The status parser** (`src/parser.ts`) reads the status report into the machine and job stores. That includes MPos, WPos and WCO for every axis: A, B and C in degrees, U, V and W in mm.

## What is left of the old code
- **No old shared state or status bus.** Each value lives with what owns it:
  - the job's lines and run state in the job store, streaming's own flags in `streaming.ts`;
  - the link's socket and buffers in `connection.ts`;
  - positions, offsets, axes and `$` values in the machine store;
  - the 3D view's bounds in `viewport.ts`.
- **One piece of the old style is left: the resume dialog** (`#frModal` in `index.html`). `flight-recorder.ts` still builds it as HTML strings, and it is reviewed resume code. An effect on the machine state, the link and the job keeps it current.

## Kept in the browser
Nothing is kept on the controller except its own settings, offsets and tool table.

**IndexedDB** (`src/stores/idb.ts`) holds the job queue and the files.

**localStorage keys:**

| What | Keys |
|---|---|
| Screens and panels | `fs-screen`, `fs-setup-tab`, `fs-settings-tab`, `fs-probing-sub`, `fs-panel`, `fs-panel-auto`, `fs-left`, `fs-left-auto`, `fs-pos-ref`, `fs-signals-shown` |
| Connection | `fs-opt-conn` |
| Options | `fs-opt-autoload-settings`, `fs-opt-colors`, `fs-opt-font-text`, `fs-opt-font-numbers`, `fs-opt-cols`, `fs-opt-jogsteps`, `fs-opt-jog-show-units`, `fs-opt-bearcolors` (zone colours), `fs-viewport-extents`, `fs-opt-coolant`, `fs-opt-park` |
| Jobs and the resume | `fs-opt-hold-every-m6`, `fs-opt-run-after-m30`, `fs-opt-resume-lift` |
| Flight recorder | `fs-fr-enabled` |
| Zones | `fs-ez-show-labels` |
| Jogging and framing | `fs-jog-feed`, `fs-frame-safe-z`, `fs-frame-safe-ref` |
| Spindle warmup | `fs-warmup-normal`, `fs-warmup-cold`, `fs-warmup-motion`, `fs-warmup-point`, `fs-warmup-from-cold` |
| Camera | `fs-cam-device`, `flexisender_cam` (offset and crosshair) |
| Your macros | `fs-macros` |
