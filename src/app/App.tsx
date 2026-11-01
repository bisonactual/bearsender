// ═══════════════════════════════════════════════
// The app shell: top bar, position line, message line, screens, bottom bar
// ═══════════════════════════════════════════════

import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import * as connection from '../stores/connection';
import * as machine from '../stores/machine';
import * as job from '../stores/job';
import * as messages from '../stores/messages';
import * as flight from '../stores/flight';
import * as ui from './ui';
import { mode, moving, nextSection, awaitedSection, toolLabel } from './mode';
import { toggleConnect, rtSend, sendCmd } from '../connection';
import { startJob, pauseJob, stopJob, sendReset, sendHome, unlockAlarm, resumeToolChange } from '../streaming';
import { alarmText } from '../parser';
import { Legacy } from './Legacy';
import { JobScreen } from './JobScreen';
import { PopupHost } from './Popup';
import { startCarriedScreens } from './carried';
import { startAsks } from './asks';
import { BEAR_MARK } from './brand';
import { IconHome, IconReady, IconPlay, IconPause, IconStop, IconWrench, IconWarn, IconUnplugged } from './icons';

const num = (v: number, digits = 0) => v.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });

// ── Top bar ───────────────────────────────────────────────────────────────────

const SCREENS: [ui.Screen, string][] = [['job', 'JOB'], ['setup', 'SETUP'], ['probing', 'PROBING'], ['tools', 'TOOLS'], ['settings', 'SETTINGS']];

function linkText(): string {
  const status = connection.status.value;
  if (status === 'disconnected') return 'not connected';
  if (status === 'connecting') return 'connecting to ' + connection.address.value;
  const plugin = flight.plugin.value;
  const recorder = !plugin ? '' : !plugin.storage ? 'flight recorder: no FRAM'
    : flight.enabled.value ? 'flight recorder on' : 'flight recorder off';
  const fw = connection.firmware.value;
  return [connection.address.value, 'grblHAL' + (fw ? ' ' + fw : ''), recorder].filter(Boolean).join(' · ');
}

function TopBar() {
  const m = mode.value;
  const link = connection.status.value;
  const current = ui.screen.value;
  return (
    <header class="fs-top">
      <div class="fs-logo"><img class="fs-mark" src={BEAR_MARK} alt="" /><span><span class="fs-bear">BEAR</span>SENDER</span></div>
      <nav class="fs-nav" aria-label="Screens">
        {SCREENS.map(([id, label]) => (
          <button type="button" class={'fs-nav-btn' + (current === id ? ' is-on' : '')} aria-current={current === id ? 'page' : undefined}
            onClick={() => { ui.screen.value = id; }}>{label}</button>
        ))}
      </nav>
      <span class="fs-link">{linkText()}</span>
      <div class="fs-top-actions">
        <button type="button" class="fs-btn" disabled={link === 'connecting'} onClick={() => toggleConnect()}>
          {link === 'connected' ? 'DISCONNECT' : 'CONNECT'}
        </button>
        <button type="button" class="fs-btn" disabled={link !== 'connected'} onClick={() => sendReset()}>RESET</button>
        <button type="button" class={'fs-home' + (machine.homed.value ? ' is-homed' : '')} title={machine.homed.value ? 'Homed' : 'Not homed'}
          disabled={link !== 'connected' || m === 'running' || m === 'hold' || m === 'change'}
          onClick={() => sendHome()}><IconHome />HOME</button>
      </div>
    </header>
  );
}

// ── Position line ─────────────────────────────────────────────────────────────

interface StateView { label: string; sub: string; tone: '' | 'go' | 'stop'; icon: ComponentChildren; }

