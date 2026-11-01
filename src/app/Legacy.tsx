// ═══════════════════════════════════════════════
// Legacy — mounts carried-over DOM panels inside the shell
// ═══════════════════════════════════════════════
//
// The old panels are built once into #legacy (index.html and the old mount() calls). This moves
// the named elements into its own div and never renders again, so Preact leaves them alone.

import { Component, createRef } from 'preact';

interface Props { ids: string[]; class?: string; }

export class Legacy extends Component<Props> {
  private box = createRef<HTMLDivElement>();

  shouldComponentUpdate(): boolean { return false; }

  componentDidMount(): void {
    for (const id of this.props.ids) {
      const el = document.getElementById(id);
      if (!el) { console.warn('Legacy: no #' + id); continue; }
      el.classList.remove('mod-hidden');
      el.classList.add('active');
      // Floating cards carried their spot on the old RUN page.
      el.style.removeProperty('top');
      el.style.removeProperty('left');
      this.box.current!.appendChild(el);
    }
  }

  render() {
    return <div ref={this.box} class={this.props.class} />;
  }
}
