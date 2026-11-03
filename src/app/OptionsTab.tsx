// Settings, Options: BearSender's own choices, kept in this browser and used at once

import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { signal, effect } from '@preact/signals';
import * as connection from '../stores/connection';
import type { LinkSettings } from '../stores/connection';
import * as flight from '../stores/flight';
import * as jobOptions from '../stores/options';
import * as machine from '../stores/machine';
import * as opt from '../options';
import { lsGet, lsSet } from '../ui';
import { log } from '../console';
import { setRecorderEnabled } from '../flight-recorder';
import { setViewportExtents, setProjection, viewportExtents } from '../viewport';
import { NumIn } from './SetupScreen';

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The number of columns the cards are laid out in, as picked. */
const columns = signal(lsGet<string>('fs-opt-cols', '2'));
effect(() => lsSet('fs-opt-cols', columns.value));

function Check({ checked, set, children }: { checked: boolean; set: (v: boolean) => void; children: ComponentChildren }) {
  return <label class="fs-opt-check"><input type="checkbox" checked={checked} onChange={e => set((e.target as HTMLInputElement).checked)} />{children}</label>;
}

function Field({ label, children }: { label: string; children: ComponentChildren }) {
  return <label class="fs-field"><span>{label}</span>{children}</label>;
}

function Pick({ value, set, opts, label }: { value: string; set: (v: string) => void; opts: [string, string][]; label: string }) {
  return (
    <select class="fs-in" aria-label={label} value={value} onChange={e => set((e.target as HTMLSelectElement).value)}>
      {opts.map(([v, t]) => <option value={v}>{t}</option>)}
    </select>
  );
}

function Segmented<T extends string>({ value, set, opts, label }: { value: T; set: (v: T) => void; opts: [T, string][]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} class="fs-seg fs-seg-sm fs-self-start">
      {opts.map(([v, t]) => <button type="button" role="radio" aria-checked={v === value ? 'true' : 'false'} class={v === value ? 'is-on' : ''} onClick={() => set(v)}>{t}</button>)}
    </div>
  );
}

/** A colour: the picker, its hex code to type, and Reset where there is a default. */
function ColorRow({ label, value, set, reset }: { label: string; value: string; set: (v: string) => void; reset?: () => void }) {
  const [hex, setHex] = useState(value);
  useEffect(() => setHex(value), [value]);
  return (
    <div class="fs-color-row">
      <span class="fs-color-label">{label}</span>
      <input type="color" class="fs-color-pick" aria-label={label} value={value} onInput={e => set((e.target as HTMLInputElement).value)} />
      <input type="text" class="fs-in fs-mono fs-hex" aria-label={label + ' hex'} value={hex} maxLength={7} spellcheck={false}
        onInput={e => { const v = (e.target as HTMLInputElement).value; setHex(v); if (HEX.test(v)) set(v); }} />
      {reset && <button type="button" class="fs-btn fs-btn-xs" onClick={reset}>RESET</button>}
    </div>
  );
}

// The cards