function stateView(): StateView {
  const m = mode.value;
  if (m === 'offline') return { label: 'OFFLINE', sub: 'not connected', tone: '', icon: <IconUnplugged /> };
  if (m === 'alarm') return { label: 'ALARM', sub: 'machine stopped', tone: 'stop', icon: <IconWarn /> };
  if (m === 'change') return { label: 'TOOL CHANGE', sub: 'waiting for you', tone: '', icon: <IconWrench /> };
  if (m === 'running') return { label: 'RUNNING', sub: 'no action needed', tone: 'go', icon: <IconPlay /> };
  if (m === 'hold' && machine.stateName.value === 'door') return { label: 'DOOR OPEN', sub: 'close it, then Resume', tone: '', icon: <IconPause size={22} /> };
  if (m === 'hold') return { label: 'HOLD', sub: 'paused, press Resume', tone: '', icon: <IconPause size={22} /> };
  const ready = (label: string, sub: string): StateView => ({ label, sub, tone: '', icon: <IconReady /> });
  switch (machine.stateName.value) {
    case 'idle': return ready('READY', machine.homed.value ? 'homed, idle' : 'idle, not homed');
    case 'home': return ready('HOMING', 'finding home');
    case 'jog': return ready('JOGGING', 'moving');
    case 'run': return ready('MOVING', 'running a command');
    case 'hold': return ready('HOLD', 'feed hold');
    case 'door': return ready('DOOR OPEN', 'close it to go on');
    case 'check': return ready('CHECK MODE', 'G-code is checked, not run');
    case 'sleep': return ready('SLEEP', 'reset to wake');
    default: return ready('CONNECTED', 'waiting for a status report');
  }
}

// Input pins (Pn:) shown on the position line: pin letters, label, name. E-stop lights on E (grblHAL) or R,
// and the toolsetter on T, as the old Signals panel had it.
const SIGNALS: [string, string, string][] = [
  ['X', 'X', 'X limit'], ['Y', 'Y', 'Y limit'], ['Z', 'Z', 'Z limit'], ['P', 'PROBE', 'Probe'],
  ['T', 'TLS', 'Toolsetter'], ['D', 'DOOR', 'Door'], ['ER', 'E-STOP', 'E-stop'],
];

function Signals() {
  const pins = machine.pins.value.toUpperCase();
  return (
    <div role="group" aria-label="Input signals" class="fs-sigs">
      {SIGNALS.map(([letters, label, name]) => {
        const on = [...letters].some(l => pins.includes(l));
        return <span class={'fs-sig' + (on ? ' is-on' : '')} title={name + (on ? ': active' : ': off')} aria-label={name + (on ? ', active' : ', off')}>{label}</span>;
      })}
    </div>
  );
}

// The readout takes the free space on the line and keeps its full spacing while it fits. When the signals or the
// buttons need the room, it tightens only as far as it must: its gaps first, then the size of its numbers (data-fit
// 1 to FIT_LEVELS, as in style.css). If even the tightest doesn't fit, the line breaks in two (data-wrap): the state
// and the readout, then the signals and the buttons on the right.
const FIT_LEVELS = 6;

function fitLine(line: HTMLElement): void {
  const axes = line.querySelector<HTMLElement>('.fs-axes');
  if (!axes) return;
  for (const wrap of [false, true]) {
    if (wrap) line.dataset.wrap = ''; else delete line.dataset.wrap;
    for (let level = 0; level <= FIT_LEVELS; level++) {
      line.dataset.fit = String(level);
      if (axes.scrollWidth <= axes.clientWidth + 1) return;
    }
  }
}

