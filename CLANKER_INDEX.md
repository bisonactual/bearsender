# CLANKER_INDEX

What lives where.

BearSender (formerly FlexiSender; the repo keeps its name). Build: `bun run build` type-checks (`tsc --noEmit` via tsconfig)
and then bundles into `dist/bearsender.html`. Preact with
`@preact/signals` for the shell; `three` from npm. The carried-over `.tsx` screens still use the home-made `h()`
(`src/jsx.tsx`) through a per-file classic-JSX pragma.

## src/stores/
Signal stores, one per feature. New code reads only these. `connection.ts` (state, transport, address, firmware),
`machine.ts` (state, positions, WCO, offsets, overrides, feed/spindle, pins, alarm, homed, tool, tool table, $ settings),
`job.ts` (file, lines, running/paused, sent/accepted/reported line, start/end, result, last job in localStorage, limits),
`messages.ts` ([MSG:], alarms, errors, job and link events), `flight.ts` (plugin, record, events, watchdog, undercut),
`camera.ts` (the camera last started in this browser, which is what "set up" means; whether it is showing).
Fed by parser.ts, connection.ts, streaming.ts, gcode.ts, offsets.ts, tooltable.ts, settings-*.ts, flight-recorder.ts and camera.ts.

## src/command.ts
The command layer: every line to the controller goes through it, and it matches each `ok`/`error:N` to its command
in send order. `send(line)` → promise of `{ lines, result, code }` (rejects only on a timeout, reset, alarm resync or
lost link; a timed-out command keeps its place and its late reply). `post(line)` for lines nobody waits for.
`realtime(byte)` for ?, !, ~, 0x18, 0x85, 0x87 and the overrides. Push messages (status, ALARM, [MSG:], the banner,
[GC:], [TLO:], start-up echoes) go to `on(kind, fn)` subscribers, never to a command; `onReply` sees every matched
reply. The job is a `JobSource` the layer pulls from while the RX buffer has room, after any queued one-off commands.
On connect, after a reset or banner, and after a jog cancel or alarm with lines unanswered, it holds new commands and
syncs: `\n$\n` until an [HLP:] with its ok comes back (plus a `$I+` confirm if more than one probe went), dropping
everything before. `commandTrace()` on window prints its last 3000 events.

## src/app/
The shell (Preact). `App.tsx`: top bar, position line, message line, the five screens, bottom bar. `JobScreen.tsx`:
Current Job strip and two switchable panels, each with AUTO: on the left Jobs and Program; on the right Setup checks,
Recorder, Preview, Camera, Console and Macros (the last three carried over, and kept mounted).
`Popup.tsx`: the popups (jog, offsets, probe, measure, frame, tool table, recorder settings), which borrow
carried-over panels and put them back on close, and the Messages list. `asks.ts`: what the shell reads by itself on connect ($22, $130-$132,
$TTLIST) and when the operator's ticks reset. `mode.ts`: what the job screen shows, worked out from the stores. `toolscan.ts`: TEMPORARY T…M6 scan until the G-code
interpreter. `Legacy.tsx`: moves a carried-over DOM panel from `#legacy` into a screen. `carried.ts`: the old screens'
start-up (what switchTab did), and the camera running only while its tab shows. `ui.ts`: which screen, sub-tab and
panels are showing.

## src/state.ts
The old shared `state` object, kept for the carried-over screens. Constants: poll rates, pin maps, colour defaults, dtype map.

## src/ui.ts
Pure helpers: `byteLen`, `esc`, `fmtPos`, `fmtBytes`, `fmtOffset`, `isInputFocused`, `$` (getElementById shorthand).

## src/console.ts
`log(type, msg)` — appends timestamped lines to the console output div. `clearConsole()`.

