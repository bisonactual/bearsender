// ═══════════════════════════════════════════════
// Push messages & status reports
// ═══════════════════════════════════════════════
//
// What the controller sends unasked, from the command layer's subscriptions, and what any
// matched reply tells the stores. Replies to a command are read by whoever sent it.

import { state } from './state';
import { log } from './console';
import { _updateHomeBtnHomed, rtSend } from './connection';
import { endRunOnAlarm } from './streaming';
import { reportMm } from './units';
import { toolGroup } from './viewport';
import { ezParseStatus } from './exclusion-zones';
import { emit, type StatusReport } from './bus';
import { loadOffsets, offsetsUnread } from './offsets';
import * as command from './command';
import { batch } from '@preact/signals';
import * as machine from './stores/machine';
import * as job from './stores/job';
import * as messages from './stores/messages';

export function initParser(): void {
  command.on('status', line => batch(() => parseStatusReport(line.slice(1, -1))));
  command.on('alarm', onAlarm);
  command.on('msg', line => {
    log('info', line);
    if (line.length > 6) messages.push('msg', line.slice(5, -1));
  });
  command.on('banner', line => log('info', line));
  command.on('startup', line => log('info', line));
  command.on('gc', line => { log('info', line); machine.modal.value = line.slice(4, -1).trim().split(/\s+/); });
  command.onReply((reply, { job, quiet }) => {
    if (reply.result === 'error') { if (!quiet) messages.push('error', `error:${reply.code} on "${reply.command}"`); }
    else if (!job) { noteOffsetWrite(reply.command); noteModeChange(reply.command); noteStartupLines(reply); }
  });
}

/** $N lists the startup lines ($N0=…, $N1=…), which grblHAL runs after a reset and after homing: kept for
 *  the reading of $H (stores/program.ts). Writing one reads them again. */
function noteStartupLines(reply: command.Reply): void {
  const c = reply.command.toUpperCase().replace(/\s+/g, '');
  if (c === '$N') {
    machine.startupLines.value = reply.lines.map(l => l.match(/^\$N\d+=(.*)$/)?.[1]?.trim() ?? '').filter(Boolean);
  } else if (/^\$N\d+=/.test(c) && !state.running) command.send('$N', { quiet: true }).catch(e => { if (!(e instanceof command.CommandFailed)) throw e; });
}

// The modes the next job starts from ($G), for the program's reading (stores/program.ts). grblHAL
// pushes [GC:] only with $10's parser-state bit set (off by default), so they are asked for: on
// connecting (asks.ts), when a file is loaded, after a command that can change them, when the
// machine comes to rest, after a reset (offsets.ts) and at Start (streaming.ts).
const MODAL = /G0*(?:[0-3]|17|18|19|20|21|38\.\d|43|49|5[4-9](?:\.\d)?|80|90|91|93|94)(?![\d.])|M0*(?:2|30)(?![\d.])/;
let modesTimer: ReturnType<typeof setTimeout> | null = null;

/** Reads $G in a moment, once for a burst of asks; not while a job runs. */
export function readModesSoon(): void {
  if (modesTimer) clearTimeout(modesTimer);
  modesTimer = setTimeout(() => {
    modesTimer = null;
    if (state.connected && !state.running) command.send('$G', { quiet: true }).catch(e => { if (!(e instanceof command.CommandFailed)) throw e; });
  }, 300);
}

function noteModeChange(command: string): void {
  if (!state.running && !command.startsWith('$') && MODAL.test(command.toUpperCase().replace(/\s+/g, ''))) readModesSoon();
}

function onAlarm(raw: string): void {
  log('alarm', raw);
  const code = parseInt(raw.slice(6));
  batch(() => {
    machine.alarm.value = isNaN(code) ? null : code;
    machine.state.value = 'Alarm';
  });
  messages.push('alarm', alarmText(raw.slice(6)));
  setMachineState('ALARM');
  emit<StatusReport>('status', new Set(['state']), { machineState: 'ALARM' });
  endRunOnAlarm();
  // The full report says whether the machine is still homed; the next plain one would look unchanged.
  rtSend('\x87');
}

