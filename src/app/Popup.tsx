// ═══════════════════════════════════════════════
// Popups — closable panels over the screen, holding the carried-over setup tools
// ═══════════════════════════════════════════════

import { Component, createRef } from 'preact';
import { useEffect } from 'preact/hooks';
import { state } from '../state';
import { initProbingTab } from '../probing/probing-tab';
import { loadOffsets } from '../offsets';
import { loadToolTable } from '../tooltable';
import { renderFlightTab } from '../flight-recorder';
import * as connection from '../stores/connection';
import * as ui from './ui';

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

interface PopupDef { title: string; ids: string[]; tall: boolean; open?: () => void; }

const POPUPS: Record<ui.Popup, PopupDef> = {
  jog: { title: 'JOG', ids: ['mod-jogging', 'mod-position'], tall: false },
  offsets: { title: 'WORK OFFSETS', ids: ['tabpanel-offsets'], tall: true, open: () => { if (connection.connected.value) loadOffsets(); } },
  probe: { title: 'PROBE', ids: ['tabpanel-probing'], tall: true, open: () => openProbing('edgefinder') },
  measure: { title: 'MEASURE THE TOOL', ids: ['tabpanel-probing'], tall: true, open: () => openProbing('toollength') },
  frame: { title: 'FRAME THE PROGRAM', ids: ['mod-limits'], tall: false },
  tools: { title: 'TOOL TABLE', ids: ['tabpanel-tooltable'], tall: true, open: () => loadToolTable() },
  recorder: { title: 'FLIGHT RECORDER SETTINGS', ids: ['tabpanel-flight'], tall: true, open: () => renderFlightTab() },
};

/** The probing panels are built on first use, as the old tab did; then the wanted sub-tab is picked. */
function openProbing(subtab: string): void {
  if (!state._probingTabInited) { state._probingTabInited = true; initProbingTab(); }
  document.querySelector<HTMLElement>(`#tabpanel-probing .prob-subtab-btn[data-subtab="${subtab}"]`)?.click();
}

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
        <Borrow class={def.tall ? 'fs-popup-tall' : 'fs-popup-cards'} ids={def.ids} />
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