function Connection() {
  const s = connection.settings.value;
  const linked = connection.connected.value;
  const set = (patch: Partial<LinkSettings>) => {
    if (patch.mode && patch.mode !== s.mode && linked) { log('err', 'Disconnect before changing connection type'); return; }
    connection.settings.value = { ...s, ...patch };
  };
  const [url, setUrl] = useState(s.wsUrl);
  useEffect(() => setUrl(s.wsUrl), [s.wsUrl]);
  return (
    <>
      <Segmented label="Connection type" value={s.mode} set={mode => set({ mode })} opts={[['websocket', 'WEBSOCKET'], ['serial', 'USB / SERIAL']]} />
      {linked && <div class="fs-note">Connected: disconnect before changing the connection type.</div>}
      {s.mode === 'websocket' ? (
        <>
          <Field label="WebSocket URL">
            <input type="text" class="fs-in fs-mono" value={url} placeholder="ws://host:port" spellcheck={false}
              onInput={e => setUrl((e.target as HTMLInputElement).value)} onChange={e => set({ wsUrl: (e.target as HTMLInputElement).value.trim() })}
              onKeyDown={e => { if (e.key === 'Enter') set({ wsUrl: (e.target as HTMLInputElement).value.trim() }); }} />
          </Field>
          <div class="fs-note">Format: <span class="fs-mono">ws://host:port</span>. CONNECT is in the top bar.</div>
        </>
      ) : (
        <>
          <div class="fs-note fs-mono">{linked && connection.transport.value === 'serial' ? connection.address.value : 'No port selected'}</div>
          <div class="fs-fields">
            <Field label="Baud Rate"><Pick label="Baud Rate" value={s.baud} set={baud => set({ baud })}
              opts={['9600', '19200', '38400', '57600', '115200', '230400', '250000', '500000', '1000000', '2000000'].map(v => [v, v])} /></Field>
            <Field label="Data Bits"><Pick label="Data Bits" value={s.dataBits} set={dataBits => set({ dataBits })} opts={[['7', '7'], ['8', '8']]} /></Field>
            <Field label="Stop Bits"><Pick label="Stop Bits" value={s.stopBits} set={stopBits => set({ stopBits })} opts={[['1', '1'], ['2', '2']]} /></Field>
            <Field label="Parity"><Pick label="Parity" value={s.parity} set={parity => set({ parity })} opts={[['none', 'None'], ['even', 'Even'], ['odd', 'Odd']]} /></Field>
          </div>
          <div class="fs-note">
            {connection.serialSupported
              ? 'Press CONNECT in the top bar to open the browser\'s port picker and connect. The browser will remember your last port.'
              : 'This browser has no Web Serial, so it can\'t open a USB port. Chrome and Edge have it.'}
          </div>
        </>
      )}
    </>
  );
}

function ViewExtents() {
  const now = viewportExtents();
  const [v, setV] = useState({ xMin: String(now.xMin), xMax: String(now.xMax), yMin: String(now.yMin), yMax: String(now.yMax) });
  const [ortho, setOrtho] = useState(now.ortho);
  const field = (k: keyof typeof v, label: string) => (
    <Field label={label}>
      <input type="number" step="10" class="fs-in fs-mono" value={v[k]} onInput={e => {
        const next = { ...v, [k]: (e.target as HTMLInputElement).value };
        setV(next);
        setViewportExtents(parseFloat(next.xMin), parseFloat(next.xMax), parseFloat(next.yMin), parseFloat(next.yMax));
      }} />
    </Field>
  );
  return (
    <>
      <div class="fs-fields">{field('xMin', 'X Minimum (mm)')}{field('xMax', 'X Maximum (mm)')}{field('yMin', 'Y Minimum (mm)')}{field('yMax', 'Y Maximum (mm)')}</div>
      <div class="fs-opt-line"><span class="fs-dim">Projection</span>
        <Segmented label="Projection" value={ortho ? 'o' : 'p'} set={p => { setProjection(p === 'o'); setOrtho(p === 'o'); }} opts={[['p', 'PERSPECTIVE'], ['o', 'ORTHOGRAPHIC']]} />
      </div>
    </>
  );
}

/** A choice of font: each button in its own font. */
function FontPick({ label, value, set, opts }: { label: string; value: string; set: (v: string) => void; opts: [string, string, string][] }) {
  return (
    <div class="fs-font-row">
      <span class="fs-cap">{label}</span>
      <div role="radiogroup" aria-label={label} class="fs-font-picks">
        {opts.map(([k, name, stack]) => (
          <button type="button" role="radio" aria-checked={k === value ? 'true' : 'false'} class={'fs-btn fs-btn-sm' + (k === value ? ' is-on' : '')}
            style={{ fontFamily: stack }} onClick={() => set(k)}>{name}</button>
        ))}
      </div>
    </div>
  );
}