function parseStatusReport(s: string): void {
  const parts = s.split('|');
  const report: StatusReport = { machineState: parts[0] };
  const tags = new Set<string>(['state']);

  setMachineState(parts[0]);
  // A full report (0x87) on each change of state: it carries the alarm code, H (homed), T (tool) and WCO,
  // which the plain report leaves out.
  if (parts[0].split(':')[0].toLowerCase() !== machine.stateName.value) rtSend('\x87');
  machine.state.value = parts[0];
  if (!parts[0].startsWith('Alarm')) machine.alarm.value = null;
  else if (parts[0].includes(':')) machine.alarm.value = parseInt(parts[0].split(':')[1]) || machine.alarm.value;
  let hasPn = false;
  // Positions in mm whatever $13 says. The report gives MPos, or WPos with WCO now or earlier.
  const vec = (vals: string[]): machine.Vec3 => ({ x: reportMm(parseFloat(vals[0]) || 0), y: reportMm(parseFloat(vals[1]) || 0), z: reportMm(parseFloat(vals[2]) || 0) });
  // The axes after Z: A, B and C in degrees as reported, U, V and W in mm like X, Y and Z.
  const letters = machine.axes.peek();
  const rest = (vals: string[]): number[] => vals.slice(3).map((v, i) => {
    const n = parseFloat(v) || 0;
    return 'UVW'.includes(letters[3 + i] ?? '') ? reportMm(n) : n;
  });
  let mpos: machine.Vec3 | null = null;
  let wpos: machine.Vec3 | null = null;
  let mposExtra: number[] | null = null;
  let wposExtra: number[] | null = null;
  // A: comes with the overrides (Ov:), and only while something is on.
  let accessories: string | null = null;
  for (let i = 1; i < parts.length; i++) {
    const colon = parts[i].indexOf(':');
    if (colon === -1) continue;
    const key = parts[i].slice(0, colon);
    const vals = parts[i].slice(colon + 1).split(',');
    if (key === 'WPos') { wpos = vec(vals); wposExtra = rest(vals); }
    if (key === 'MPos') { mpos = vec(vals); mposExtra = rest(vals); }
    if (key === 'WCO') { machine.wco.value = vec(vals); machine.wcoExtra.value = rest(vals); }
    if (key === 'H') machine.homed.value = vals[0] === '1';
    if (key === 'FS' || key === 'F') {
      report.fs = { feed: vals[0] || '0', spindle: vals[1] || '0' };
      tags.add('fs');
      machine.feed.value = reportMm(parseFloat(vals[0]) || 0);
      machine.spindle.value = parseFloat(vals[1]) || 0;
    }
    if (key === 'T') {
      const tn = parseInt(vals[0]);
      if (!isNaN(tn)) {
        report.tool = tn;
        tags.add('tool');
        machine.tool.value = tn;
      }
    }
    if (key === 'Ln') {
      const ln = parseInt(vals[0]);
      report.ln = ln;
      tags.add('ln');
      // The Preview follows it (src/app/Preview.tsx).
      job.reportedLine.value = ln;
    }
    if (key === 'Bf') {
      report.bf = { blocks: vals[0], bytes: vals[1] };
      tags.add('bf');
      machine.buffer.value = { blocks: parseInt(vals[0]) || 0, bytes: parseInt(vals[1]) || 0 };
    }
    if (key === 'A') accessories = vals[0] ?? '';
    if (key === 'Ov') {
      const feed = parseInt(vals[0]), rapid = parseInt(vals[1]), spin = parseInt(vals[2]);
      if (!isNaN(feed) && !isNaN(rapid) && !isNaN(spin)) {
        report.ov = { feed, rapid, spindle: spin };
        tags.add('ov');
        machine.overrides.value = { feed, rapid, spindle: spin };
      }
    }
    if (key === 'Ct') {
      const ct = parseInt(vals[0]);
      if (!isNaN(ct)) {
        report.tool = ct;
        tags.add('tool');
        machine.tool.value = ct;
      }
    }
    if (key === 'WCS') {
      const wcs = vals[0] && vals[0].toUpperCase();
      report.wcs = wcs;
      tags.add('wcs');
      if (wcs) machine.wcs.value = wcs;
    }
    if (key === 'Pn') {
      hasPn = true;
      report.pins = vals[0] || '';
      tags.add('pins');
    }
    if (key === 'EZ') {
      report.bear = vals[0] || '';
      tags.add('bear');
      ezParseStatus(report.bear);
    }
  }
  if (!hasPn) { report.pins = ''; tags.add('pins'); }
  if (accessories !== null) machine.accessories.value = accessories;
  else if (tags.has('ov')) machine.accessories.value = '';
  machine.pins.value = report.pins ?? '';
  // A report in WPos: the machine position is the work position plus the offset in force (WCO, which
  // has G92 and the tool length offset in it). Until a WCO has come it isn't known: ask for one.
  if (wpos && !mpos) {
    const o = machine.wco.value;
    if (o) {
      mpos = { x: wpos.x + o.x, y: wpos.y + o.y, z: wpos.z + o.z };
      const ox = machine.wcoExtra.value ?? [];
      mposExtra = (wposExtra ?? []).map((v, i) => v + (ox[i] ?? 0));
    }
    else rtSend('\x87');
  }
  // The store, the old state fields and the bus all get the machine position, never the work one.
  if (mpos) {
    machine.mpos.value = mpos;
    if (mposExtra) machine.mposExtra.value = mposExtra;
    state.machineX = mpos.x; state.machineY = mpos.y; state.machineZ = mpos.z;
    report.mpos = { ...mpos };
    tags.add('mpos');
    toolGroup.position.set(mpos.x, mpos.z, -mpos.y);
  }

  emit('status', tags, report);
}

