// ═══════════════════════════════════════════════
// Popups — closable panels over the screen, holding the carried-over setup tools
// ═══════════════════════════════════════════════

import { Component, createRef } from 'preact';
import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { renderFlightTab } from '../flight-recorder';
import * as messages from '../stores/messages';
import * as ui from './ui';
import { JogCard, PositionCard, LimitsCard, OffsetsTable } from './SetupScreen';
import { ProbingPopupBody } from './ProbingScreen';
import { ToolTable } from './ToolsScreen';

/** Lends carried-over panels to a popup, and puts each back where it came from on close. */
class Borrow extends Component<{ ids: string[]; class?: string }> {
  private box = createRef<HTMLDivElement>();
  private homes: [HTMLElement, Node, Node | null][] = [];

  shouldComponentUpdate(): boolean { return false; }

  componentDidMount(): void {
    for (const id of this.props.ids) {
      const el = document.getElementById(id);
      if (!el || !el.parentNode) continue;
      this.homes.push([el, el.parentNode, el.nextSibling]);
      el.classList.remove('mod-hidden');
      el.classList.add('active');
      this.box.current!.appendChild(el);
    }
  }

  componentWillUnmount(): void {
    for (const [el, parent, next] of this.homes.reverse()) parent.insertBefore(el, next);
    this.homes = [];
  }

  render() {
    return <div ref={this.box} class={this.props.class} />;
  }
}

/** A popup lends carried-over panels (ids), or shows a body of its own. */
interface PopupDef { title: string; ids?: string[]; body?: () => ComponentChildren; tall: boolean; open?: () => void; }

const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function MessagesList() {
  const list = messages.list.value;
  return (
    <div class="fs-popup-list">
      {list.length ? list.map(m => (
        <div class="fs-message">
          <span class="fs-message-time fs-mono">{clock(m.at)}</span>
          <span class={'fs-message-text' + (m.kind === 'alarm' || m.kind === 'error' ? ' is-warn' : '')}>{m.text}</span>
        </div>
      )) : <div class="fs-event-empty">No messages yet.</div>}
      <div class="fs-note-sm">Controller messages, alarms, errors and job events, newest first. The raw console is the Console tab on the job screen.</div>
    </div>
  );
}

const POPUPS: Record<ui.Popup, PopupDef> = {
  jog: { title: 'JOG', body: () => <div class="fs-popup-cards"><JogCard /><PositionCard /></div>, tall: false },
  offsets: { title: 'WORK OFFSETS', body: () => <div class="fs-popup-body"><OffsetsTable /></div>, tall: true },
  probe: { title: 'PROBE', body: () => <ProbingPopupBody />, tall: true, open: () => { ui.probingTab.value = 'ef'; } },
  measure: { title: 'MEASURE THE TOOL', body: () => <ProbingPopupBody />, tall: true, open: () => { ui.probingTab.value = 'tl'; } },
  frame: { title: 'FRAME THE PROGRAM', body: () => <div class="fs-popup-cards"><LimitsCard /></div>, tall: false },
  tools: { title: 'TOOL TABLE', body: () => <div class="fs-popup-body"><ToolTable /></div>, tall: true },
  recorder: { title: 'FLIGHT RECORDER SETTINGS', ids: ['tabpanel-flight'], tall: true, open: () => renderFlightTab() },
  messages: { title: 'MESSAGES', body: () => <MessagesList />, tall: false },
};

function PopupPanel({ id }: { id: ui.Popup }) {
  const def = POPUPS[id];
  useEffect(() => { def.open?.(); }, []);
  return (
    <div class="fs-popup-back" onClick={e => { if (e.target === e.currentTarget) ui.popup.value = null; }}>
      <section role="dialog" aria-label={def.title} class={'fs-popup' + (def.tall ? ' is-tall' : '')}>
        <div class="fs-popup-head">
          <h2 class="fs-h">{def.title}</h2>
          <button type="button" class="fs-btn fs-btn-sm" onClick={() => { ui.popup.value = null; }}>CLOSE</button>
        </div>
        {def.ids ? <Borrow class={def.tall ? 'fs-popup-tall' : 'fs-popup-cards'} ids={def.ids} /> : def.body!()}
      </section>
    </div>
  );
}

export function PopupHost() {
  const id = ui.popup.value;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') ui.popup.value = null; };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return id ? <PopupPanel key={id} id={id} /> : null;
}
