# Program interpreter

```ts
import { interpretGcode, sampleMove } from './gcode/index';

const program = interpretGcode(originalFileText, {
  activeWorkOffset: 'G54',
  workOffsets: { G54: { x: -200, y: -150, z: -20 } },
  initialPosition: { x: -200, y: -150, z: -5 },
  rapidRates: { x: 6000, y: 6000, z: 2000 },
  g28: { x: -1, y: -1, z: -1 },
});
const beforePhysicalLine20 = program.stateAfterLine(19);
const physicalLine = program.loaderToFile[20]; // loader's nonblank line 20
const beforeLoaderLine20 = program.stateAfterLine(physicalLine - 1);
for (const move of program.moves) {
  const displayPoints = sampleMove(move); // machine XYZ, mm
}
```

Import `gcode/index` explicitly: `src/gcode.ts` is the file loader, not this
module. The module has no DOM, three.js, Bun APIs, dependencies, or mutable global
state. Re-run it with the original text and fresh context when offsets, machine
position, tool lengths or rapid rates change.

In BearSender everything that reads the program goes through here:
`src/stores/program.ts` reads the loaded file with the controller's context and
gives the Preview, the Jobs list, the Setup list's travel and tools; the flight
recorder resume (`src/flight-recorder-resume.ts`) takes its modal state and
position from `stateAfterLine`. BearSender passes `$` and `[` lines in as
comments, since grblHAL takes them and they move nothing (`$H` aside).

## Coordinates, missing context and bounds

Inputs: offsets, stored positions and tool lengths in mm; rapid rates in mm/min
(`$110`..`$112`, normalized to mm by the caller). A numeric tool-table value is a
Z length; a vector permits grblHAL XYZ tool offsets. `initialG92` is the active
controller G92 offset. `initialTool` supplies an already loaded tool.
`initialLengthOffset` is a tool length offset already in force on the controller
(G43.1, `$TPW`): the program starts in G43 with it, until its own G49 or G43.

Machine = work + selected work offset + G92 + tool length offset. G53 bypasses
these translations and distance mode for that block. G28/G30 first visit any
specified intermediate point in the current units/distance/frame, then return
only the named axes (all XYZ when no axes are named) to stored machine positions.

Unknown coordinates are **null**, never zero or NaN. Missing initial position
stays unknown. If no WCS table is provided, the initial active offset defaults to
zero and raises an inference; a missing entry in a supplied table stays unknown.
Unknown stored returns propagate only to the returning axes. Later absolute
coordinates can establish them again. Known incremental displacements retain
their lengths/time even if absolute coordinates are unknown.

`bounds.machine` includes endpoints and analytic arc quadrant extrema, including
rapids and stored returns. `bounds.work` subtracts each move's full translation
at that point; `perWorkOffset` partitions this work-coordinate envelope by WCS.
An overall work envelope can mix frames; use machine space for physical travel.
G92 changes within a WCS also change its work frame. `complete: false` means the
reported numeric extrema cover only known geometry, not a complete travel limit.
Empty axes have null extrema. No move is fabricated to join a gap in knowledge.

## Modes, lines and resume consumers

Default file-start modes: G0 G17 G21 G90 G91.1 G94 G49 G98, spindle/coolant off,
no feed/speed, no tool unless supplied. This is a documented interpretation of a
standalone program, not a query of the controller's existing modal state. Files
that depend on other initial modes must supply their setup blocks first.

Every physical line (blank/comment lines included, CRLF/LF/CR supported) has a
state snapshot and half-open `moveRange`. `stateAfterLine(0)` returns the initial
state; all accessors return independent snapshots. `stateAfterLine(n - 1)` is
the state before physical line n. Maps are 1-based, with index zero unused;
blank physical lines map to null. Loader lines count every nonblank line,
including comments and `%`, exactly like `processGcode`. N words do not alter
either map. Tool IDs are programmed T values, not N numbers.

State includes machine position, WCS value, G92, tool selection vs loaded tool,
G43 H/value, both coolant outputs, spindle/speed, feed modes and sticky cycle
parameters. G94 `feed` is mm/min; G93 `feed` is inverse minutes. The exact last F
word is in `programmedFeed`. A G93/G94 switch clears feed pending a new F. M2/M30
end interpretation and reset the documented grblHAL program-end modal subset.

