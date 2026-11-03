// The controller's $ settings: reading them (settings-load.ts) and writing them (settings-write.ts).
export { loadSettings, forgetSettings, groups, defs, isReading, readNote, loaded } from './settings-load';
export type { SettingDef, SettingGroup } from './settings-load';
export { markDirty, writeSetting, writeAllDirty, readSetting, dirty, writes } from './settings-write';