function Fonts() {
  return (
    <>
      <FontPick label="TEXT AND LABELS" value={opt.textFont.value} set={v => { opt.textFont.value = v; }}
        opts={Object.entries(opt.TEXT_FONTS).map(([k, f]) => [k, f.name, f.cond])} />
      <FontPick label="NUMBERS" value={opt.numberFont.value} set={v => { opt.numberFont.value = v; }}
        opts={Object.entries(opt.NUMBER_FONTS).map(([k, f]) => [k, f.name, f.mono])} />
      <div class="fs-font-sample">
        <span class="fs-cap">FEED</span><span class="fs-mono">1,200</span><span class="fs-dim">mm/min</span>
        <span class="fs-cap">X</span><span class="fs-mono">−94.304</span>
        <span class="fs-cap">Y</span><span class="fs-mono">12.500</span>
      </div>
    </>
  );
}

function Theme() {
  const c = opt.colors.value;
  return (
    <>
      {opt.COLOR_ROWS.map(([k, label]) => <ColorRow label={label} value={c[k]} set={v => opt.applyColor(k, v)} reset={() => opt.resetColor(k)} />)}
      {opt.VP_COLOR_ROWS.map(([k, label]) => <ColorRow label={label} value={c[k]} set={v => opt.applyColor(k, v)} reset={() => opt.resetColor(k)} />)}
      <button type="button" class="fs-btn fs-btn-sm fs-self-start" onClick={() => opt.resetAllColors()}>RESET ALL COLOURS</button>
    </>
  );
}

function ZoneColors() {
  const c = opt.zoneColors.value;
  const set = (k: string, v: string) => { opt.zoneColors.value = { ...opt.zoneColors.value, [k]: v }; };
  return <>{opt.ZONE_COLOR_ROWS.map(([k, label]) => <ColorRow label={label} value={c[k]} set={v => set(k, v)} />)}</>;
}

function JogSteps() {
  const s = opt.jogSteps.value;
  const [bad, setBad] = useState(false);
  const set = (k: keyof typeof s, v: string) => { opt.jogSteps.value = { ...opt.jogSteps.value, [k]: v }; };
  const text = (k: 'xy' | 'z', label: string) => (
    <Field label={label}><input type="text" class="fs-in fs-mono" spellcheck={false} value={s[k]} onInput={e => set(k, (e.target as HTMLInputElement).value)} /></Field>
  );
  return (
    <>
      <div class="fs-fields fs-fields-2">{text('xy', 'XY Steps (mm)')}{text('z', 'Z Steps (mm)')}</div>
      <div class="fs-fields">
        <Field label="Max XY Speed (mm/min)"><NumIn label="Max XY Speed" value={parseInt(s.maxXY) || 3000} min={1} step={100} set={v => set('maxXY', String(v))} wide /></Field>
        <Field label="Max Z Speed (mm/min)"><NumIn label="Max Z Speed" value={parseInt(s.maxZ) || 500} min={1} step={50} set={v => set('maxZ', String(v))} wide /></Field>
      </div>
      <button type="button" class="fs-btn fs-btn-sm fs-self-start" onClick={() => setBad(!opt.applyJogSteps())}>APPLY &amp; REBUILD BUTTONS</button>
      {bad && <div class="fs-note fs-warn-text">Each list needs at least one step above 0; nothing was changed.</div>}
      <Check checked={opt.jogShowUnits.value} set={v => { opt.jogShowUnits.value = v; }}>Show mm units on distance buttons</Check>
    </>
  );
}