This provides data for resume; it does not authorize resume or generate an entry
path. Consumers must inspect issues, unknown values, active cycles and
`reliable`. A stopped suffix retains the last known modes with reliable=false;
those snapshots are not the state of hypothetical execution past the failure.

## Arcs and cycles

G17 uses XY, G18 uses ZX, G19 uses YZ: right-handed ordering viewed from the
positive normal axis. Arcs retain exact centre, start angle, signed sweep,
radius, plane, direction and actual fractional `turns`. `programmedTurns` is P
(default 1); P2 adds one revolution to a partial arc or gives two full circles.
Full-circle IJK requires no endpoint words. G90.1 needs both in-plane centre
words. Positive R selects a short arc; negative R a long arc. A full-circle R
has no unique centre and is an issue. Helix length includes the linear axis.
CAM endpoint rounding uses grblHAL's radius consistency thresholds (0.5 mm
absolute, or >0.005 mm and >0.1% radius); accepted curves use the start radius
and preserve the programmed endpoint. No chord substitution for rejected arcs.

G73/G81/G82/G83/G85/G89 expand into explicit rapid/feed moves and dwell events in
all three planes. Depth/R are sticky resolved machine positions; Q is mm; L is
nonsticky (default 1). G91 R is relative to the current drilling-axis position;
depth is relative to R; lateral increments repeat L times. A changed cycle,
plane, WCS, translation or distance mode needs fresh depth/R. G98 retracts to
the greater of the block's entry height and R, G99 to R. This follows grblHAL's
per-block return behavior. G85/G89 feed out; G82/G89 dwell P seconds at depth.

The grblHAL peck profile is deliberate: G73/G83 dwell 0.25 s at each peck;
G83 feeds again from the retract point rather than assuming an unprogrammed
rapid re-entry near the last depth. G73 uses `context.g73RetractMm`, required
because its chip-break retract is a controller setting. It retracts by that
distance between pecks and to the return level on the final peck. Inverse-time
cycles are invalid. Expansion has a configurable move guard (default 1,000,000).

## Operations, tools and time

**Inference:** the most recent comment-only line becomes a pending heading.
Blank lines and setup-only blocks retain it; the next tool change or motion
(including stored return) starts an operation at the heading's physical line.
The rule is resolved before execution so intervening setup dwells belong to the
upcoming operation.
Only the latest comment-only line is retained. This intentionally simple rule
can classify header/disclaimer comments as operations; it does not claim to
understand Fusion metadata. Every such operation raises an inference issue.

`tools` contains tool-use intervals, including a null-tool preamble when needed;
each M6 starts a new interval even if the same T is loaded again. Operation IDs
and tool-use IDs cross-reference the corresponding arrays. Ranges use inclusive
physical file lines. Times sum moves and dwell events; intervals include setup
time and final retraction until the next tool/operation boundary or program end.

Feed time = path length / feed; G93 = 60/F seconds per block, with F required on
every feed/arc block. Rapid time is max(|axis displacement| / axis rate).
Unspecified rapid axes default to 3000 mm/min and raise an inference. G4 P and
cycle P values are seconds. Acceleration, overrides, spindle spin-up, tool
changes and operator waits have no duration model, so estimates are lower
bounds. Unknown move/event times are null; totals sum known durations and set
`timeComplete=false` when modelled geometry/time or manual waits are unknown.

## Issues

Unsupported syntax, words, commands or conflicting/invalid blocks stop execution
at the first such block. The suffix is still lexed to enumerate further
unsupported commands, but never drawn using a stale motion mode. G41/G42,
O words, M98/macros, ABC/UVW, probing, G10, G92 cancellation/restoration,
additional G43 variants, G95, tapping and all other unimplemented codes are
reported. G92 itself is applied and flagged. Missing G28/G30/table data remains
unknown rather than guessed. M0/M1 and M6 become untimed events; N words,
parenthesized/semicolon comments and `%` delimiters are accepted. Block delete,
checksums, expressions and controller `$` commands are unsupported.

## Plotting

`tools/plot-gcode.ts` writes XY/XZ SVGs, a JSON summary and optionally the whole
program as JSON (`--dump`). `--overlay FILE` draws another interpreted program
over it, and `--context FILE.json` supplies the machine context. `tools/samples`
holds sample programs and contexts.
