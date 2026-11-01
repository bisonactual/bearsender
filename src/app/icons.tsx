// ═══════════════════════════════════════════════
// Icons, as drawn in the job screen mockup
// ═══════════════════════════════════════════════

const line = { fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

export function IconHome() {
  return <svg width="16" height="16" viewBox="0 0 24 24" {...line} stroke-width="2.2" aria-hidden="true"><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></svg>;
}

export function IconReady() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" fill="currentColor" /></svg>;
}

export function IconPlay({ size = 22 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5l12 7-12 7z" /></svg>;
}

export function IconPause({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>;
}

export function IconStop() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>;
}

export function IconWrench() {
  return <svg width="22" height="22" viewBox="0 0 24 24" {...line} stroke-width="2" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" /></svg>;
}

export function IconWarn({ size = 22 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" {...line} stroke-width={size < 16 ? 2.5 : 2} aria-hidden="true"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>;
}

export function IconUnplugged() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3" aria-hidden="true"><circle cx="12" cy="12" r="8" /></svg>;
}

export function IconChevron({ open }: { open: boolean }) {
  return <svg width="13" height="13" viewBox="0 0 24 24" {...line} stroke-width="2.5" aria-hidden="true">{open ? <path d="M6 9l6 6 6-6" /> : <path d="M9 6l6 6-6 6" />}</svg>;
}

export function IconBell({ on }: { on: boolean }) {
  return <svg width="15" height="15" viewBox="0 0 24 24" {...line} stroke-width="2" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />{!on && <path d="M3 3l18 18" />}</svg>;
}

export function IconCheck() {
  return <svg width="15" height="15" viewBox="0 0 24 24" {...line} stroke-width="3" aria-label="done"><path d="M5 12l5 5L20 7" /></svg>;
}

export function IconTodo() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-label="to do"><circle cx="12" cy="12" r="8" /></svg>;
}

export function IconUnknown() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="2.5 3" aria-label="not checked yet"><circle cx="12" cy="12" r="8" /></svg>;
}