function Park() {
  const p = jobOptions.parkPoint.value;
  const travel = machine.zTravel.value;
  const linked = connection.connected.value;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const here = () => { const m = machine.mpos.peek(); jobOptions.setParkPoint({ x: r3(m.x), y: r3(m.y), z: r3(m.z) }); };
  return (
    <>
      <div class="fs-fields fs-fields-2">
        <Field label="X (machine)"><NumIn label="Park X" value={p.x} step={1} set={v => jobOptions.setParkPoint({ ...p, x: v })} wide /></Field>
        <Field label="Y (machine)"><NumIn label="Park Y" value={p.y} step={1} set={v => jobOptions.setParkPoint({ ...p, y: v })} wide /></Field>
      </div>
      <div class="fs-inline">
        <span class="fs-cap">Z</span>
        <Segmented<'top' | 'at'> label="Park Z" value={p.z === null ? 'top' : 'at'} opts={[['top', 'TOP OF TRAVEL'], ['at', 'HEIGHT']]}
          set={v => jobOptions.setParkPoint({ ...p, z: v === 'top' ? null : (p.z ?? travel?.max ?? -5) })} />
        {p.z === null
          ? <span class="fs-dim fs-mono">{travel ? 'machine Z ' + travel.max.toFixed(3) : 'read from the homing settings on connecting'}</span>
          : <NumIn label="Park Z" value={p.z} step={1} set={v => jobOptions.setParkPoint({ ...p, z: v })} />}
      </div>
      <div class="fs-inline">
        <button type="button" class="fs-btn fs-btn-sm" disabled={!linked} onClick={here}>USE CURRENT POSITION</button>
        <button type="button" class="fs-btn fs-btn-sm" onClick={() => jobOptions.setParkPoint(jobOptions.PARK_DEFAULT)}>RESET</button>
      </div>
    </>
  );
}

interface OptCard { title: string; desc: ComponentChildren; text: string; body: () => ComponentChildren; }