## src/connection.ts
WebSocket and Web Serial connect/disconnect, and the read on connecting (`$I+`, the flight recorder, the zones, settings if
auto-load is on, `$#`, the shell's asks), one command after another. `rtSend` and `sendCmd` are thin wrappers over the
command layer. Poll rate management. Feeds the connection store.

## src/viewport.ts
Three.js scene setup, orbit/pan/zoom (mouse + touch), grid rebuild from viewport extents, toolpath mesh building, executed path overlay, view presets (ISO/TOP/FRONT/SIDE/FIT), toolhead marker.

## src/gcode.ts
G-code parser (`parseGcodeToToolpath`), file loading (`loadFile`, `uploadAndOpenFile`), `processGcode` (parses + builds mesh + computes limits), program limits computation and rendering, frame program.

## src/streaming.ts
The job as a source for the command layer, which does the character counting. `startJob`, `streamLines`, `pauseJob`, `stopJob`. Run button state. `sendReset`, `unlockAlarm`, `sendHome`, `goToXY0`, `setWCS`.

## src/parser.ts
Push messages from the command layer's subscriptions: the status report parser (MPos/WPos, WCO, H, FS, Ov, Bf, Ln, Ct, WCS, Pn) into the machine and job stores and the old bus (`bus.ts`) for the carried-over modules, alarms, [MSG:]. Errors go to the messages; an offset write is followed by `$#`. Alarm texts (`alarmText`).

## src/jog.ts
Click-to-step and hold-to-jog modes. XY/Z step size selectors. Diagonal jog support. Keyboard continuous jog (arrow keys, PageUp/Down). Button highlight feedback.

## src/overrides.ts
Feed/rapid/spindle override sliders. Sends real-time increment bytes (0x90–0x9D). Spindle CW/CCW/OFF. Flood/mist coolant toggles.

## src/settings-load.ts
Settings load: `$EG`, `$ESH`, `$ES`, `$$`, each awaited and read from its own reply.

## src/settings-widgets.ts
Widget builders for each GrblHAL setting datatype: bool toggle, bitfield checkboxes, exclusive bitfield, radio buttons, axis mask, text/number/password/ipv4 inputs.

## src/settings-write.ts
Dirty tracking (`markDirty`), individual and batch write (`writeSetting`, `writeAllDirty`), `readSetting`. Any reply with `$n=value` lines updates the stored values.

## src/settings-render.ts
Renders the settings UI: group sidebar, setting rows with meta + widget + write button, search/filter.

## src/settings.ts
Barrel re-export of all settings-* modules.

## src/tooltable.ts
`$TTLIST` parser (LinuxCNC format), from the command's reply. Renders both the full-tab table and the module-card table. Pocket/carousel/active tool status.

## src/sd.ts
SD card file browser dropdown. Fetches file list via HTTP (`/sdfiles`, `/sdcard`, `/sd`). Run-from-SD command.

## src/camera.ts
Camera engine: getUserMedia, crosshair overlay (cross/circle/dot styles), zoom, drag-to-move crosshair, offset measurement workflow, go-to-camera/spindle, zero-at-crosshair. Settings persistence. `showCamera()`/`hideCamera()` for the job screen's Camera tab: start the camera chosen before, stop it when the tab hides.

## src/keyboard.ts
Touch keyboard overlay: QWERTY + numpad, buffer management, send to console input.

## src/options.ts
Options page (Settings, Options): connection mode (WS URL / Serial + baud config), colour theme (CSS var overrides), jog steps, exclusion zone colours. All persisted to localStorage.

## src/flight-recorder.ts
Flight Recorder plugin support. On/off (`fs-fr-enabled`), plugin detection, what is read on connecting (`$FLIGHT`, `$790`–`$792`, `$HELP COMMANDS`, then `$793` only if `$WATCHDOGTEST` is listed), job stamping and line numbering (`frJobLines`), the Settings, Flight recorder page ($790–$793, undercut switch), the resume dialog, and the flight store that the job screen's Recorder panel reads (record, event log). The record is read from the reply to any `$FLIGHT…` command, the job stamp included.

## src/flight-recorder-resume.ts
Pure helpers: CRC-32 job id, `numberedLine`, and the resume plan (`modalScan`, `resumePreamble`, `resumeStart`), the same rules as Flight-Recorder's `tools/stream.py`.

## src/main.ts
Entry point. Wires the carried-over panels (built into `#legacy` in index.html), exposes functions on `window` for HTML onclick handlers, then renders the shell into `#app`.
