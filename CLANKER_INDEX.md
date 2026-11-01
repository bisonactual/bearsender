# CLANKER_INDEX

What lives where.

Build: `bun run build` type-checks (`tsc --noEmit` via tsconfig) and then bundles into `dist/flexisender.html`. Preact with
`@preact/signals` for the shell; `three` from npm. The carried-over `.tsx` screens still use the home-made `h()`
(`src/jsx.tsx`) through a per-file classic-JSX pragma.

## src/stores/
Signal stores, one per feature. New code reads only these. `connection.ts` (state, transport, address, firmware),
`machine.ts` (state, positions, WCO, offsets, overrides, feed/spindle, pins, alarm, homed, tool, tool table, $ settings),
`job.ts` (file, lines, running/paused, sent/accepted/reported line, start/end, result, last job in localStorage, limits),
`messages.ts` ([MSG:], alarms, errors, job and link events), `flight.ts` (plugin, record, events, watchdog, undercut).
Fed by parser.ts, connection.ts, streaming.ts, gcode.ts, offsets.ts, tooltable.ts, settings-*.ts and flight-recorder.ts.

## src/app/
The shell (Preact). `App.tsx`: top bar, position line, message line, the five screens, bottom bar. `JobScreen.tsx`:
Current Job strip, Jobs list, the switchable panel (Setup checks, Program, Recorder, Preview, Messages) with AUTO.
`mode.ts`: what the job screen shows, worked out from the stores. `toolscan.ts`: TEMPORARY T…M6 scan until the G-code
interpreter. `Legacy.tsx`: moves a carried-over DOM panel from `#legacy` into a screen. `carried.ts`: the old screens'
start-up (what switchTab did). `ui.ts`: which screen, sub-tab and panel are showing.

## src/state.ts
The old shared `state` object, kept for the carried-over screens. Constants: poll rates, pin maps, colour defaults, dtype map.

## src/ui.ts
Pure helpers: `byteLen`, `esc`, `fmtPos`, `fmtBytes`, `fmtOffset`, `isInputFocused`, `$` (getElementById shorthand).

## src/console.ts
`log(type, msg)` — appends timestamped lines to the console output div. `clearConsole()`.

## src/connection.ts
WebSocket and Web Serial connect/disconnect. `rtSend` (real-time bypass), `cmdSend` (byte-tracked), `sendCmd` (UI-facing). Poll rate management. Feeds the connection store.

## src/viewport.ts
Three.js scene setup, orbit/pan/zoom (mouse + touch), grid rebuild from viewport extents, toolpath mesh building, executed path overlay, view presets (ISO/TOP/FRONT/SIDE/FIT), toolhead marker.

## src/gcode.ts
G-code parser (`parseGcodeToToolpath`), file loading (`loadFile`, `uploadAndOpenFile`), `processGcode` (parses + builds mesh + computes limits), program limits computation and rendering, frame program.

## src/streaming.ts
Character-counting job pump. `startJob`, `pauseJob`, `stopJob`, `pumpQueue`. Run button state. `sendReset`, `unlockAlarm`, `sendHome`, `goToXY0`, `setWCS`. Console manual send + command history.

## src/parser.ts
`parseResponse` — routes incoming lines to the right handler. Status report parser (MPos/WPos, WCO, H, FS, Ov, Bf, Ln, Ct, WCS, Pn) into the machine and job stores, and the old bus (`bus.ts`) for the carried-over modules. Alarm texts (`alarmText`).

## src/jog.ts
Click-to-step and hold-to-jog modes. XY/Z step size selectors. Diagonal jog support. Keyboard continuous jog (arrow keys, PageUp/Down). Button highlight feedback.

## src/overrides.ts
Feed/rapid/spindle override sliders. Sends real-time increment bytes (0x90–0x9D). Spindle CW/CCW/OFF. Flood/mist coolant toggles.

## src/settings-load.ts
Settings load sequence: `$EG` → `$ESH`+`$ES` → `$$`. Phase state machine. `settingsIntercept` — intercepts lines during load.

## src/settings-widgets.ts
Widget builders for each GrblHAL setting datatype: bool toggle, bitfield checkboxes, exclusive bitfield, radio buttons, axis mask, text/number/password/ipv4 inputs.

## src/settings-write.ts
Dirty tracking (`markDirty`), individual and batch write (`writeSetting`, `writeAllDirty`), write ok/err handlers, `tryInterceptValue`, `tryParseSettingLine`.

## src/settings-render.ts
Renders the settings UI: group sidebar, setting rows with meta + widget + write button, search/filter.

## src/settings.ts
Barrel re-export of all settings-* modules.

## src/tooltable.ts
`$TTLIST` parser (LinuxCNC format). Renders both the full-tab table and the module-card table. Pocket/carousel/active tool status. `toolTableIntercept` for response accumulation.

## src/sd.ts
SD card file browser dropdown. Fetches file list via HTTP (`/sdfiles`, `/sdcard`, `/sd`). Run-from-SD command.

## src/camera.ts
Camera engine: getUserMedia, crosshair overlay (cross/circle/dot styles), zoom, drag-to-move crosshair, offset measurement workflow, go-to-camera/spindle, zero-at-crosshair. Settings persistence.

## src/keyboard.ts
Touch keyboard overlay: QWERTY + numpad, buffer management, send to console input.

## src/options.ts
Options page (Settings, Options): connection mode (WS URL / Serial + baud config), colour theme (CSS var overrides), jog steps, exclusion zone colours. All persisted to localStorage.

## src/flight-recorder.ts
Flight Recorder plugin support. On/off (`fs-fr-enabled`), plugin detection, the connect handshake (no reset; retries `$I+` until a real `[VER:]` reply), job stamping and line numbering (`frJobLines`), the Settings, Flight recorder page ($790–$793, undercut switch), the resume dialog, and the flight store that the job screen's Recorder panel reads (record, event log). `frIntercept` gets each ok/error with the command it answers.

## src/flight-recorder-resume.ts
Pure helpers: CRC-32 job id, `numberedLine`, and the resume plan (`modalScan`, `resumePreamble`, `resumeStart`), the same rules as Flight-Recorder's `tools/stream.py`.

## src/main.ts
Entry point. Wires the carried-over panels (built into `#legacy` in index.html), exposes functions on `window` for HTML onclick handlers, then renders the shell into `#app`.