const CARDS: OptCard[] = [
  { title: 'CONNECTION TYPE', text: 'connection websocket usb serial url baud',
    desc: 'Choose how BearSender connects to your controller. WebSocket connects over your network (WiFi/Ethernet). USB/Serial connects directly via a USB cable using the Web Serial API (Chrome & Edge only).',
    body: () => <Connection /> },
  { title: 'AUTO-LOAD SETTINGS ON CONNECT', text: 'auto-load settings connect autocomplete',
    desc: 'Automatically fetch GrblHAL settings when connecting. Enables console autocomplete for setting names.',
    body: () => <Check checked={opt.autoloadSettings.value} set={v => { opt.autoloadSettings.value = v; }}>Enable</Check> },
  { title: 'FLIGHT RECORDER', text: 'flight recorder resume connection drops',
    desc: 'For controllers with the Flight Recorder plugin. Every job is stamped and its lines numbered, so the controller remembers where it got to. If the connection drops it lifts the tool and stops the spindle, and when you reconnect BearSender offers to carry on from that line. Its settings are in Settings, Flight recorder; the record and the event log are on the Job screen, in the Recorder panel. While this is on BearSender doesn\'t reset the controller when it connects.',
    body: () => <Check checked={flight.enabled.value} set={v => setRecorderEnabled(v)}>Enable</Check> },
  { title: 'JOBS AND THE RESUME', text: 'jobs resume m6 m30 hold lift',
    desc: <>
      <b>Hold at every M6:</b> the job waits for Resume at each M6 in the file, also for the tool already loaded or when the controller ignores M6 ($341=4). Off, it holds only where the controller really changes tools.
    </>,
    body: () => (
      <>
        <Check checked={jobOptions.holdEveryM6.value} set={v => { jobOptions.holdEveryM6.value = v; log('info', 'Hold at every M6: ' + (v ? 'on' : 'off')); }}>Hold at every M6</Check>
        <div class="fs-note"><b>Run lines after M30:</b> grblHAL goes on reading after M2 or M30, with some modes reset. Off, the job ends at the first M2/M30 and the lines after it aren't sent. On, the file is sent whole and the Program panel says lines run after the program end.</div>
        <Check checked={jobOptions.runAfterM30.value} set={v => { jobOptions.runAfterM30.value = v; log('info', 'Run lines after M30: ' + (v ? 'on' : 'off')); }}>Run lines after M30</Check>
        <div class="fs-note"><b>Resume lift:</b> the first move of a flight recorder resume goes up to this height, in mm below machine zero, unless the tool is already higher; then it crosses to the start of the line there. It never moves down.</div>
        <Field label="Resume lift (mm below machine zero)"><NumIn label="Resume lift" value={jobOptions.resumeLiftMm.value} min={0} step={1} set={v => jobOptions.setResumeLift(v)} wide /></Field>
      </>
    ) },
  { title: 'COOLANT', text: 'coolant mist flood m7 m8 run tab',
    desc: 'What the Run tab\'s COOLANT button switches on and off: mist (M7) or flood (M8). It uses the controller\'s real-time toggle, so it works while a job runs and sends nothing between its lines.',
    body: () => <Segmented<jobOptions.Coolant> label="Coolant" value={jobOptions.coolant.value} opts={[['mist', 'MIST (M7)'], ['flood', 'FLOOD (M8)']]}
      set={v => { jobOptions.coolant.value = v; log('info', 'Coolant button: ' + v); }} /> },
  { title: 'PARK', text: 'park point position bottom bar',
    desc: 'Where the bottom bar\'s PARK goes, in machine coordinates. Z goes up first, to the park height unless the tool is already higher, and never down while crossing; then over to X and Y; then to the park height. Top of travel is as high as the controller allows Z, from its homing settings.',
    body: () => <Park /> },
  { title: '3D VIEWPORT EXTENTS', text: '3d viewport extents projection grid',
    desc: 'Machine-coordinate workspace bounds. 0,0 is home (top-right); enter negative values for your working area. Updates the grid and camera position instantly.',
    body: () => <ViewExtents /> },
  { title: 'FONTS', text: 'fonts font text labels numbers barlow plex roboto mono system',
    desc: 'The fonts are part of the page, so they look the same with no internet. The text font sets the condensed labels too; the numbers font is for the position readout, offsets and tables. SYSTEM uses this device\'s own fonts.',
    body: () => <Fonts /> },
  { title: 'COLOUR THEME', text: 'colour color theme text background accent 3d',
    desc: 'Customise the primary text colour and background colour. Click the swatch to open the colour picker, or type a hex value. Reset restores the defaults.',
    body: () => <Theme /> },
  { title: 'EXCLUSION ZONE COLOURS', text: 'exclusion zone colours color',
    desc: 'Colours for exclusion zone boxes in the 3D viewport based on what the zone blocks.',
    body: () => <ZoneColors /> },
  { title: 'JOG STEP SIZES', text: 'jog step sizes speed units',
    desc: 'Configure the step size presets and maximum feed rates for XY and Z jogging. Comma-separated values in mm. Max speed caps the slider regardless of its position.',
    body: () => <JogSteps /> },
];

export function OptionsTab() {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const descText = (d: ComponentChildren) => (typeof d === 'string' ? d : '');
  const shown = CARDS.filter(c => !q || (c.title + ' ' + c.text + ' ' + descText(c.desc)).toLowerCase().includes(q));
  const cols = columns.value;
  return (
    <div class="fs-opts">
      <div class="fs-card-head">
        <span class="fs-dim">Kept in this browser, and used at once.</span>
        <div class="fs-head-end">
          <input type="search" class="fs-in" placeholder="Search options…" aria-label="Search options" value={query} onInput={e => setQuery((e.target as HTMLInputElement).value)} />
          <Pick label="Columns" value={cols} set={v => { columns.value = v; }} opts={[['1', '1 col'], ['2', '2 col'], ['3', '3 col']]} />
        </div>
      </div>
      <div class="fs-opts-grid">
        <div class="fs-opts-cols" style={{ '--opt-cols': cols }}>
          {shown.map(c => (
            <section class="fs-card fs-mcard fs-opt-card" aria-label={c.title}>
              <h2 class="fs-h">{c.title}</h2>
              <div class="fs-note">{c.desc}</div>
              {c.body()}
            </section>
          ))}
        </div>
        {!shown.length && <div class="fs-empty-sm">No option matches "{query}".</div>}
      </div>
    </div>
  );
}
