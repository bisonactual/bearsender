# CLANKER_INDEX

What lives where. BearSender (formerly FlexiSender; the repo keeps its name).
- **Build:** `bun run build` type-checks and writes `dist/bearsender.html` (one file) and the redirect pages.
- **UI:** Preact with `@preact/signals`; `three` from npm for the 3D view.
- **How the parts fit together:** `reference.md`. **How to build, run and publish:** `runbook.md`.

## Root
| File | What it is |
|---|---|
| `index.html` | The page: `#app` for the shell, the file picker, the resume dialog (`#frModal`), and `#legacy`, which holds only the probe preview's overlay |
| `style.css` | All styles. At the top are the colour tokens and the few old rules still used (the resume dialog's `fr-`, the overlay's `pp-`, `tb-btn`); after them come the shell's `fs-` rules |
| `build.ts` | The build |
| `serve.ts` | The dev server |
| `.github/workflows/pages.yml` | Publishes `dist/` to GitHub Pages |

## src/app/ — the shell
| File | What it is |
|---|---|
| `App.tsx` | Top bar, position line (every axis, SET), message line, the screens, bottom bar |
| `JobScreen.tsx` | Current Job strip; left panel (Jobs, Program); right panel (Setup checks, Recorder, Preview, Camera, Console, Macros), each with AUTO |
| `SetupScreen.tsx` | Position, jogging, spindle, overrides, limits and framing, surfacing, work offsets; the Spindle warmup tab is `Warmup.tsx` |
| `ProbingScreen.tsx` | The probing routines and their drawing; `ProbeSettings.tsx` is the probe settings card (also Settings, Probe) |
| `ToolsScreen.tsx` | The tool table (also the Setup list's TOOLS popup) |
| `SettingsScreen.tsx` | The controller's `$` settings, and the other tabs: `ZonesTab.tsx`, `OptionsTab.tsx`, `RecorderTab.tsx` (also the recorder's SETTINGS popup) and Settings, Probe |
| `CameraPanel.tsx`, `ConsolePanel.tsx`, `MacrosPanel.tsx` | The job screen's Camera, Console and Macros tabs |
| `Preview.tsx` | The 3D preview |
| `Popup.tsx` | The popups |
| `Legacy.tsx` | Lends the old overlay markup to the Preview, until the probe preview is rebuilt |
| `mode.ts` | What the job screen shows, worked out from the stores |
| `plan.ts` | The job's times |
| `asks.ts` | What the shell reads by itself on connecting (`$22`, `$130`–`$132`, `$30`, `$G`, `$TTLIST`, …) |
| `sound.ts` | The tool change chime |
| `brand.ts` | The bear mark |
| `icons.tsx` | The icons |
| `ui.ts` | Which screen, tab and panel show |

## src/stores/ — signals, one per feature
| File | What it holds |
|---|---|
| `machine` | State, every axis's position, WCO, offsets, TLO, overrides, pins, alarm, homed, tool, tool table, `$` values |
| `connection` | Link state, transport, address, firmware, and how to connect |
| `job` | The loaded file and the run |
| `program` | The file as the interpreter reads it |
| `queue` | The jobs waiting (IndexedDB, through `idb.ts`) |
| `runtimes`, `starts` | Each file's measured times, and the modes it started from |
| `messages` | `[MSG:]`, alarms, errors and job events |
| `flight` | The flight recorder's state |
| `options` | Hold at every M6, run after M30, resume lift |
| `camera` | The camera set up here |
| `macros` | Your own macros |

## src/ — logic
| File | What it is |
|---|---|
| `command.ts` | The command layer: every line to the controller, each reply matched to its command; byte counting; resync |
| `connection.ts` | WebSocket and Web Serial; what is read on connecting |
| `parser.ts` | The status report and push messages, into the stores; alarm texts |
| `streaming.ts` | The job as a source for the command layer; start, hold, stop, reset, home |
| `gcode/` | The G-code interpreter (see its README) |
| `gcode.ts` | File loading, `processGcode` |
| `jog.ts` | Jogging: steps, hold-to-jog, the keyboard |
| `offsets.ts` | Work offsets (`$#`) and writing them |
| `frame.ts` | The program's limits, and framing |
| `surfacing.ts` | The surfacing program and its preview points |
| `warmup.ts` | The machine warmup routines |
| `tooltable.ts` | Reads `$TTLIST` |
| `settings-load.ts` | Reads the `$` settings (`$EG`, `$ESH`, `$ES`, `$$`); `settings.ts` re-exports it |
| `settings-write.ts` | Writes the `$` settings, and keeps the store current from any `$n=` reply |
| `exclusion-zones.ts` | The zones plugin and the ATCi travel, and their 3D boxes |
| `options.ts` | Theme colours, jog steps, zone colours, auto-load |
| `camera.ts` | The camera: picture, crosshair, the offset from the spindle, the moves by it |
| `console.ts` | The log (the last 1000 lines) and the command history |
| `flight-recorder.ts` | The flight recorder: plugin, settings, job stamping, the record, the resume dialog |
| `flight-recorder-resume.ts` | Pure helpers: the job id, line numbering, the resume plan |
| `viewport.ts` | The three.js scene: views, orbit, grid, toolpath, toolhead |
| `units.ts` | Reports in inches read into mm |
| `errors.ts` | grblHAL error texts |
| `ui.ts` | `byteLen`, `esc`, `isInputFocused`, `lsGet`, `lsSet` |
| `main.ts` | Entry point |

**Left from the old code until the review fixes are merged:** `state.ts`, the old shared state object, and `bus.ts`, the old status bus. See `reference.md`.

## src/probing/
| File | What it is |
|---|---|
| `routines.ts` | The routines as the Probing screen runs them |
| `probe-program.ts` | The engine: moves, waiting, writing results |
| `edge-finder.ts`, `center-finder.ts`, `rotation.ts` | The routines |
| `io.ts` | What a routine moves with |
| `plan.ts`, `drawing.ts` | The dry run and the SVG drawing |
| `settings.ts` | The probe settings |
| `probe-preview-3d.ts` | The 3D preview of the moves (also surfacing's) |
