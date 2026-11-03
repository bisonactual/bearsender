// Settings barrel — re-exports so other modules can import from './settings'
export { loadSettings, forgetSettings, groups, defs, reading, readNote, loaded } from './settings-load';
export type { SettingDef, SettingGroup } from './settings-load';
export { markDirty, writeSetting, writeAllDirty, readSetting, dirty, writes } from './settings-write';