export function setMachineState(s: string): void {
  const sl = s.toLowerCase().split(':')[0];
  // An alarm: not homed until the controller's H: says otherwise (the full report asked for on ALARM:).
  if (sl === 'alarm' && state._prevMachineStateSl !== 'alarm') { state.machineHomed = false; machine.homed.value = false; _updateHomeBtnHomed(); }
  if (sl === 'idle' && state._prevMachineStateSl === 'home') { state.machineHomed = true; _updateHomeBtnHomed(); }
  // $# can be refused in the power-up alarm, so the offsets read on connect may not have come: read them
  // once the machine is idle (homed or unlocked), and so after a reset. The sim refused the first $
  // command after homing (error:71) and took the next, so a refusal gets one more try.
  if (sl === 'idle' && state._prevMachineStateSl !== 'idle' && offsetsUnread() && state.connected) {
    loadOffsets().then(ok => { if (!ok) setTimeout(() => { if (state.connected && offsetsUnread()) loadOffsets(); }, 1000); });
  }
  // At rest after moving, an alarm or homing: what the next job starts from may have changed.
  if (sl === 'idle' && state._prevMachineStateSl && state._prevMachineStateSl !== 'idle' && state.connected && !state.running) readModesSoon();
  state._prevMachineStateSl = sl;
}

const WCS_BY_P: Record<number, string> = { 1: 'G54', 2: 'G55', 3: 'G56', 4: 'G57', 5: 'G58', 6: 'G59', 7: 'G59.1', 8: 'G59.2', 9: 'G59.3' };

/** After a command that writes a work offset or the tool length: read $# again, and ask for WCO. */
function noteOffsetWrite(command: string): void {
  if (state.running) return;
  const c = command.toUpperCase().replace(/\s+/g, '');
  const g10 = c.match(/G0*10L0*(20|2)(?!\d)(?:P0*(\d+))?/);
  const g92 = /G92(?![.\d])/.test(c);
  if (!g10 && !g92 && !/G43\.1|G49(?!\d)|G28\.1|G30\.1/.test(c)) {
    // A new active work offset: the full report carries WCS.
    if (/G5[4-9](?:\.[1-3])?(?!\d)/.test(c)) rtSend('\x87');
    return;
  }
  if (g10 || g92) {
    const wcs = (g10 && g10[2] && WCS_BY_P[parseInt(g10[2])]) || machine.wcs.value;
    machine.offsetWrites.value = { ...machine.offsetWrites.value, [wcs]: g10 && g10[1] === '20' ? 'zeroed' : 'probed' };
  }
  loadOffsets();
  rtSend('\x87');
}

// grblHAL alarm codes, and the Flight Recorder plugin's own (80, 81).
const ALARMS: Record<number, string> = {
  1: 'Hard limit triggered. Position may be lost; home again.',
  2: 'Soft limit: the move was outside the machine travel.',
  3: 'Reset while moving. Position may be lost; home again.',
  4: 'Probe fail: the probe was already triggered before the cycle.',
  5: 'Probe fail: the probe did not make contact.',
  6: 'Homing failed: reset during the cycle.',
  7: 'Homing failed: the door opened.',
  8: 'Homing failed: the pull-off did not clear the switch.',
  9: 'Homing failed: no switch found.',
  10: 'Emergency stop.',
  11: 'Homing required.',
  12: 'A limit switch is engaged.',
  13: 'Probe protection triggered.',
  14: 'Spindle did not reach speed.',
  15: 'Homing failed: could not square the axis.',
  16: 'Motor fault.',
  17: 'Homing failed: the axis is not set up for it.',
  80: 'Connection lost mid-job. Tool retracted and spindle stopped.',
  81: 'Connection lost mid-job and the retract could not finish. The machine stopped where it was.',
};

export function alarmText(code: string): string {
  const n = parseInt(code);
  return 'ALARM ' + code + (ALARMS[n] ? ': ' + ALARMS[n] : '');
}
