// ═══════════════════════════════════════════════
// grblHAL error codes, for saying why a line was refused
// ═══════════════════════════════════════════════
//
// From grblHAL's errors.c, shortened. Codes not here are shown by number only.

const ERRORS: Record<number, string> = {
  1: 'a G-code word has no letter',
  2: 'a number is missing or badly written',
  3: 'the $ command is not recognised',
  4: 'a value that must be positive is negative',
  5: 'homing is not set up',
  8: 'that $ command needs the controller idle',
  9: 'G-code is locked out during an alarm or a jog',
  11: 'the line is too long for the controller',
  13: 'the safety door is open',
  15: 'the jog goes outside the machine travel',
  16: 'the jog command is not valid',
  20: 'unsupported or invalid G-code command',
  21: 'two commands from the same modal group',
  22: 'no feed rate set',
  23: 'the command needs a whole number',
  24: 'two commands that both need axis words',
  25: 'a word is repeated',
  26: 'no axis words for a command that needs them',
  27: 'the line number is not valid',
  28: 'a required value word is missing',
  29: 'that work offset is not supported',
  30: 'G53 only works with G0 and G1',
  31: 'axis words with no command to use them',
  32: 'an arc has no axis words in its plane',
  33: 'the move target is not valid',
  34: 'the arc radius is not valid',
  35: 'an arc has no offset words in its plane',
  36: 'unused words in the line',
  37: 'G43.1 is not on the tool length axis',
  38: 'the tool number is not valid',
  39: 'a value is out of range',
  40: 'not allowed while a tool change is pending (only jogging is)',
  41: 'the spindle is not running',
  43: 'the feed rate is over the maximum',
  44: 'the spindle speed is out of range',
  45: 'a limit switch is engaged; only homing is allowed',
  46: 'the machine must be homed first',
  47: 'the current tool is not set (M61)',
  50: 'emergency stop is active',
  61: 'a file could not be read',
  71: 'unknown operation in an expression',
};

export function errorText(code: number): string {
  return ERRORS[code] ?? '';
}