function PositionLine() {
  const view = stateView();
  const ref = ui.posRef.value;
  const pos = ref === 'work' ? machine.wpos.value : machine.mpos.value;
  const wcs = machine.wcs.value;
  // Set zeroes an axis in the active work offset. Only offered when the machine is idle.
  const canSet = connection.connected.value && machine.stateName.value === 'idle' && !job.running.value;
  const line = useRef<HTMLDivElement>(null);
  // Fit again when something that changes the line's widths does, and when the window changes size.
  const widths = [ui.signalsShown.value, canSet, wcs, view.label, view.sub, pos.x.toFixed(3).length, pos.y.toFixed(3).length, pos.z.toFixed(3).length].join('|');
  useLayoutEffect(() => { if (line.current) fitLine(line.current); }, [widths]);
  useEffect(() => {
    const refit = () => { if (line.current) fitLine(line.current); };
    // The shell is the window's size, so this sees every resize without seeing the line's own changes.
    const observer = new ResizeObserver(refit);
    observer.observe(line.current!.parentElement!);
    document.fonts?.ready.then(refit);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={line} class="fs-posline">
      <div class={'fs-state' + (view.tone ? ' is-' + view.tone : '')}>
        {view.icon}
        <div><div class="fs-state-label">{view.label}</div><div class="fs-state-sub">{view.sub}</div></div>
      </div>
      <div role="group" aria-label="Position" class="fs-axes">
        {(['x', 'y', 'z'] as const).map(a => (
          <div class="fs-axis">
            <span class="fs-axis-name">{a.toUpperCase()}</span><span class="fs-axis-value">{pos[a].toFixed(3)}</span>
            {canSet && <button type="button" class="fs-set" title={`Zero ${a.toUpperCase()} in ${wcs} here (G10 L20)`}
              onClick={() => sendCmd(`G10 L20 P${machine.activeP.value} ${a.toUpperCase()}0`)}>SET {wcs}</button>}
          </div>
        ))}
      </div>
      <div class="fs-posref">
        {/* The signals grow leftwards from their button. */}
        {ui.signalsShown.value && <Signals />}
        <button type="button" class={'fs-btn fs-btn-sm' + (ui.signalsShown.value ? ' is-on' : '')} aria-pressed={ui.signalsShown.value ? 'true' : 'false'}
          onClick={() => { ui.signalsShown.value = !ui.signalsShown.value; }}>SIGNALS</button>
        <button type="button" class="fs-wcs" title="Work offsets" onClick={() => { ui.popup.value = 'offsets'; }}>{wcs}</button>
        {/* TO GO needs the end point of the executing line. The old parser can't give it reliably
            (no G91, G20 or G53), so it waits for step 2's interpreter. */}
        <div role="group" aria-label="Position reference" class="fs-seg">
          {([['work', 'WORK'], ['machine', 'MACHINE']] as const).map(([id, label]) => (
            <button type="button" aria-pressed={ref === id ? 'true' : 'false'} class={ref === id ? 'is-on' : ''}
              onClick={() => { ui.posRef.value = id; }}>{label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Message line ──────────────────────────────────────────────────────────────

function MessagesButton() {
  return (
    <button type="button" class="fs-btn fs-btn-msg" onClick={() => { ui.popup.value = 'messages'; }}>
      MESSAGES ({messages.list.value.length})
    </button>
  );
}

/** What to press for each alarm: the words, and whether HOME is the first thing to offer. */
function alarmAction(code: number | null): { words: string; home: boolean } {
  if (code === 11) return { words: 'Press HOME.', home: true };
  if (code === 80) return { words: 'Check the tool, then UNLOCK; the Recorder panel can resume the job.', home: false };
  if (code === 81) return { words: 'Check the machine, then UNLOCK.', home: false };
  if (code === 1 || code === 3 || code === 10) return { words: 'Clear the cause, UNLOCK, then HOME.', home: false };
  if (code === 2) return { words: 'Press UNLOCK; the position is kept.', home: false };
  if (code === 4 || code === 5 || code === 13) return { words: 'Check the probe, then UNLOCK.', home: false };
  if (code !== null && [6, 7, 8, 9, 15, 17].includes(code)) return { words: 'Check the switches, then HOME again.', home: true };
  if (code === 12) return { words: 'Clear the limit switch, then UNLOCK.', home: false };
  if (code === 16) return { words: 'Check the drives, then UNLOCK.', home: false };
  if (code === null) return { words: 'The controller hasn\'t said why. UNLOCK, or HOME if it needs homing.', home: false };
  return { words: 'Check the machine, then UNLOCK.', home: false };
}

/** Homing is on in $22, or $22 isn't known yet. */
function homingOn(): boolean {
  const v = parseInt(machine.settings.value[22] ?? '');
  return isNaN(v) || (v & 1) === 1;
}

function MessageLine() {
  const m = mode.value;
  const file = job.file.value;
  const halt = job.halt.value;
  // The one next thing to do: connect, clear the alarm, home, load a program, then the job's own next step.
  if (m === 'alarm') {
    // After a lost link the ALARM: line came while FlexiSender was away; the flight record keeps the code.
    const record = flight.record.value;
    const code = machine.alarm.value ?? (job.result.value === 'link lost' && record?.alarm ? record.alarm : null);
    const text = code !== null ? alarmText(String(code)) : 'ALARM';
    const detail = text.includes(': ') ? text.slice(text.indexOf(': ') + 2) : 'The controller is in alarm.';
    const action = alarmAction(code);
    return (
      <div role="alert" class="fs-msgline is-alarm">
        <span class="fs-msg-tag"><IconWarn size={18} />{code !== null ? 'ALARM ' + code : 'ALARM'}</span>
        <span class="fs-msg-text">{detail} {action.words}</span>
        {action.home && <button type="button" class="fs-btn fs-btn-alarm" onClick={() => sendHome()}>HOME</button>}
        <button type="button" class="fs-btn fs-btn-alarm" onClick={() => unlockAlarm()}>UNLOCK</button>
      </div>
    );
  }
  if (m === 'ready' && machine.stateName.value === 'idle' && !machine.homed.value && homingOn()) {
    return (
      <div role="status" class="fs-msgline is-todo">
        <span class="fs-msg-tag"><IconWarn size={18} />NOT HOMED</span>
        <span class="fs-msg-text">The machine hasn't been homed since it started. Press <strong>HOME</strong>.</span>
        <button type="button" class="fs-btn" onClick={() => sendHome()}>HOME</button>
        <MessagesButton />
      </div>
    );
  }
  if (m === 'change') {
    const section = awaitedSection.value;
    const z = machine.mpos.value.z;
    return (
      <div role="alert" class="fs-msgline is-action">
        <span class="fs-msg-tag">ACTION NEEDED</span>
        <span class="fs-msg-text">
          Load <strong>{section ? toolLabel(section.tool) : 'the next tool'}</strong>, measure it, then press Resume.{' '}
          Spindle {machine.spindle.value > 0 ? 'at ' + num(machine.spindle.value) + ' rpm' : 'stopped'}, tool at machine Z {z.toFixed(3)}.
        </span>
      </div>
    );
  }
  let text: ComponentChildren;
  if (m === 'offline') text = <>Not connected. Press <strong>CONNECT</strong>; the controller's address is in Settings, Options.</>;
  else if (m === 'running') {
    const next = nextSection.value;
    text = next
      ? <>Next action: change to <strong>{toolLabel(next.tool)}</strong> at line {num(next.changeLine)}.</>
      : <>No action needed until the job ends.</>;
  } else if (m === 'hold' && halt) {
    text = <><strong>{halt.why}.</strong> Nothing more was sent and the machine is held. <strong>Resume</strong> finishes the lines it accepted before that one; <strong>Stop</strong> ends the job here.</>;
  } else if (m === 'hold' && machine.stateName.value === 'door') text = <>The door is open. Close it, then press <strong>Resume</strong>; or Stop to end it.</>;
  else if (m === 'hold') text = <>Feed hold. Press <strong>Resume</strong> to carry on, or Stop to end the job.</>;
  else if (job.stopping.value) text = <>Stopping: the reset goes once the machine has stopped.</>;
  else if (job.notice.value) text = <>{job.notice.value}</>;
  else if (!file) text = <>No job loaded. Press <strong>Load Job</strong> to open a G-code file.</>;
  else if (job.result.value === 'completed') text = <><strong>{file}</strong> completed in {job.fmtDuration(job.elapsedMs.value)}.</>;
  else if (job.result.value === 'error' && halt) {
    text = <><strong>{file}</strong> halted after {job.fmtDuration(job.elapsedMs.value)}. {halt.why}. Fix the program, then press Start to run it again from the top.</>;
  } else if (job.result.value) {
    const how: Record<string, string> = { stopped: 'was stopped', error: 'halted on an error', alarm: 'was stopped by an alarm', 'link lost': 'stopped when the connection was lost' };
    const at = job.executingLine.value;
    text = <><strong>{file}</strong> {how[job.result.value]}{at ? ' at line ' + num(at) : ''}, after {job.fmtDuration(job.elapsedMs.value)}. The record is in the Recorder panel; press Start to run it again from the top.</>;
  }
  else text = <>Ready to start <strong>{file}</strong>. Work through the setup list, then press Start.</>;
  return (
    <div role="status" class="fs-msgline">
      <span class="fs-msg-text">{text}</span>
      <MessagesButton />
    </div>
  );
}

// ── Bottom bar ────────────────────────────────────────────────────────────────

function Override({ label, value, unit, pct, down, up, name }: { label: string; value: number; unit: string; pct: number; down: string; up: string; name: string }) {
  const off = !connection.connected.value;
  return (
    <div class="fs-ovr">
      <div class="fs-ovr-read">
        <div class="fs-cap">{label}</div>
        <div><span class="fs-ovr-value">{num(value)}</span> <span class="fs-unit">{unit}</span></div>
      </div>
      <button type="button" class="fs-step" disabled={off} aria-label={name + ' override down 10%'} onClick={() => rtSend(down)}>−</button>
      <span class="fs-ovr-pct">{pct}%</span>
      <button type="button" class="fs-step" disabled={off} aria-label={name + ' override up 10%'} onClick={() => rtSend(up)}>+</button>
    </div>
  );
}

// Real-time override bytes: feed ±10% 0x91/0x92, spindle ±10% 0x9A/0x9B, rapid 100/50/25% 0x95/0x96/0x97.
const NEXT_RAPID: Record<number, string> = { 100: '\x96', 50: '\x97', 25: '\x95' };

function BottomBar() {
  const m = mode.value;
  const ov = machine.overrides.value;
  const linked = connection.connected.value;
  const resume = m === 'hold' || m === 'change';
  const canStart = linked && (resume || (m === 'ready' && !!job.file.value && !job.running.value && machine.stateName.value === 'idle'));
  const start = () => {
    // At a tool change the cycle start goes once every reply is in (command.ts). At a hold BearSender
    // didn't ask for (a door, the console, an error), the controller waits for the cycle start.
    if (m === 'change') resumeToolChange();
    else if (m === 'hold' && !job.paused.value) rtSend('~');
    else startJob();
  };
  // Hold and Stop follow the machine, not the stream: the last ok can come long before the last move ends.
  const canHold = linked && (m === 'running' || ['run', 'jog'].includes(machine.stateName.value));
  const canStop = linked && !job.stopping.value && (job.running.value || moving.value);
  return (
    <footer class="fs-bottom">
      <div class="fs-row-gap">
        <button type="button" class="fs-btn fs-btn-tall" onClick={() => { ui.popup.value = 'jog'; }}>JOG</button>
        <button type="button" class="fs-btn fs-btn-tall" onClick={() => { ui.popup.value = 'offsets'; }}>OFFSETS</button>
      </div>
      <Override label="FEED" name="Feed" value={machine.feed.value} unit="mm/min" pct={ov.feed} down={'\x92'} up={'\x91'} />
      <Override label="SPINDLE" name="Spindle" value={machine.spindle.value} unit="rpm" pct={ov.spindle} down={'\x9B'} up={'\x9A'} />
      <div class="fs-ovr">
        <div class="fs-cap">RAPID</div>
        <button type="button" class="fs-btn fs-rapid" disabled={!linked} aria-label={'Rapid override, now ' + ov.rapid + '%. Press to change'}
          onClick={() => rtSend(NEXT_RAPID[ov.rapid] ?? '\x95')}>{ov.rapid}%</button>
      </div>
      <span class="fs-grow" />
      <div class="fs-run">
        <button type="button" class="fs-run-btn is-start" disabled={!canStart} onClick={start}><IconPlay size={18} />{resume ? 'RESUME' : 'START'}</button>
        <button type="button" class="fs-run-btn is-hold" disabled={!canHold} onClick={() => pauseJob()}><IconPause />HOLD</button>
        <button type="button" class="fs-run-btn is-stop" disabled={!canStop} onClick={() => stopJob()}><IconStop />STOP</button>
      </div>
    </footer>
  );
}

// ── Screens ───────────────────────────────────────────────────────────────────

function SubTabs<T extends string>({ tabs, value }: { tabs: [T, string][]; value: Signal<T> }) {
  return (
    <div role="tablist" class="fs-subtabs">
      {tabs.map(([id, label]) => (
        <button type="button" role="tab" aria-selected={value.value === id ? 'true' : 'false'} class={value.value === id ? 'is-on' : ''}
          onClick={() => { value.value = id; }}>{label}</button>
      ))}
    </div>
  );
}

// Camera, Console and Macros are tabs of the job screen's right panel.
const SETUP_TABS: [ui.SetupTab, string][] = [['machine', 'MACHINE'], ['offsets', 'OFFSETS']];
const SETTINGS_TABS: [ui.SettingsTab, string][] = [['grbl', 'GRBL SETTINGS'], ['zones', 'EXCLUSION ZONES'], ['options', 'OPTIONS'], ['flight', 'FLIGHT RECORDER']];

function SetupScreen() {
  const tab = ui.setupTab.value;
  return (
    <section class="fs-screen" hidden={ui.screen.value !== 'setup'}>
      <SubTabs tabs={SETUP_TABS} value={ui.setupTab} />
      <div class="fs-sub fs-sub-scroll" hidden={tab !== 'machine'}>
        <Legacy class="fs-cards" ids={['mod-position', 'mod-jogging', 'mod-spindle', 'mod-overrides', 'mod-limits', 'mod-surfacing', 'mod-sdcard']} />
      </div>
      <div class="fs-sub" hidden={tab !== 'offsets'}><Legacy class="fs-legacy" ids={['tabpanel-offsets']} /></div>
    </section>
  );
}

function SettingsScreen() {
  const tab = ui.settingsTab.value;
  return (
    <section class="fs-screen" hidden={ui.screen.value !== 'settings'}>
      <SubTabs tabs={SETTINGS_TABS} value={ui.settingsTab} />
      <div class="fs-sub" hidden={tab !== 'grbl'}><Legacy class="fs-legacy" ids={['tabpanel-settings']} /></div>
      <div class="fs-sub" hidden={tab !== 'zones'}><Legacy class="fs-legacy" ids={['tabpanel-exclusions']} /></div>
      <div class="fs-sub" hidden={tab !== 'options'}><Legacy class="fs-legacy" ids={['tabpanel-options']} /></div>
      <div class="fs-sub" hidden={tab !== 'flight'}><Legacy class="fs-legacy" ids={['tabpanel-flight']} /></div>
    </section>
  );
}

export function App() {
  const s = ui.screen.value;
  // After the first render, so the carried-over panels are in their screens.
  useEffect(() => { startCarriedScreens(); startAsks(); }, []);
  return (
    <div class="fs-shell">
      <TopBar />
      <PositionLine />
      <MessageLine />
      <JobScreen hidden={s !== 'job'} />
      <SetupScreen />
      <section class="fs-screen" hidden={s !== 'probing'}><Legacy class="fs-legacy" ids={['tabpanel-probing']} /></section>
      <section class="fs-screen" hidden={s !== 'tools'}><Legacy class="fs-legacy" ids={['tabpanel-tooltable']} /></section>
      <SettingsScreen />
      <BottomBar />
      <PopupHost />
    </div>
  );
}
